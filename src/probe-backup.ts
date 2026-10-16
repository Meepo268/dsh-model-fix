/**
 * 「探测式填充」的崩溃兜底备份：探测开始前把 `llm-pi-ai` 的**整段 providers** 压成一个字符串存进自有段，
 * 收敛落盘后立刻删掉；插件启动末尾若还留着它，说明上一轮探测没能收尾，按这份备份把配置回退一次。
 *
 * 设计裁决（整段备份理由、deflateRaw+base64、顶层键不进快照、收尾窗口代价）见 docs/decisions.md「探测式填充」。
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { MAX_ATTEMPTS } from '@/constants'
import { API_NS, PLUGIN_NAME, PLUGIN_NS } from '@/shared/constants'
import { isPlainObject, providersOf } from '@/shared/types'
import { planRestore } from '@/restore'
import { endIgnoreAll, startIgnoreAll } from '@/guard'
import { queueTask } from '@/host'
import { descriptorOf, ownSection } from '@/section'
import { isSettingsConflict } from '@/shared/errors'

/** 自有段里存这份备份的键（顶层，与 `version-N` 同级） */
const PROBE_BACKUP_KEY = 'probeBackup'

/** 整段 providers 压成一个字符串（JSON → deflateRaw → base64）；纯函数，可单测 */
export function encodeProbeBackup(providers: Record<string, unknown>): string {
    return Buffer.from(deflateRawSync(Buffer.from(JSON.stringify(providers), 'utf8'))).toString('base64')
}

/** 解码备份：非字符串、空串、解压失败、JSON 不成立或不是普通对象，一律 undefined（读取侧永不抛） */
export function decodeProbeBackup(text: unknown): Record<string, unknown> | undefined {
    if (typeof text !== 'string' || text.length === 0) return undefined
    try {
        const parsed: unknown = JSON.parse(inflateRawSync(Buffer.from(text, 'base64')).toString('utf8'))
        return isPlainObject(parsed) ? parsed : undefined
    } catch {
        return undefined
    }
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
 * 探测开始前落备份。**失败即中止整轮**：没有退路就不动用户配置（预声明一旦写下就可能来不及收回）。
 * 调用方（`probeAndFill`）已持有事件流守卫，本函数不碰守卫。
 */
export async function saveProbeBackup(ctx: Context): Promise<void> {
    const providers = providersOf(descriptorOf(ctx, API_NS)?.user)
    if (!providers) throw new Error(`${PLUGIN_NAME}: 当前 ${API_NS} 无 providers 段，无法生成探测前的兜底备份`)
    const text = encodeProbeBackup(providers)
    await mutateOwn(ctx, [{ op: 'set', path: [PROBE_BACKUP_KEY], value: text }])
    ctx.logger.info(`${PLUGIN_NAME}: 已存下探测前的配置兜底备份（${Object.keys(providers).length} 个提供方，${text.length} 字符）`)
}

/** 收敛落盘后清备份；调用方持有守卫。清理失败不在此抛，由调用方决定降级 */
export function clearProbeBackup(ctx: Context): Promise<void> {
    return mutateOwn(ctx, [{ op: 'unset', path: [PROBE_BACKUP_KEY] }])
}

/**
 * 按备份回退模型（与「恢复备份」同一 `planRestore` 口径：回退共有 provider 的共有 model，不复活被删的 provider、
 * 不覆盖新增；探测本身不删模型，故这条路径上不会触发 model 复活）。
 *
 * 刻意**不走** `src/writeback.ts` 的写回外壳：本回退不打任何逐次日志（成败由启动链末尾统一汇报一条），
 * 套壳会凭空多出「零变更」与「失败第 n 次」两条告警。
 */
async function restoreProviders(ctx: Context, backup: Record<string, unknown>): Promise<number> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (!ctx.fiber.store) return 0
        const descriptor = descriptorOf(ctx, API_NS)
        const providers = providersOf(descriptor?.user)
        // 与 restoreModels 同理：读不到段时显式失败，返回 0 会被当成「本就一致」而静默吞掉真故障
        if (!providers) throw new Error(`${PLUGIN_NAME}: 当前 ${API_NS} 无 providers 段，无法回退`)
        const { modelOps, changed } = planRestore(backup, providers)
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
 * 启动末尾的崩溃回退：段里没有备份即无事可做（本轮没探测过，或上一轮正常收尾）；
 * 有则按备份回退并清掉备份，返回被回退的模型数（0 = 无可回退或本就一致）。
 * 回退期间持事件流守卫——写回触发的段变更事件必须被入口拦下，否则 `fix` 会在回退途中把预声明又填回来。
 * **恢复成功才清备份**：清除失败只是下次启动再回退一次（幂等、零 op），反过来先清则备份永久丢失。
 */
export async function restoreProbeBackup(ctx: Context): Promise<number> {
    const section = ownSection(ctx)
    const raw = section?.[PROBE_BACKUP_KEY]
    if (raw === undefined) return 0
    const backup = decodeProbeBackup(raw)
    if (!backup) {
        ctx.logger.warn(`${PLUGIN_NAME}: 遗留的探测兜底备份无法解码，已丢弃（不回退任何模型）`)
        await clearProbeBackup(ctx)
        return 0
    }
    startIgnoreAll()
    try {
        const changed = await restoreProviders(ctx, backup)
        await clearProbeBackup(ctx)
        if (changed > 0) ctx.logger.warn(`${PLUGIN_NAME}: 检测到上次探测式填充未收尾，已按备份回退 ${changed} 个模型`)
        return changed
    } finally {
        endIgnoreAll()
    }
}