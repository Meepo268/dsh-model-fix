/** 推理级别记忆的失效清理：按宿主全量模型列表剪掉已不存在的条目（口径见 docs/decisions.md「推理级别记忆」） */
import type { Context } from '@deepseek-ai/cordis'
import { MAX_ATTEMPTS } from '@/constants'
import { getConfig } from '@/config'
import { queueTask } from '@/host'
import { descriptorOf } from '@/section'
import { errorText, isSettingsConflict } from '@/shared/errors'
import { PLUGIN_NS, PLUGIN_NAME } from '@/shared/constants'
import { CONFIG_VERSION, versionKey } from '@/shared/config-schema'
import type { EffortMemory } from '@/shared/types'

/** 存活模型清单：`undefined` = 无活路由（真删了）/ `null` = 读失败（读不到 ≠ 不存在）/ 集合 = 成功 */
export type LiveModels = ReadonlyMap<string, ReadonlySet<string> | null>

/** 剪枝计划：清理后的整段记忆 + 本轮删除条数 */
interface PrunePlan {
    readonly memory: EffortMemory
    readonly removed: number
}

/** 按存活清单剪枝记忆（不改入参）：缺席即删、段删空则折叠；读失败整段保留；`forgetRemoved` 关或无需写回返回 `null` */
export function planPruneMemory(memory: EffortMemory, live: LiveModels, forgetRemoved: boolean): PrunePlan | null {
    if (!forgetRemoved) return null
    const next: EffortMemory = {}
    let changed = false
    let removed = 0
    for (const [providerId, models] of Object.entries(memory)) {
        const liveModels = live.get(providerId)
        // provider 已无活路由：整段删除
        if (liveModels === undefined) {
            changed = true
            removed += Object.keys(models).length
            continue
        }
        // 在路由上但目录读失败：读不到不等于不存在，整段原样保留
        if (liveModels === null) {
            next[providerId] = { ...models }
            continue
        }
        const kept: Record<string, string> = {}
        for (const [modelId, effort] of Object.entries(models)) {
            if (!liveModels.has(modelId)) {
                changed = true
                removed++
                continue
            }
            kept[modelId] = effort
        }
        // 该 provider 下的模型全被删（或本就是空壳段）→ 段随之折叠
        if (Object.keys(kept).length === 0) {
            changed = true
            continue
        }
        next[providerId] = kept
    }
    return changed ? { memory: next, removed } : null
}

/** 采集存活清单：只对有记忆条目的 provider 调 `listModels`；单 provider 读失败标 `null` 不影响其余；`listProviders()` 为空（退化读）返回 `null` = 本轮不剪 */
export async function collectLiveModels(ctx: Context, providerIds: readonly string[]): Promise<LiveModels | null> {
    const registered = new Set(ctx.llm.listProviders().map((provider) => provider.id))
    if (registered.size === 0) return null
    const live = new Map<string, ReadonlySet<string> | null>()
    for (const providerId of providerIds) {
        if (!registered.has(providerId)) continue
        try {
            live.set(providerId, new Set((await ctx.llm.listModels(providerId)).map((model) => model.id)))
        } catch {
            // 目录读失败（凭据缺失、端点不通等）不是删除证据：标成未知，本段不剪
            live.set(providerId, null)
        }
    }
    return live
}

/** 在途与待补跑标志：事件密集时合并补跑，不丢事件 */
let pruning = false
let pending = false

/** 剪一次记忆：读配置 → 采存活清单 → 出计划 → 经 `queueTask` 写回（冲突重读重算，限次）；写失败只告警（记忆可丢）；在途时的事件置 `pending` 补跑 */
export async function updateMemory(ctx: Context): Promise<void> {
    if (pruning) {
        pending = true
        return
    }
    pruning = true
    try {
        do {
            pending = false
            await pruneOnce(ctx)
        } while (pending)
    } finally {
        pruning = false
    }
}

/** 一轮剪枝（读 → 采 → 计划 → 写回）。任何一步判定「不必剪」即整轮早退 */
async function pruneOnce(ctx: Context): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (!ctx.fiber.store) return
        const cfg = getConfig()
        if (!cfg.userExperience.forgetRemoved) return
        const live = await collectLiveModels(ctx, Object.keys(cfg.efforts))
        if (!live) return
        const plan = planPruneMemory(cfg.efforts, live, cfg.userExperience.forgetRemoved)
        if (!plan) return
        const descriptor = descriptorOf(ctx, PLUGIN_NS)
        if (!descriptor) return
        try {
            await queueTask(() => ctx.settings.mutate(
                PLUGIN_NS,
                [{ op: 'set', path: [versionKey(CONFIG_VERSION), 'efforts'], value: plan.memory }],
                descriptor.revision,
            ))
            ctx.logger.info(`${PLUGIN_NAME}: 已清理 ${plan.removed} 条失效的推理级别记忆`)
            return
        } catch (error) {
            if (isSettingsConflict(error) && attempt < MAX_ATTEMPTS) continue
            ctx.logger.warn(`${PLUGIN_NAME}: 清理失效的推理级别记忆失败（第 ${attempt}/${MAX_ATTEMPTS} 次）：${errorText(error)}`)
            return
        }
    }
}
