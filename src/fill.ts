/** 探测档位的两步写回：把候选档位临时预声明进模型配置，探测跑完再按结论收敛成最终形态。
 * 裁决见 docs/decisions-diagnose.md「探测」。`targetKey` 用 JSON.stringify([provider, model]) 序列化（模型 id 可含 '/'，字符串拼接会歧义） */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { EFFORT_LEVELS } from '@/shared/constants'
import { isPlainObject } from '@/shared/types'
import { stripEmptyFields } from '@/empty'
import { writebackApi } from '@/writeback'

/** 写回只动这一个模型字段：最大上下文 / 输出上限 / 图片模态与自定义字段一概保留 */
const FILL_FIELD = 'reasoningEfforts'

/** 「提供方 / 模型」二元组键：模型 id 可含 '/'，故用序列化而非字符串拼接（与 verifyKey 同口径） */
function targetKey(provider: string, model: string): string {
    return JSON.stringify([provider, model])
}

/** 一次档位表改写：「这个模型改成声明这些档位」（空数组 = 声明为零，即删掉该字段） */
export interface EffortApply {
    provider: string
    model: string
    levels: readonly string[]
}

/** 写入计划的结果：ops 与增删条数（口径见 `planEffortApply` 的 `baseline`） */
interface EffortApplyPlan {
    modelOps: SettingsPathOp[]
    models: number
    added: number
    removed: number
}

/** 目标模型当前声明的档位（按 `EFFORT_LEVELS` 排序；未声明即空表），键为 `targetKey` */
export function declaredEffortsOf(providers: Record<string, unknown>, targets: readonly EffortApply[]): Map<string, readonly string[]> {
    const wanted = new Set(targets.map((target) => targetKey(target.provider, target.model)))
    const declared = new Map<string, readonly string[]>()
    for (const [providerId, provider] of Object.entries(providers)) {
        if (!isPlainObject(provider) || !Array.isArray(provider.models)) continue
        for (const model of provider.models) {
            if (!isPlainObject(model) || typeof model.id !== 'string') continue
            const key = targetKey(providerId, model.id)
            if (!wanted.has(key)) continue
            declared.set(key, declaredLevelsOf(model[FILL_FIELD]))
        }
    }
    return declared
}

/** 档位表取值：只认普通对象的键，按 `EFFORT_LEVELS` 排序（与浏览器半候选列表同口径） */
function declaredLevelsOf(value: unknown): readonly string[] {
    if (!isPlainObject(value)) return []
    const keys = new Set(Object.keys(value))
    return EFFORT_LEVELS.filter((level) => keys.has(level))
}

/** 按档位表物化 `reasoningEfforts` 取值：七档内键由 `levels` 决定（已有键保留原取值——用户 wire 拼写属配置，如 `xhigh:'ultra'`、off 的 `none`/`off`；新补档取档位名本身，off 无既有拼写时取 null），不在 levels 里的剔除；七档外键原样保留（手改残留，宿主忽略） */
function effortsValueOf(levels: readonly string[], existing?: Record<string, unknown>): Record<string, string | null> {
    const value: Record<string, string | null> = {}
    if (existing !== undefined) {
        for (const [key, wire] of Object.entries(existing)) {
            if (!EFFORT_LEVELS.includes(key as never)) value[key] = wire as string | null
        }
    }
    for (const level of levels) {
        const current = existing?.[level]
        value[level] = typeof current === 'string' ? current : (level === 'off' ? null : level)
    }
    return value
}

/** 档位表改写计划（纯函数、可单测）：按 provider/model 整段设成 `levels`，其余字段原样保留；仅某 provider 至少改写一个模型时才整段重建（零变更零 op）。
 * 范围只由 `entries` 决定（发跑时冻结的候选清单，预声明与收敛覆盖同一批目标）；遍历当次现读的 `providers`，entries 里已删目标自然不命中、不产 op。
 * 目标档位表为空或只剩 off 即整个 `reasoningEfforts` 键删掉（两者等同未声明）：路径 op 不支持数组下标中间段，只能整段 set，空壳留着会反复触发写入判定。
 * 两套口径各按各的基线：`modelOps` 按当前值与目标表比对（只有真要改才产 op）；`models`/`added`/`removed` 按 `baseline`（探测档位传预声明之前的档位表，统计对齐用户视角——临时预声明的档位被收回时既不算新增也不算删除） */
