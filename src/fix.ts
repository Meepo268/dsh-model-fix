import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { getCatalog } from '@/catalog'
import { planProviderCompat } from '@/compat'
import { toReasoningEfforts, toReasoningEffortsFromList } from '@/lookup'
import { resolveSource } from '@/source'
import { COMPAT_APIS, MAX_ATTEMPTS } from '@/constants'
import { API_NS, PLUGIN_NAME, PLUGIN_NS } from '@/shared/constants'
import { CONFIG_VERSION, versionKey } from '@/shared/config-schema'
import { getConfig } from '@/config'
import { stripEmptyFields } from '@/empty'
import { queueTask } from '@/host'
import { isCapacity, type IndexedCatalog } from '@/types'
import { fieldStampsOf, isPluginWritten, mayReplace, parseStamps, stampPatched, stampSource, withStamps, writtenOf, type StampField, type StampSource } from '@/stamp'
import { isPlainObject, providersOf, type CompatRules, type PluginConfig, type WrittenMap } from '@/shared/types'
import { descriptorOf } from '@/section'
import { fetchDeclarations, type DeclarationMap } from '@/upstream'
import { errorText, isSettingsConflict } from '@/shared/errors'

/** 指纹字段 -> 配置里的字段开关（上下文窗口与输出上限同受 context 开关管） */
const RULE_OF = {
    r: 'reasoning',
    c: 'context',
    m: 'context',
    i: 'image',
} as const

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
    /** 本轮写入后的参数指纹表（写进插件自有段的 `written` 键，用来区分插件写的与手改的） */
    readonly written: WrittenMap
    /** 本轮需要落盘的指纹条数（0 = 不必写插件段） */
    readonly stamps: number
}

/** 纯计划函数（零 ctx、可单测）：遍历提供方算出模型参数 op 与路由 compat op；`excludes` 命中者在入口整条跳过；`efforts` 记忆不在本文件处理。
 * 参数来源按 `resolveSource` 的优先级取（人工 pin > 上游声明 > 目录），`looseMatch` 传给 lookup 的兜底阶段 */
