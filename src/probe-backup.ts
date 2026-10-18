/**
 * 「探测档位」的崩溃兜底备份：探测开始前把**探测目标的档位表原值**存进自有段，
 * 启动末尾若还留着它，说明上一轮探测没能收尾，按这份备份把那些档位表撤回去。
 *
 * 备份只覆盖预声明动过的那一个字段：既不碰其他模型、也不碰同一模型的其他字段，更不会复活
 * 用户在探测期间删掉的模型。设计裁决见 docs/decisions.md「探测档位」。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { MAX_ATTEMPTS } from '@/constants'
import { API_NS, PLUGIN_NAME, PLUGIN_NS } from '@/shared/constants'
import { isPlainObject, providersOf } from '@/shared/types'
import type { EffortApply } from '@/fill'
import { stripEmptyFields } from '@/empty'
import { startIgnoreAll, endIgnoreAll } from '@/guard'
import { queueTask } from '@/host'
import { descriptorOf, ownSection } from '@/section'
import { isSettingsConflict } from '@/shared/errors'

/** 自有段里存这份备份的键（顶层，与 `version-N` 同级） */
const PROBE_BACKUP_KEY = 'probeBackup'

/** 回退只动这一个模型字段 */
const FILL_FIELD = 'reasoningEfforts'

/** 备份的形状：提供方 id → 模型 id → 该模型 `reasoningEfforts` 的**原值**深拷贝；
 * `null` 哨兵表示「探测前就没有该字段」，回退时删键而不是写回 null。 */
type ProbeBackup = Record<string, Record<string, unknown>>

/** 「提供方 / 模型」二元组键：模型 id 可含 '/'，故用序列化而非字符串拼接（与 fill.ts 同口径） */
function targetKey(provider: string, model: string): string {
    return JSON.stringify([provider, model])
}

/** 采集探测目标的档位表原值：只认当前存在的目标模型，逐字深拷贝（保留用户自己的 wire 拼写） */
export function captureProbeBackup(
    providers: Record<string, unknown>,
    targets: readonly EffortApply[],
): ProbeBackup {
    const wanted = new Map<string, string>()
    for (const target of targets) wanted.set(targetKey(target.provider, target.model), target.model)
    const backup: ProbeBackup = {}
    for (const [providerId, provider] of Object.entries(providers)) {
        if (!isPlainObject(provider) || !Array.isArray(provider.models)) continue
        for (const model of provider.models) {
            if (!isPlainObject(model) || typeof model.id !== 'string') continue
            if (!wanted.has(targetKey(providerId, model.id))) continue
            const rows = backup[providerId] ??= {}
            rows[model.id] = isPlainObject(model[FILL_FIELD]) ? structuredClone(model[FILL_FIELD]) : null
        }
    }
    return backup
}

/** 备份落自有段前的形态：JSON → base64 字符串。只编码不压缩，理由见 docs/decisions.md「探测档位」 */
export function encodeProbeBackup(backup: ProbeBackup): string {
    return Buffer.from(JSON.stringify(backup), 'utf8').toString('base64')
}

/** 解码备份：非字符串、空串、base64 解出不是合法 JSON、顶层不是普通对象，一律 undefined（读取侧永不抛） */
export function decodeProbeBackup(text: unknown): ProbeBackup | undefined {
    if (typeof text !== 'string' || text.length === 0) return undefined
    let parsed: unknown
    try {
        parsed = JSON.parse(Buffer.from(text, 'base64').toString('utf8'))
    } catch {
        return undefined
    }
    if (!isPlainObject(parsed)) return undefined
    const backup: ProbeBackup = {}
    for (const [providerId, models] of Object.entries(parsed)) {
        if (!isPlainObject(models)) return undefined
        backup[providerId] = { ...models }
    }
    return backup
}

/**
 * 回退计划（纯函数，零 ctx 依赖可单测）：
 * 把备份里那些**当前仍在**的模型的档位表整字段写回原值；提供方被整删、模型被删都跳过（不复活），
 * 同一模型的其余字段原样保留。遍历的是当次现读的 `providers`，故备份里没有的（窗口内新增）不会被删。
 * 写入前过 `stripEmptyFields`（与另几条写回路径同一判据）：探测前若只剩 off，恢复后按统一口径清成未声明。
 * 仅当某 provider 至少改写一个模型时才产出整段 set op（零变更零 op）。
 *
 * @returns `{ modelOps, changed }`，`changed` 为被撤掉预声明的模型数
 */
function planProbeRestore(
    backup: ProbeBackup,
    providers: Record<string, unknown>,
): { modelOps: SettingsPathOp[]; changed: number } {
    const modelOps: SettingsPathOp[] = []
    let changed = 0
    for (const [providerId, savedModels] of Object.entries(backup)) {
        const provider = providers[providerId]
        if (!isPlainObject(provider) || !Array.isArray(provider.models)) continue
        const list = provider.models
        let next: Record<string, unknown>[] | undefined
        for (let i = 0; i < list.length; i++) {
            const model = list[i]
            if (!isPlainObject(model) || typeof model.id !== 'string') continue
            if (!Object.hasOwn(savedModels, model.id)) continue
            const saved = savedModels[model.id]
            // 幂等：档位表已与备份一致（常见于收敛已落盘、只差清备份就被杀）即零变更
            if (deepEqualJson(model[FILL_FIELD] ?? null, saved)) continue
            next ??= list.slice()
            const replaced = { ...model }
            if (saved === null) delete replaced[FILL_FIELD]
            else replaced[FILL_FIELD] = saved
            next[i] = stripEmptyFields(replaced)
            changed++
        }
        if (next) modelOps.push({ op: 'set', path: ['providers', providerId, 'models'], value: next })
    }
    return { modelOps, changed }
}

