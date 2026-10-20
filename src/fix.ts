import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { getCatalog } from '@/catalog'
import { planProviderCompat } from '@/compat'
import { lookup, toReasoningEfforts } from '@/lookup'
import { COMPAT_APIS, MAX_ATTEMPTS } from '@/constants'
import { API_NS, PLUGIN_NAME } from '@/shared/constants'
import { getConfig } from '@/config'
import { stripEmptyFields } from '@/empty'
import { queueTask } from '@/host'
import { isCapacity, type IndexedCatalog } from '@/types'
import { isPlainObject, providersOf, type CompatRules, type PluginConfig } from '@/shared/types'
import { descriptorOf } from '@/section'
import { errorText, isSettingsConflict } from '@/shared/errors'

/** 缓存图片信息转换为写回的 input 模态数组：仅支持图片时填 ['text','image']，无数据或纯文本不填（未声明即按纯文本处理） */
function toInputValue(image: boolean | undefined): string[] | undefined {
    return image ? ['text', 'image'] : undefined
}

/** 填充计划：`llm-pi-ai` 段的写回 op（纯计算产物，不含 revision 与日志文案） */
interface FillPlan {
    readonly ops: SettingsPathOp[]
    readonly changes: number
    readonly compatChanges: number
    readonly excluded: number
}

/** 纯计划函数（零 ctx、可单测）：遍历提供方算出模型参数 op 与路由 compat op；`excludes` 命中者在入口整条跳过；`efforts` 记忆不在本文件处理。
 * `looseMatch` 开启时把尽量匹配开关传给 lookup（歧义/无命中的兜底合成，见 lookup.ts） */
export function planFill(
    cfg: PluginConfig,
    providers: Record<string, unknown>,
    indexed: IndexedCatalog,
    force: boolean,
): FillPlan {
    const allowRules = cfg.allowUpdate
    const autoRules = cfg.autoFill
    const compatRules = cfg.compat
    const looseMatch = cfg.userExperience.looseMatch
    // 提供方级排除：命中的 id 整条跳过（模型写回与路由 compat 都不作用其上）
    const excludes = new Set(cfg.excludes)
    const ops: SettingsPathOp[] = []
    let changes = 0
    let compatChanges = 0
    let excluded = 0
    for (const [providerId, provider] of Object.entries(providers)) {
        if (excludes.has(providerId)) {
            excluded++
            continue
        }
        if (!isPlainObject(provider)) continue
        const { api, models, compat: currentCompat } = provider as { api?: unknown; models?: unknown; compat?: unknown }
        if (Array.isArray(models)) {
            let next: Record<string, unknown>[] | undefined
            for (let i = 0; i < models.length; i++) {
                const model = models[i]
                if (!isPlainObject(model) || model.id === undefined || model.id === null) continue
                const modelId = String(model.id)
                // 显示名兜底：网关 id 带命名空间前缀、或与目录 id 不同形时，用「设置→模型」右侧那个名字再试一次
                const modelName = typeof model.name === 'string' ? model.name : undefined
                // 缺失补写按剔除空壳后的值认（空壳等同未声明，否则既不被填又被清、要等下一轮才补上）
                const cleaned = stripEmptyFields(model)
                const { reasoningEfforts, contextWindow, maxTokens } = cleaned as {
                    reasoningEfforts?: unknown
                    contextWindow?: unknown
                    maxTokens?: unknown
                }
                const entry = lookup(indexed, providerId, modelId, looseMatch, modelName)
                const efforts = toReasoningEfforts(entry)
                // 图片模态同上：判据取自 cleaned.input
                const input = cleaned.input
                const imageValue = toInputValue(entry?.image)
                // 推理级别
                const reasoningFillable = autoRules.reasoning
                    && reasoningEfforts === undefined && !!efforts
                const reasoningUpdatable = (force || allowRules.reasoning)
                    && isPlainObject(efforts)
                    && !deepEqualJson(reasoningEfforts, efforts)
                // 容量新值须为正整数且非哨兵（写 0 会被宿主 schema 拒绝并连累整批写入）
                const ctxW = entry?.contextWindow
                const maxT = entry?.maxTokens
                const contextFillable = autoRules.context
                    && contextWindow === undefined && isCapacity(ctxW)
                const contextUpdatable = (force || allowRules.context)
                    && ctxW !== contextWindow
                    && isCapacity(ctxW)
                const maxTokensFillable = autoRules.context
                    && maxTokens === undefined && isCapacity(maxT)
                const maxTokensUpdatable = (force || allowRules.context)
                    && maxT !== maxTokens
                    && isCapacity(maxT)
                const imageFillable = autoRules.image
                    && input === undefined && !!imageValue
                const imageUpdatable = (force || allowRules.image)
                    && !!imageValue
                    && !deepEqualJson(input, imageValue)
                if (cleaned === model && !reasoningFillable && !reasoningUpdatable
                    && !contextFillable && !contextUpdatable && !maxTokensFillable && !maxTokensUpdatable
                    && !imageFillable && !imageUpdatable) continue
                changes++
                next ??= models.slice()
                const patched = { ...cleaned }
                if (reasoningFillable || reasoningUpdatable) patched.reasoningEfforts = efforts
                if (contextFillable || contextUpdatable) patched.contextWindow = ctxW
                if (maxTokensFillable || maxTokensUpdatable) patched.maxTokens = maxT
                if (imageFillable || imageUpdatable) patched.input = imageValue
                next[i] = patched
            }
            if (next) {
                ops.push({ op: 'set', path: ['providers', providerId, 'models'], value: next })
            }
        }
        // 路由级兼容性（与模型参数无关，故 models 缺失也要处理）；协议适用范围见 COMPAT_APIS
        // 非目标协议（如已从 completions 切到 responses）仅做残留清理（只删不加），无论开关如何。
        if (typeof api === 'string') {
            const effectiveCompat: CompatRules = COMPAT_APIS.has(api) ? compatRules : { disableDeveloper: false, disableStore: false }
            const plan = planProviderCompat(effectiveCompat, currentCompat)
            if (plan) {
                compatChanges++
                ops.push(plan.op === 'set'
                    ? { op: 'set', path: ['providers', providerId, 'compat'], value: plan.value }
                    : { op: 'unset', path: ['providers', providerId, 'compat'] })
            }
        }
    }
    return { ops, changes, compatChanges, excluded }
}

