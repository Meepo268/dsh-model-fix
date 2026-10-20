// stamp.ts 纯函数测试：参数指纹（序列化/解析/逐字段归属判定/合并），以及 fix 的「手改不被自动来源覆盖」口径
import { fieldStampsOf, isPluginWritten, parseStamps, serializeStamps, withStamps } from '@/stamp'
import { planFill } from '@/fix'
import { DEFAULT_CONFIG } from '@/shared/config-schema'
import type { PluginConfig } from '@/shared/types'
import type { IndexedCatalog, IndexEntry } from '@/types'
import { check, stable } from '@test/helper'

/** 默认配置，按需覆盖 */
function cfg(overrides: Partial<PluginConfig> = {}): PluginConfig {
    return {
        allowUpdate: { ...DEFAULT_CONFIG.allowUpdate, ...overrides.allowUpdate },
        autoFill: { ...DEFAULT_CONFIG.autoFill, ...overrides.autoFill },
        compat: { ...DEFAULT_CONFIG.compat, ...overrides.compat },
        excludes: overrides.excludes ?? [],
        efforts: overrides.efforts ?? {},
        written: overrides.written ?? {},
        behavior: { ...DEFAULT_CONFIG.behavior, ...overrides.behavior },
        userExperience: { ...DEFAULT_CONFIG.userExperience, ...overrides.userExperience },
    }
}

/** 单条目目录 */
function indexed(entries: IndexEntry[]): IndexedCatalog {
    return {
        catalog: {},
        groups: new Map([['gw', { ids: entries.map((entry) => entry.id), byId: new Map(entries.map((entry) => [entry.id, entry])) }]]),
    }
}

/** 取首个 op 里的 models 数组 */
function written(ops: readonly unknown[]): Record<string, unknown>[] {
    return ((ops[0] as { value: Record<string, unknown>[] }).value)
}

export function run(): void {
    // ---------- 1. 指纹口径：键序无关、空壳为 null ----------
    const a = fieldStampsOf({ reasoningEfforts: { low: 'low', high: 'high' }, contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'] })
    const b = fieldStampsOf({ reasoningEfforts: { high: 'high', low: 'low' }, contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'] })
    check('档位键序不影响指纹', a.r === b.r, { a, b })
    check('四字段都被记录', a.r === 'high=high,low=low' && a.c === 1_000_000 && a.m === 128_000 && a.i === 'text,image', a)
    check('空行全 null', stable(fieldStampsOf({})) === stable({ r: null, c: null, m: null, i: null }), fieldStampsOf({}))
    check('空对象档位视作 null', fieldStampsOf({ reasoningEfforts: {} }).r === null)
    check('非字符串模态项被忽略', fieldStampsOf({ input: ['text', 42] }).i === 'text')

    // ---------- 2. 序列化往返与坏值 ----------
    const text = serializeStamps(a)
    check('序列化可反解', stable(parseStamps(text)) === stable(a), parseStamps(text))
    check('坏 JSON 视作无记录', parseStamps('{oops') === undefined)
    check('非对象视作无记录', parseStamps('[1,2]') === undefined)
    check('缺字段补 null', stable(parseStamps('{"r":"low=low"}')) === stable({ r: 'low=low', c: null, m: null, i: null }), parseStamps('{"r":"low=low"}'))
    check('非字符串记录视作无记录', parseStamps(42) === undefined)

    // ---------- 3. 逐字段归属：只有对得上的字段算插件写的 ----------
    const writtenMap = { gw: { m1: text } }
    check('字段对得上 -> 插件写的', isPluginWritten(writtenMap, 'gw', 'm1', 'c', a))
    check('字段对不上 -> 手改', !isPluginWritten(writtenMap, 'gw', 'm1', 'c', fieldStampsOf({ contextWindow: 1 })))
    check('当前值为空 -> 不算插件写的', !isPluginWritten(writtenMap, 'gw', 'm1', 'm', fieldStampsOf({ maxTokens: undefined })))
    check('无记录 -> 手改', !isPluginWritten({}, 'gw', 'm1', 'r', a))
    check('提供方/模型不匹配 -> 手改', !isPluginWritten(writtenMap, 'other', 'm1', 'r', a))

    // ---------- 4. 合并：无变化返回原引用 ----------
    const merged = withStamps({}, 'gw', 'm1', a)
    check('首次合并写入', merged.gw?.['m1'] === text, merged)
    check('同值合并不产生新对象', withStamps(merged, 'gw', 'm1', a) === merged)
    const merged2 = withStamps(merged, 'gw', 'm2', b)
    check('不同模型各自一条', merged2.gw?.['m2'] !== undefined && merged2.gw?.['m1'] === text)

    // ---------- 5. 填充策略：缺失照填；已有值按「允许更新 + 仍是插件写的」才更新 ----------
    const catalog = indexed([
        { id: 'm1', efforts: ['low', 'high'], contextWindow: 1_000_000, maxTokens: 128_000 },
        { id: 'm2', efforts: ['low', 'high'], contextWindow: 1_000_000, maxTokens: 128_000 },
    ])
    const providers = { gw: { models: [
        // m1 已有值且是插件写的 -> allowUpdate 开则更新
        { id: 'm1', reasoningEfforts: { low: 'low' }, contextWindow: 1_000_000, maxTokens: 128_000 },
        // m2 已有值但被手改 -> 冻结
        { id: 'm2', reasoningEfforts: { medium: 'medium' } },
    ] } }
    const writtenCfg = {
        gw: {
            m1: serializeStamps(fieldStampsOf({ reasoningEfforts: { low: 'low' }, contextWindow: 1_000_000, maxTokens: 128_000 })),
            m2: serializeStamps(fieldStampsOf({ reasoningEfforts: { low: 'low' } })),
        },
    }
    const plan = planFill(cfg({ allowUpdate: { reasoning: true, context: true, image: false }, written: writtenCfg }), providers, catalog, false)
    const rows = written(plan.ops)
    check('插件写过的字段被更新（补全档位）', stable(rows[0].reasoningEfforts) === stable({ low: 'low', high: 'high' }), rows[0])
    check('手改字段被冻结', stable(rows[1].reasoningEfforts) === stable({ medium: 'medium' }), rows[1])
    check('手改行缺失的容量仍按缺失补（缺失不是手改）', rows[1].contextWindow === 1_000_000 && rows[1].maxTokens === 128_000, rows[1])

    // force：单次全放开，手改值也覆盖
    const forced = planFill(cfg({ written: writtenCfg }), providers, catalog, true)
    check('force 覆盖手改值', stable(written(forced.ops)[1].reasoningEfforts) === stable({ low: 'low', high: 'high' }), written(forced.ops)[1])

    // 指纹随写入一起更新（下一轮才认得出这行还是插件写的）
    check('写入后指纹表有变化计数', plan.stamps === 2, plan.stamps)
    const stampOfM2 = parseStamps(plan.written.gw?.m2)
    check('指纹按写入后的行计算', stampOfM2?.c === 1_000_000 && stampOfM2?.r === 'medium=medium', stampOfM2)
}
