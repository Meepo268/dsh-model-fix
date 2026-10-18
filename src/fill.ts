/**
 * 探测档位的两步写回：把候选档位**临时预声明**进模型配置，探测跑完后再按结论**收敛**成最终形态。
 *
 * 设计裁决（预声明必要性、写回壳理由、基线比对口径）见 docs/decisions.md「探测档位」。
 * 本文件独有的口径：`targetKey` 用 JSON.stringify([provider, model]) 序列化，因模型 id 可含 '/'，字符串拼接会歧义。
 */
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

/**
 * 按档位表物化 `reasoningEfforts` 的取值：七档内的键完全由 `levels` 决定——**已有键一律保留原取值**
 * （用户的 wire 拼写属用户配置，如 `xhigh: 'ultra'`、off 的 `none`/`off` 目录拼写），新补的档位取档位名
 * 本身（off 无既有拼写可保时取 null），不在 levels 里的即被剔除/还原要删的档位。七档之外的键原样保留
 * （手改配置文件的残留，宿主读取时忽略），静默删除违背自定义字段保留纪律。
 */
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

/**
 * 档位表改写计划（纯函数，零 ctx 依赖可单测）：
 * 按「提供方 / 模型」把档位表整段设成 `levels`，其余模型字段与同提供方的其他模型原样保留，
 * 仅当某 provider 至少改写一个模型时才整段重建写回（零变更零 op）。
 *
 * **范围只由 `entries` 决定**：它就是探测发起时冻结的候选清单（已在浏览器半按 `excludes` 过滤），
 * 本函数不读也不判排除，预声明与收敛因此覆盖同一批目标。遍历的是**当次现读的** `providers`，
 * 故 `entries` 里已被用户删掉的目标自然不命中、不产出 op（而非写出失败）。
 *
 * **目标档位表为空或只剩 off 即整个 `reasoningEfforts` 键删掉**（两者都等同未声明），
 * 不是先写空再删：路径 op 不支持数组下标中间段，只能整段 `set`，而空壳留着会反复触发写入判定。
 * 该键连同其余空壳字段（`input` / `compat`）一律走 `stripEmptyFields` 的统一判据，不在此处另写一份。
 *
 * **两套口径各按各的基线**，别混：
 * - `modelOps` 按**当前值**与目标表比对——只有真要改才产出 op，故收敛阶段算出的表与预声明一致时零写入。
 * - `models` / `added` / `removed` 按 `baseline`（缺省即当前值）比对——探测档位传的是**预声明之前**的档位表，
 *   统计口径要对齐用户视角的那份配置：临时预声明的档位被收回时既不算新增也不算删除，它本不属于用户配置。
 *   正因如此「七档全可用」时收敛是零写入，而统计仍如实报出「补了 7 个档位」。
 */
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

/**
 * 读最新配置 → 出计划 → 写回 `llm-pi-ai` 段（骨架见 `src/writeback.ts`，`SETTINGS_CONFLICT` 时重读重算、限次）。
 *
 * **本函数不碰事件流守卫**：探测档位的守卫持有整轮（预声明 → 探测 → 收敛），故走不带守卫的 `writebackApi`。
 * `compute` 在每次重试里重算，故它必须是纯函数、可对任意一次快照求值。
 */
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

/**
 * 预声明：把目标模型的档位表补成「原有 ∪ 全部候选档位」，返回**改写前**各模型原有的档位表。
 *
 * 写回范围就是 `targets`（探测发起时冻结的候选清单），本轮不再读 `excludes`——轮次中途新增的排除留到下一轮生效。
 *
 * 返回的那份原有档位表是收敛阶段的唯一基线（临时预声明的档位不属于用户配置，收回时不计入增删）。
 * 目标模型已不存在于配置里（探测期间被用户删掉）时不出现在返回值里，收敛阶段自然也不会碰它。
 */
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
                // 档位表按 EFFORT_LEVELS 排序写入（不按「原有在前」）：配置里的键序是用户会看见的东西，
                // 预声明是临时形态也不能让档位表显得杂乱；且收敛阶段按同一口径比对，键序不一致会误判成有变更
                // off 不补：未声明 off 的模型不替它猜——"能通"不等于"能关"（#7）
                const pre = preexisting.get(targetKey(target.provider, target.model)) ?? []
                const merged = new Set([...pre, ...EFFORT_LEVELS.filter((level) => level !== 'off')])
                return { ...target, levels: EFFORT_LEVELS.filter((level) => merged.has(level)) }
            }),
        )
    }, '预声明推理级别')
    return preexisting
}

/**
 * 收敛：按探测结论把档位表改回最终形态（`levels` 为空数组的模型即删掉该字段）。
 * 写入前判空壳、幂等；增删统计对齐 `baseline`（预声明之前的档位表）。
 */
export function convergeProbeEfforts(
    ctx: Context,
    entries: readonly EffortApply[],
    baseline: ReadonlyMap<string, readonly string[]>,
): Promise<EffortApplyPlan> {
    return applyEfforts(ctx, (providers) => planEffortApply(providers, entries, baseline), '收敛推理级别')
}