/** 填充与写回：读最新段 → `planFill` 出计划 → 写 `llm-pi-ai` → 返回变更模型数（不含 compat 计数，保持 RPC 契约）
 * 写回失败先告警再抛出；冲突限次重试时重读整段。刻意不走 writeback.ts 外壳（守卫与端点骨架不同形，理由见该文件头） */
export async function fix(ctx: Context, force = false): Promise<number> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // 卸载后不再碰 settings（服务已 dispose，访问即抛 inactive context）
        if (!ctx.fiber.store) return 0
        const descriptor = descriptorOf(ctx, API_NS)
        if (!descriptor) return 0
        const providers = providersOf(descriptor.user)
        if (!providers) return 0
        const cfg = getConfig()
        const plan = planFill(cfg, providers, getCatalog(), force)
        if (plan.ops.length === 0) return 0
        try {
            await queueTask(() => ctx.settings.mutate(API_NS, plan.ops, descriptor.revision))
            ctx.logger.info(`${PLUGIN_NAME}: 已变更 ${plan.changes} 个模型（补充/同步推理级别、容量字段、图片模态、清理空字段）、${plan.compatChanges} 个提供方的兼容性优化，跳过 ${plan.excluded} 个已排除提供方`)
            return plan.changes
        } catch (error) {
            if (isSettingsConflict(error) && attempt < MAX_ATTEMPTS) continue
            ctx.logger.warn(`${PLUGIN_NAME}: ${errorText(error)}`)
            // 已告警仍抛出：调用方按需处理（RPC 回传错误 / 事件侧吞掉），不静默吞错
            throw error
        }
    }
    // 不可达：循环内各路径均 return/throw，continue 仅在 attempt < MAX_ATTEMPTS 时发生；仅作类型收敛
    return 0
}
