import { API_NS, PLUGIN_NAME } from '@/shared/constants'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { isPlainObject, providersOf } from '@/shared/types'
import { stripEmptyFields } from '@/empty'
import { descriptorOf } from '@/section'
import { errorText } from '@/shared/errors'
import { guardedWritebackApi } from '@/writeback'

/**
 * 插件启动时捕获的 `llm-pi-ai` 备份：该 NS user 层 `providers` 段的深拷贝（只读缓存，不写盘）。
 * 由 apply 在一切写回路径之前同步读取一次；重启即重建。恢复只回退到本备份对应的状态。
 */
let backup: Record<string, unknown> | undefined

/**
 * 捕获启动时备份：读 `llm-pi-ai` user 层的 `providers` 段（收窄口径见 src/shared/types.ts 的 `providersOf`）
 * 并深拷贝缓存，仅存内存。
 * **只允许在 apply 最顶部调用一次**——备份的语义是"插件动手前"，晚于任何写回的补捕会存进已被填充的
 * 内容，那种备份比没有备份更危险（静默把改后值当原值恢复）。取不到仅告警，该次运行的恢复明确报错。
 * `backup !== undefined` 早退是为 HMR 重复 apply 时不用改后内容覆盖首启动的备份。
 */
export function captureBackup(ctx: Context): void {
    if (backup !== undefined) return
    try {
        const apiDescriptor = descriptorOf(ctx, API_NS)
        const providers = providersOf(apiDescriptor?.user)
        if (!providers) {
            ctx.logger.warn(`${PLUGIN_NAME}: 未能捕获启动时备份（${API_NS} 不可读或无 providers 段），本次运行「恢复备份」不可用`)
            return
        }
        backup = structuredClone(providers)
        ctx.logger.info(`${PLUGIN_NAME}: 已捕获启动时备份（${Object.keys(backup).length} 个提供方）`)
    } catch (error) {
        ctx.logger.warn(`${PLUGIN_NAME}: 捕获启动时配置备份失败（恢复功能不可用）：${errorText(error)}`)
        backup = undefined
    }
}

/**
 * 恢复计划（纯函数，零 ctx 依赖可单测）：
 * 对「备份与当前都存在」的 provider，回退其共有 model，并把该 provider 下被删掉的 model 复活；
 * 被整删的 provider（其 api-key 随之没了）与启动后新增的 provider 一律跳过（不复活 provider、不覆盖新增）。
 * 对该 provider 重建 models 数组：共有 model 用备份值（深拷贝后按 `stripEmptyFields` 清掉空壳字段，
 * 空壳在 harness 语义上等同未声明，带回来只是把脏值原样复刻），当前独有 model 原样保留，
 * 备份独有 model 按备份原序追加到末尾。当前 provider 的 `models` 键缺失视为「模型被删光」，按空数组处理。
 * 仅当重建结果与该 provider 当前 models 有差异才产出整段 set op（零变更零 op）。
 * 返回 { modelOps, changed }，changed 为被回退（值不同于当前）与被复活的模型数。
 */
export function planRestore(
    backupProviders: Record<string, unknown> | undefined,
    currentProviders: Record<string, unknown>,
): { modelOps: SettingsPathOp[]; changed: number } {
    const modelOps: SettingsPathOp[] = []
    let changed = 0
    if (!isPlainObject(backupProviders)) return { modelOps, changed }
    for (const [providerId, backupProvider] of Object.entries(backupProviders)) {
        if (!isPlainObject(backupProvider)) continue
        const currentProvider = currentProviders[providerId]
        if (!isPlainObject(currentProvider)) continue
        const backupModels = backupProvider.models
        if (!Array.isArray(backupModels)) continue
        // 当前 models 键缺失或为 null＝模型被删光，按空数组处理（可全部复活）；
        // 非数组的其他值（损坏）维持跳过，与备份侧同一口径
        const rawCurrentModels = currentProvider.models
        if (rawCurrentModels !== undefined && rawCurrentModels !== null && !Array.isArray(rawCurrentModels)) continue
        const currentModels: Record<string, unknown>[] = Array.isArray(rawCurrentModels) ? rawCurrentModels : []
        // 交集 model id -> 备份值；当前独有 model id -> 原样保留
        const backupById = new Map<string, Record<string, unknown>>()
        for (const m of backupModels) {
            if (isPlainObject(m) && m.id !== undefined && m.id !== null) backupById.set(String(m.id), m)
        }
        const restored = currentModels.map((m) => {
            if (!isPlainObject(m) || m.id === undefined || m.id === null) return m
            const hit = backupById.get(String(m.id))
            // 恢复值同样过一遍空壳清理：备份是插件动手前的原样，空壳留着等于把它又写回去；
            // 清理后与当前值相同即视为「无可恢复」，不产出 op（零变更零 op）
            return hit === undefined ? m : stripEmptyFields(structuredClone(hit))
        })
        // 复活：备份有而当前没有的 model，provider 仍在即恢复，按备份原序追加到末尾。
        // 遍历 backupById 而非 backupModels：与回退共用同一份备份值，否则同一 model 可能被写成两个取值
        const presentIds = new Set<string>()
        for (const m of restored) {
            if (isPlainObject(m) && m.id !== undefined && m.id !== null) presentIds.add(String(m.id))
        }
        for (const [id, hit] of backupById) {
            if (presentIds.has(id)) continue
            presentIds.add(id)
            restored.push(stripEmptyFields(structuredClone(hit)))
        }
        // 逐个比较（判据取 @deepseek-ai/dsh-util-values 的 deepEqualJson）：值被改写或有 model 被复活才产出 op
        let touched = 0
        for (let i = 0; i < currentModels.length; i++) {
            if (!deepEqualJson(currentModels[i], restored[i])) touched++
        }
        const revived = restored.length - currentModels.length
        if (touched === 0 && revived === 0) continue
        modelOps.push({ op: 'set', path: ['providers', providerId, 'models'], value: restored })
        changed += touched + revived
    }
    return { modelOps, changed }
}

/**
 * 恢复备份：把各共有 provider 的模型回退到启动时备份值，并复活其下被删的 model（语义见 planRestore）。
 * 事件流守卫全程打开，写回触发的 settings/document-updated 事件被入口判定拦下，不会反向触发填充。
 * 返回被回退与被复活的模型数；写失败先告警再抛出，由调用方转 RPC 失败结果。
 */
export async function restoreModels(ctx: Context): Promise<number> {
    // 备份缺失（启动时捕获失败）必须显式失败：返回 0 会被前端显示成「已恢复 0 个模型」，
    // 与「确实无可恢复」无法区分，用户会误以为按钮坏了或数据本就一致。
    if (backup === undefined) throw new Error(`${PLUGIN_NAME}: 启动时未捕获到备份，本次运行无法恢复`)
    const { changed } = await guardedWritebackApi(ctx, {
        label: '恢复备份',
        // 当前段不可读时同样显式失败：返回 0 会被显示成「已恢复 0 个模型」，掩盖真实故障
        unreadableProviders: () => {
            throw new Error(`${PLUGIN_NAME}: 当前 ${API_NS} 无 providers 段，无法恢复`)
        },
        plan: ({ providers }) => planRestore(backup, providers),
        noChange: '恢复备份：无可恢复的模型',
        done: ({ changed }) => `已恢复备份中的 ${changed} 个模型`,
    })
    return changed
}