/** 写自有段（冲突重试，读回最新 revision 后重发同一组 op——备份与清除都是幂等的） */
async function mutateOwn(ctx: Context, ops: readonly SettingsPathOp[]): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (!ctx.fiber.store) throw new Error(`${PLUGIN_NAME}: 插件已卸载`)
        const descriptor = descriptorOf(ctx, PLUGIN_NS)
        if (!descriptor) throw new Error(`${PLUGIN_NAME}: 自有配置段 ${PLUGIN_NS} 不可读`)
        try {
            await queueTask(() => ctx.settings.mutate(PLUGIN_NS, [...ops], descriptor.revision))
            return
        } catch (error) {
            if (isSettingsConflict(error) && attempt < MAX_ATTEMPTS) continue
            throw error
        }
    }
    throw new Error(`${PLUGIN_NAME}: 写入探测备份冲突重试耗尽`)
}

/**
 * 探测开始前落备份。**失败即中止整轮**：没有退路就不动用户配置。调用方（`probeAndFill`）已持有事件流守卫。
 *
 * @param targets - 本轮探测的目标清单：备份范围就是它
 */
export async function saveProbeBackup(ctx: Context, targets: readonly EffortApply[]): Promise<void> {
    const providers = providersOf(descriptorOf(ctx, API_NS)?.user)
    if (!providers) throw new Error(`${PLUGIN_NAME}: 当前 ${API_NS} 无 providers 段，无法生成探测前的兜底备份`)
    const backup = captureProbeBackup(providers, targets)
    const text = encodeProbeBackup(backup)
    await mutateOwn(ctx, [{ op: 'set', path: [PROBE_BACKUP_KEY], value: text }])
    const count = Object.values(backup).reduce((sum, models) => sum + Object.keys(models).length, 0)
    ctx.logger.info(`${PLUGIN_NAME}: 已存下探测前的档位表兜底备份（${count} 个模型，${text.length} 字符）`)
}

/** 收敛落盘后清备份；调用方持有守卫。清理失败不在此抛，由调用方决定降级 */
export function clearProbeBackup(ctx: Context): Promise<void> {
    return mutateOwn(ctx, [{ op: 'unset', path: [PROBE_BACKUP_KEY] }])
}

/** 按备份撤掉预声明（语义见 `planProbeRestore`）。刻意不走 `src/writeback.ts` 的写回外壳：本回退不打任何逐次日志 */
async function restoreProviders(ctx: Context, backup: ProbeBackup): Promise<number> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (!ctx.fiber.store) return 0
        const descriptor = descriptorOf(ctx, API_NS)
        const providers = providersOf(descriptor?.user)
        // 与 restoreModels 同理：读不到段时显式失败，返回 0 会被当成「本就一致」而静默吞掉真故障
        if (!providers) throw new Error(`${PLUGIN_NAME}: 当前 ${API_NS} 无 providers 段，无法回退`)
        const { modelOps, changed } = planProbeRestore(backup, providers)
        if (modelOps.length === 0) return 0
        try {
            await queueTask(() => ctx.settings.mutate(API_NS, modelOps, descriptor?.revision || 0))
            return changed
        } catch (error) {
            if (isSettingsConflict(error) && attempt < MAX_ATTEMPTS) continue
            throw error
        }
    }
    throw new Error(`${PLUGIN_NAME}: 回退探测备份冲突重试耗尽`)
}

/**
 * 启动末尾的崩溃回退：段里没有备份即无事可做；有则按备份撤掉预声明并清掉备份，返回被撤的模型数。
 * 回退全程持事件流守卫（撤预声明那次若被放过去，`fix` 会把预声明又填回来）。
 * 理由见 docs/decisions.md「探测档位」。
 */
export async function restoreProbeBackup(ctx: Context): Promise<number> {
    const section = ownSection(ctx)
    const raw = section?.[PROBE_BACKUP_KEY]
    if (raw === undefined) return 0
    startIgnoreAll()
    try {
        const backup = decodeProbeBackup(raw)
        if (!backup) {
            ctx.logger.warn(`${PLUGIN_NAME}: 遗留的探测兜底备份无法解码，已丢弃（不撤任何预声明）`)
            await clearProbeBackup(ctx)
            return 0
        }
        const changed = await restoreProviders(ctx, backup)
        await clearProbeBackup(ctx)
        if (changed > 0) ctx.logger.warn(`${PLUGIN_NAME}: 检测到上次探测档位未收尾，已撤掉 ${changed} 个模型的预声明档位`)
        return changed
    } finally {
        endIgnoreAll()
    }
}
