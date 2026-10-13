/**
 * 剔除模型配置里**不被支持**的推理级别：把验证明细中明确判为不支持的档位从 `reasoningEfforts` 里去掉。
 *
 * 设计裁决（守卫不可省、尊重 excludes、剔空判前、幂等）见 docs/decisions.md「写回端点」。
 */
import { LEVELS } from '@/constants'
import { PLUGIN_NAME, PLUGIN_NS } from '@/shared/constants'
import { resolveConfig } from '@/config'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { PluginConfig } from '@/shared/types'
import { isPlainObject } from '@/shared/types'
import type { UnsupportedEffort } from '@/shared/verify-progress'
import { stripEmptyFields } from '@/empty'
import { descriptorOf } from '@/section'
import { guardedWritebackApi } from '@/writeback'

/** 剔除只动这一个模型字段：最大上下文 / 输出上限 / 图片模态一概保留 */
const PRUNE_FIELD = 'reasoningEfforts'

/**
 * 剔除计划（纯函数，零 ctx 依赖可单测）：
 * 按「提供方 / 模型」剔除指定档位，其余模型字段与同提供方的其他模型原样保留，
 * 仅当某 provider 至少剔除一个档位时才整段重建写回（零变更零 op）。
 *
 * **幂等**：目标里那些当前已不在档位表里的（验明确认之后用户自己改过）一律不命中，
 * `pruned` 也不会虚报。命中却在写回期间被改动的，由调用方以读取时的 revision 作围栏整体拒写。
 *
 * `excludes` 命中的提供方整组跳过——排除语义对本插件的写入处处生效，不因这次由用户发起而破例。
 * 配置段零写入。
 *
 * 档位被剔空时，**在写入前**就判定并让整个 `reasoningEfforts` 键不出现在新值里（不是先写空再删）：
 * 路径 op 不支持数组下标中间段，只能整段 `set`，而空壳留着会反复触发写入判定。
 * 该键连同其余空壳字段（`input` / `compat`）一律走 `stripEmptyFields` 的统一判据，不在此处另写一份。
 *
 * @returns `{ modelOps, pruned }`，`pruned` 只计真正从现有档位表里剔掉的条数
 */
export function planPruneEfforts(
    config: PluginConfig,
    providers: Record<string, unknown>,
    targets: readonly UnsupportedEffort[],
): { modelOps: SettingsPathOp[]; pruned: number } {
    const excluded = new Set(config.excludes)
    // 模型 id 可含 '/'，键用二元组序列化而非字符串拼接（与 verifyKey 同口径）
    const wanted = new Map<string, ReadonlySet<string>>()
    for (const target of targets) {
        const key = JSON.stringify([target.provider, target.model])
        const seen = wanted.get(key)
        wanted.set(key, seen === undefined ? new Set([target.effort]) : new Set([...seen, target.effort]))
    }
    const modelOps: SettingsPathOp[] = []
    let pruned = 0
    for (const [providerId, provider] of Object.entries(providers)) {
        if (excluded.has(providerId)) continue
        if (!isPlainObject(provider)) continue
        const models = provider.models
        if (!Array.isArray(models)) continue
        let next: Record<string, unknown>[] | undefined
        for (let i = 0; i < models.length; i++) {
            const model = models[i]
            if (!isPlainObject(model)) continue
            const declared = isPlainObject(model[PRUNE_FIELD]) ? model[PRUNE_FIELD] : undefined
            if (declared === undefined) continue
            const hits = wanted.get(JSON.stringify([providerId, model.id]))
            if (hits === undefined) continue
            const kept: Record<string, unknown> = {}
            let hit = 0
            for (const [effort, value] of Object.entries(declared)) {
                if (hits.has(effort)) {
                    hit++
                    continue
                }
                kept[effort] = value
            }
            if (hit === 0) continue
            pruned += hit
            next ??= models.slice()
            // 档位剔空或只剩 off 时 reasoningEfforts 整个键删掉（两者都等同未声明），其余空壳字段一并按统一判据清理
            next[i] = stripEmptyFields({ ...model, [PRUNE_FIELD]: kept })
        }
        if (next) modelOps.push({ op: 'set', path: ['providers', providerId, 'models'], value: next })
    }
    return { modelOps, pruned }
}

/**
 * 解析剔除请求的载荷（RPC 入参按不可信输入校验，与 `planProbes` 同一纪律）。
 * 档位须落在 harness 支持的取值内，否则剔除会指向配置里不可能存在的键。
 * 任一条不合法即**整体**拒绝，不做部分剔除——半剔比不剔更难向用户解释。
 */
export function parsePruneTargets(payload: unknown): UnsupportedEffort[] | undefined {
    if (!isPlainObject(payload)) return
    const targets = payload.targets
    if (!Array.isArray(targets) || targets.length === 0) return
    const parsed: UnsupportedEffort[] = []
    for (const entry of targets) {
        if (!isPlainObject(entry)) return
        const { provider, model, effort } = entry
        if (typeof provider !== 'string' || provider === '') return
        if (typeof model !== 'string' || model === '') return
        if (typeof effort !== 'string' || !LEVELS.has(effort)) return
        parsed.push({ provider, model, effort })
    }
    return parsed
}

/**
 * 执行剔除：读最新两段配置 → 出计划 → 经 `queueTask` 写回 `llm-pi-ai` 段 → 返回实际剔掉的条数。
 *
 * 事件流守卫全程打开：写回触发的 settings/document-updated 事件必须被拦下，
 * 否则事件链的 `fix` 会把刚剔掉的档位从 models.dev 又填回来，用户点了剔除却什么都没变。
 *
 * 返回受影响的**档位**条数（不是模型数）：确认框里说的是「n 个推理级别」，回报也须是同一口径。
 * 写失败先告警再抛出，由调用方转 RPC 失败结果。
 */
export async function pruneUnsupportedEfforts(ctx: Context, targets: readonly UnsupportedEffort[]): Promise<number> {
    const { pruned } = await guardedWritebackApi(ctx, {
        label: '剔除',
        // 段不可读即当「本就无可剔除」静默早退
        unreadableProviders: () => ({ modelOps: [], pruned: 0 }),
        plan: ({ providers }) => {
            // 当前生效配置（损坏快照回退最高可解析版本/默认，excludes 一并生效）
            const configDescriptor = descriptorOf(ctx, PLUGIN_NS)
            // 自有段不可读时显式失败：回退 DEFAULT_CONFIG 会使 excludes 变空，
            // 剔除会作用到用户实际已排除的提供方
            if (!configDescriptor) throw new Error(`${PLUGIN_NAME}: 自有配置段 ${PLUGIN_NS} 不可读，无法剔除推理级别`)
            return planPruneEfforts(resolveConfig(configDescriptor.user), providers, targets)
        },
        noChange: '剔除：没有可剔除的推理级别',
        done: ({ pruned }) => `已剔除 ${pruned} 个不被支持的推理级别`,
    })
    return pruned
}