export function planEffortApply(
    providers: Record<string, unknown>,
    entries: readonly EffortApply[],
    baseline?: ReadonlyMap<string, readonly string[]>,
): EffortApplyPlan {
    const wanted = new Map<string, readonly string[]>()
    for (const entry of entries) wanted.set(targetKey(entry.provider, entry.model), entry.levels)
    const modelOps: SettingsPathOp[] = []
    let models = 0
    let added = 0
    let removed = 0
    for (const [providerId, provider] of Object.entries(providers)) {
        if (!isPlainObject(provider)) continue
        const list = provider.models
        if (!Array.isArray(list)) continue
        let next: Record<string, unknown>[] | undefined
        for (let i = 0; i < list.length; i++) {
            const model = list[i]
            if (!isPlainObject(model) || typeof model.id !== 'string') continue
            const key = targetKey(providerId, model.id)
            const levels = wanted.get(key)
            if (levels === undefined) continue
            const before = baseline?.get(key) ?? declaredLevelsOf(model[FILL_FIELD])
            if (!sameLevels(levels, before)) {
                models++
                const kept = new Set(levels)
                for (const level of kept) if (!before.includes(level)) added++
                for (const level of before) if (!kept.has(level)) removed++
            }
            if (sameLevels(declaredLevelsOf(model[FILL_FIELD]), levels)) continue
            next ??= list.slice()
            // 目标为空表或只剩 off 时**直接删键**：两者都等同未声明（无可选档位），与 stripEmptyFields 空壳判据同口径
            const replaced = { ...model }
            if (levels.length === 0 || (levels.length === 1 && levels[0] === 'off')) delete replaced[FILL_FIELD]
            else replaced[FILL_FIELD] = effortsValueOf(levels, isPlainObject(model[FILL_FIELD]) ? model[FILL_FIELD] as Record<string, unknown> : undefined)
            next[i] = stripEmptyFields(replaced)
        }
        if (next) modelOps.push({ op: 'set', path: ['providers', providerId, 'models'], value: next })
    }
    return { modelOps, models, added, removed }
}

/** 两份档位表是否同集（都按 `EFFORT_LEVELS` 排序，故逐位比较即可） */
function sameLevels(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((level, index) => level === right[index])
}

/** 读最新配置 → 出计划 → 写回 `llm-pi-ai` 段（骨架见 `src/writeback.ts`，冲突重读重算限次）。
 * 不碰事件流守卫：探测档位的守卫持有整轮（预声明 → 探测 → 收敛），故走不带守卫的 `writebackApi`；`compute` 每次重试重算，须为纯函数 */
async function applyEfforts(
    ctx: Context,
    compute: (providers: Record<string, unknown>) => EffortApplyPlan,
    label: string,
): Promise<EffortApplyPlan> {
    return writebackApi(ctx, {
        label,
        // 段不可读即当「本就无可改写」静默早退（返回零计划，不打日志）
        unreadableProviders: () => ({ modelOps: [], models: 0, added: 0, removed: 0 }),
        plan: ({ providers }) => compute(providers),
        noChange: `${label}：没有需要改写的推理级别`,
        done: ({ models, added, removed }) => `${label}完成：${models} 个模型、新增 ${added} 个、删除 ${removed} 个推理级别`,
    })
}

/** 预声明：把目标模型的档位表补成「原有 ∪ 全部候选档位」，返回改写前各模型原有的档位表。
 * 返回的那份原有档位表是收敛阶段的唯一基线（临时预声明的档位不属于用户配置，收回时不计入增删）；目标模型已不存在（探测期间被删）时不出现，收敛自然不碰它 */
export async function declareProbeEfforts(
    ctx: Context,
    targets: readonly EffortApply[],
): Promise<Map<string, readonly string[]>> {
    let preexisting = new Map<string, readonly string[]>()
    await applyEfforts(ctx, (providers) => {
        preexisting = declaredEffortsOf(providers, targets)
        return planEffortApply(
            providers,
            targets.map((target) => {
                // 按 EFFORT_LEVELS 排序写入（不按「原有在前」）：键序是用户会看见的，收敛按同一口径比对，键序不一致会误判成有变更
                // off 不补：未声明 off 的模型不替它猜——「能通」不等于「能关」
                const pre = preexisting.get(targetKey(target.provider, target.model)) ?? []
                const merged = new Set([...pre, ...EFFORT_LEVELS.filter((level) => level !== 'off')])
                return { ...target, levels: EFFORT_LEVELS.filter((level) => merged.has(level)) }
            }),
        )
    }, '预声明推理级别')
    return preexisting
}

/** 收敛：按探测结论把档位表改回最终形态（`levels` 为空数组的模型即删掉该字段）；写入前判空壳、幂等；增删统计对齐 `baseline`（预声明之前的档位表） */
export function convergeProbeEfforts(
    ctx: Context,
    entries: readonly EffortApply[],
    baseline: ReadonlyMap<string, readonly string[]>,
): Promise<EffortApplyPlan> {
    return applyEfforts(ctx, (providers) => planEffortApply(providers, entries, baseline), '收敛推理级别')
}