export function planFill(
    cfg: PluginConfig,
    providers: Record<string, unknown>,
    indexed: IndexedCatalog,
    force: boolean,
    declarations?: DeclarationMap,
): FillPlan {
    const allowRules = cfg.allowUpdate
    const autoRules = cfg.autoFill
    const compatRules = cfg.compat
    // 提供方级排除：命中的 id 整条跳过（模型写回与路由 compat 都不作用其上）
    const excludes = new Set(cfg.excludes)
    const ops: SettingsPathOp[] = []
    let changes = 0
    let compatChanges = 0
    let excluded = 0
    let written = cfg.written
    let stamps = 0
    for (const [providerId, provider] of Object.entries(providers)) {
        if (excludes.has(providerId)) {
            excluded++
            continue
        }
        if (!isPlainObject(provider)) continue
        const { api, models, compat: currentCompat, baseURL } = provider as { api?: unknown; models?: unknown; compat?: unknown; baseURL?: unknown }
        if (Array.isArray(models)) {
            let next: Record<string, unknown>[] | undefined
            for (let i = 0; i < models.length; i++) {
                const model = models[i]
                if (!isPlainObject(model) || model.id === undefined || model.id === null) continue
                const modelId = String(model.id)
                // 缺失补写按剔除空壳后的值认（空壳等同未声明，否则既不被填又被清、要等下一轮才补上）
                const cleaned = stripEmptyFields(model)
                const { reasoningEfforts, contextWindow, maxTokens } = cleaned as {
                    reasoningEfforts?: unknown
                    contextWindow?: unknown
                    maxTokens?: unknown
                }
                // 参数来源（见 src/source.ts）：pin 决定认哪一侧，缺省走「上游声明 > 目录」；
                // 显示名只用于兜底匹配（nameFallback 开时才试）
                const { entry, declared, pin } = resolveSource(
                    cfg,
                    indexed,
                    declarations,
                    providerId,
                    typeof baseURL === 'string' ? baseURL : undefined,
                    modelId,
                    typeof model.name === 'string' ? model.name : undefined,
                )
                // 人工指定过来源的模型按用户意图整体生效：不再受指纹冻结（选来源就是要它落下来），但仍记新指纹
                const pinned = pin !== ''
                const declaredEfforts = toReasoningEffortsFromList(declared?.efforts)
                const catalogEfforts = toReasoningEfforts(entry)
                const efforts = declaredEfforts ?? catalogEfforts
                const effortsFrom: StampSource | undefined = declaredEfforts !== undefined ? 'u' : catalogEfforts !== undefined ? 'c' : undefined
                // 图片模态同上：判据取自 cleaned.input
                const input = cleaned.input
                const imageValue = toInputValue(declared?.image ?? entry?.image)
                const imageFrom: StampSource | undefined = declared?.image !== undefined ? 'u' : entry?.image !== undefined ? 'c' : undefined
                // 指纹口径：逐字段判断「这行还是插件上次写的那一版」，手改过的字段不再被自动来源覆盖（见 src/stamp.ts）
                const stampsNow = fieldStampsOf(cleaned)
                const previous = parseStamps(writtenOf(cfg.written, providerId, modelId))
                const pluginWrote = (field: StampField): boolean =>
                    isPluginWritten(cfg.written, providerId, modelId, field, stampsNow)
                /** 已有值可被自动来源覆盖的条件：强制更新单次全放开；人工指定过来源的模型整体放开；否则该字段的
                 * 「允许更新」开着、仍是插件写的，且新来源等级更高（只有「目录 → 上游声明」这一种升级，同级不再刷新——
                 * 值一旦写过就锁定，要换用「强制更新」） */
                const editable = (field: StampField, source: StampSource | undefined): boolean =>
                    force || pinned || (allowRules[RULE_OF[field]] && pluginWrote(field) && mayReplace(stampSource(previous, field), source))
                // 推理级别
                const reasoningFillable = autoRules.reasoning
                    && reasoningEfforts === undefined && !!efforts
                const reasoningUpdatable = editable('r', effortsFrom)
                    && isPlainObject(efforts)
                    && !deepEqualJson(reasoningEfforts, efforts)
                // 容量新值须为正整数且非哨兵（写 0 会被宿主 schema 拒绝并连累整批写入）
                const ctxW = declared?.contextWindow ?? entry?.contextWindow
                const maxT = declared?.maxTokens ?? entry?.maxTokens
                const ctxFrom: StampSource | undefined = declared?.contextWindow !== undefined ? 'u' : entry?.contextWindow !== undefined ? 'c' : undefined
                const maxFrom: StampSource | undefined = declared?.maxTokens !== undefined ? 'u' : entry?.maxTokens !== undefined ? 'c' : undefined
                const contextFillable = autoRules.context
                    && contextWindow === undefined && isCapacity(ctxW)
                const contextUpdatable = editable('c', ctxFrom)
                    && ctxW !== contextWindow
                    && isCapacity(ctxW)
                const maxTokensFillable = autoRules.context
                    && maxTokens === undefined && isCapacity(maxT)
                const maxTokensUpdatable = editable('m', maxFrom)
                    && maxT !== maxTokens
                    && isCapacity(maxT)
                const imageFillable = autoRules.image
                    && input === undefined && !!imageValue
                const imageUpdatable = editable('i', imageFrom)
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
                // 记下「这行现在是插件写的样子」：只覆盖本轮写过的字段，其余保留旧指纹（旧值为 null 即从不是插件写的）
                const writtenFields: Partial<Record<StampField, StampSource>> = {}
                if (reasoningFillable || reasoningUpdatable) writtenFields.r = effortsFrom
                if (contextFillable || contextUpdatable) writtenFields.c = ctxFrom
                if (maxTokensFillable || maxTokensUpdatable) writtenFields.m = maxFrom
                if (imageFillable || imageUpdatable) writtenFields.i = imageFrom
                const stamped = withStamps(written, providerId, modelId, stampPatched(previous, patched, writtenFields))
                if (stamped !== written) {
                    written = stamped
                    stamps++
                }
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
    return { ops, changes, compatChanges, excluded, written, stamps }
}

/** 把本轮写入的参数指纹落到插件自有段的 `written` 键（与 `efforts` 记忆同级）；失败只告警，不影响本次填充 */
async function persistStamps(ctx: Context, written: WrittenMap): Promise<void> {
    const descriptor = descriptorOf(ctx, PLUGIN_NS)
    if (!descriptor) return
    try {
        await queueTask(() => ctx.settings.mutate(
            PLUGIN_NS,
            [{ op: 'set', path: [versionKey(CONFIG_VERSION), 'written'], value: written }],
            descriptor.revision,
        ))
    } catch (error) {
        ctx.logger.warn(`${PLUGIN_NAME}: 参数指纹落盘失败（下一轮将按手改保守处理）：${errorText(error)}`)
    }
}

/** 填充与写回：读最新段 → `planFill` 出计划 → 写 `llm-pi-ai` → 返回变更模型数（不含 compat 计数，保持 RPC 契约）
 * 写回失败先告警再抛出；冲突限次重试时重读整段。刻意不走 writeback.ts 外壳（守卫与端点骨架不同形，理由见该文件头） */
export async function fix(ctx: Context, force = false): Promise<number> {
    // 上游声明只在本次修复内抓一次：冲突重试沿用同一份（同一批 providers 不会变），避免连续打端点
    let declarations: DeclarationMap | undefined
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // 卸载后不再碰 settings（服务已 dispose，访问即抛 inactive context）
        if (!ctx.fiber.store) return 0
        const descriptor = descriptorOf(ctx, API_NS)
        if (!descriptor) return 0
        const providers = providersOf(descriptor.user)
        if (!providers) return 0
        const cfg = getConfig()
        declarations ??= await fetchDeclarations(ctx, providers)
        const plan = planFill(cfg, providers, getCatalog(), force, declarations)
        if (plan.ops.length === 0) return 0
        try {
            await queueTask(() => ctx.settings.mutate(API_NS, plan.ops, descriptor.revision))
            ctx.logger.info(`${PLUGIN_NAME}: 已变更 ${plan.changes} 个模型（补充/同步推理级别、容量字段、图片模态、清理空字段）、${plan.compatChanges} 个提供方的兼容性优化，跳过 ${plan.excluded} 个已排除提供方`)
            // 指纹落盘失败不算填充失败：下一轮只会把这些行当手改（更保守），不会乱写
            if (plan.stamps > 0) await persistStamps(ctx, plan.written)
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
