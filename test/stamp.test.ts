// stamp.ts 纯函数测试：参数指纹（序列化/解析/逐字段归属判定/合并），以及 fix 的「手改不被自动来源覆盖」口径
import { fieldStampsOf, isPluginWritten, parseStamps, serializeStamps, withStamps } from '@/stamp'
import { planFill } from '@/fix'
import { DEFAULT_CONFIG } from '@/shared/config-schema'
import type { PluginConfig } from '@/shared/types'
import type { IndexedCatalog, IndexEntry } from '@/types'
import type { DeclarationMap } from '@/upstream'
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
        sources: overrides.sources ?? {},
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

    // ---------- 5. 填充策略：缺失照填；已有值只在「来源升级」时更新，同级/降级一律锁定 ----------
    const catalog = indexed([
        { id: 'm1', efforts: ['low', 'high'], contextWindow: 1_000_000, maxTokens: 128_000 },
        { id: 'm2', efforts: ['low', 'high'], contextWindow: 1_000_000, maxTokens: 128_000 },
        { id: 'm3', efforts: ['low', 'high'], contextWindow: 2_000_000, maxTokens: 256_000 },
    ])
    const providers = { gw: { models: [
        // m1 全部由目录写过（来源 c）-> 目录再报什么都不要动（自动锁定）
        { id: 'm1', reasoningEfforts: { low: 'low' }, contextWindow: 1_000_000, maxTokens: 128_000 },
        // m2 档位被手改 -> 冻结；缺的容量照补
        { id: 'm2', reasoningEfforts: { medium: 'medium' } },
        // m3 档位由目录写过，本轮上游声明的档位更全 -> 允许升级
        { id: 'm3', reasoningEfforts: { low: 'low' }, contextWindow: 2_000_000, maxTokens: 256_000 },
    ] } }
    const writtenCfg = {
        gw: {
            m1: serializeStamps(fieldStampsOf({ reasoningEfforts: { low: 'low' }, contextWindow: 1_000_000, maxTokens: 128_000 }, { r: 'c', c: 'c', m: 'c' })),
            m2: serializeStamps(fieldStampsOf({ reasoningEfforts: { low: 'low' } })),
            m3: serializeStamps(fieldStampsOf({ reasoningEfforts: { low: 'low' }, contextWindow: 2_000_000, maxTokens: 256_000 }, { r: 'c', c: 'c', m: 'c' })),
        },
    }
    const declarations: DeclarationMap = new Map([['gw', new Map([
        ['m3', { efforts: ['low', 'medium'], contextWindow: 2_000_000, maxTokens: 256_000 }],
    ])]])
    const plan = planFill(cfg({ allowUpdate: { reasoning: true, context: true, image: false }, written: writtenCfg }), providers, catalog, false, declarations)
    const rows = written(plan.ops)
    const byId = (id: string): Record<string, unknown> | undefined => rows.find((row) => row.id === id)
    check('目录写过的值同级不再刷新（已锁定）', stable(byId('m1')?.reasoningEfforts) === stable({ low: 'low' }) && byId('m1')?.contextWindow === 1_000_000, byId('m1'))
    check('上游声明可把目录值升级', stable(byId('m3')?.reasoningEfforts) === stable({ low: 'low', medium: 'medium' }), byId('m3'))
    check('升级后指纹记上游来源', parseStamps(plan.written.gw?.m3)?.s?.r === 'u', parseStamps(plan.written.gw?.m3))
    check('手改字段被冻结', stable(byId('m2')?.reasoningEfforts) === stable({ medium: 'medium' }), byId('m2'))
    check('手改行缺失的容量仍按缺失补（缺失不是手改）', byId('m2')?.contextWindow === 1_000_000 && byId('m2')?.maxTokens === 128_000, byId('m2'))

    // force：单次全放开，手改值也覆盖
    const forced = planFill(cfg({ written: writtenCfg }), providers, catalog, true)
    check('force 覆盖手改值', stable(written(forced.ops)[1].reasoningEfforts) === stable({ low: 'low', high: 'high' }), written(forced.ops)[1])

    // 指纹随写入一起更新（下一轮才认得出这行还是插件写的）
    check('写入后指纹表有变化计数', plan.stamps === 2, plan.stamps)
    const stampOfM2 = parseStamps(plan.written.gw?.m2)
    check('未写字段保留旧指纹（与当前值不符即冻结）', stampOfM2?.c === 1_000_000 && stampOfM2?.r === 'low=low', stampOfM2)
}

