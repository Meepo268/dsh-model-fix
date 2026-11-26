/** 模型清单对账（roster.ts）：首轮播种、上新进待上线、两次缺席才删、抓取失败不动账本、非对话不自动上线 */
import { reconcile } from '@/roster'
import { DEFAULT_CONFIG } from '@/shared/config-schema'
import type { PluginConfig } from '@/shared/types'
import type { EndpointSnapshot, SnapshotMap } from '@/upstream'
import { check, stable } from '@test/helper'

const MODEL_A = 'gpt-a'
const MODEL_B = 'gpt-new'
const IMAGE = 'image-1'

/** 造一份提供方配置：`models` 的键即「已勾选的模型列表」 */
function providersOf(ids: readonly string[]): Record<string, unknown> {
    return {
        gw: {
            baseURL: 'https://gw.example/v1',
            models: ids.map((id) => ({ id, name: id })),
        },
    }
}

/** 造一份抓取结果：`declared` 是上游声明的 id（kind 由第二个参数给出） */
function snapshotsOf(declared: readonly [string, 'chat' | 'image' | 'video'][], ok = true): SnapshotMap {
    const roster = new Map(declared.map(([id, kind]) => [id, { kind }]))
    const declarations = new Map([...roster].map(([id]) => [id, { efforts: ['high'] }]))
    const snapshot: EndpointSnapshot = { ok, declarations, roster }
    return new Map([['gw', snapshot]])
}

function eq(name: string, actual: unknown, expected: unknown): void {
    check(name, stable(actual) === stable(expected), { actual, expected })
}

function cfg(overrides: Partial<PluginConfig> = {}): PluginConfig {
    return { ...DEFAULT_CONFIG, ...overrides, userExperience: { ...DEFAULT_CONFIG.userExperience, ...overrides.userExperience } }
}

export function run(): void {
    // 首轮：本地有 A、上游有 A+B → 只播种 known，不提示 B
    const first = reconcile(cfg(), providersOf([MODEL_A]), snapshotsOf([[MODEL_A, 'chat'], [MODEL_B, 'chat']]))
    check('首次记账把上游全集当已知', (first.known.gw ?? []).includes(MODEL_B))
    eq('首次记账不提示上新', Object.keys(first.pending.gw ?? {}).length, 0)

    // 第二轮：B 是新出现的（known 里没有）→ 进 pending
    const second = reconcile(cfg({ known: { gw: [MODEL_A] } }), providersOf([MODEL_A]), snapshotsOf([[MODEL_A, 'chat'], [MODEL_B, 'chat']]))
    eq('新出现的模型进待上线', second.pending.gw?.[MODEL_B]?.kind, 'chat')

    // 已被手动勾选的模型不进 pending
    const adopted = reconcile(cfg({ known: { gw: [MODEL_A] } }), providersOf([MODEL_A, MODEL_B]), snapshotsOf([[MODEL_A, 'chat'], [MODEL_B, 'chat']]))
    eq('已在列表里的模型不进待上线', Object.keys(adopted.pending.gw ?? {}).length, 0)

    // 缺席一次只记一笔，缺席两次才删
    const miss1 = reconcile(cfg({ known: { gw: [MODEL_A, MODEL_B] } }), providersOf([MODEL_A, MODEL_B]), snapshotsOf([[MODEL_A, 'chat']]))
    eq('缺席一次不删', Object.keys((miss1.providers.gw as { models: object }).models).length, 2)
    eq('缺席一次记一笔 strike', miss1.missing.gw?.[MODEL_B], 1)
    eq('缺席一次也要标记 changed（否则 strike 落不了盘）', miss1.changed, true)
    const miss2 = reconcile(cfg({ known: { gw: [MODEL_A, MODEL_B] }, missing: { gw: { [MODEL_B]: 1 } } }), providersOf([MODEL_A, MODEL_B]), snapshotsOf([[MODEL_A, 'chat']]))
    eq('连续两次缺席才删', miss2.removed.get('gw'), [MODEL_B])

    // 抓取失败：账本与列表都不动
    const failed = reconcile(cfg({ known: { gw: [MODEL_A] }, missing: { gw: { [MODEL_B]: 1 } } }), providersOf([MODEL_A, MODEL_B]), snapshotsOf([[MODEL_A, 'chat']], false))
    eq('抓取失败不动账本', failed.changed, false)

    // 非对话模型只进 pending 标记，kind 交给客户端决定是否上线
    const image = reconcile(cfg({ known: { gw: [MODEL_A] } }), providersOf([MODEL_A]), snapshotsOf([[MODEL_A, 'chat'], [IMAGE, 'image']]))
    eq('图像模型保留 kind', image.pending.gw?.[IMAGE]?.kind, 'image')

}
