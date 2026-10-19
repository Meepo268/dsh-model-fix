import { API_NS, PLUGIN_NAME } from '@/shared/constants'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { isPlainObject, providersOf } from '@/shared/types'
import { stripEmptyFields } from '@/empty'
import { descriptorOf } from '@/section'
import { errorText } from '@/shared/errors'
import { guardedWritebackApi } from '@/writeback'

/** 启动时捕获的 `llm-pi-ai` providers 段深拷贝（仅存内存，重启即重建；恢复只回退到本备份） */
let backup: Record<string, unknown> | undefined

/** 捕获启动备份（只允许在 apply 最顶部调一次——晚于写回的补捕会把填充过的内容当原值恢复，比没有更危险；
 * 取不到仅告警，该次运行恢复时显式报错；重复 apply 不覆盖首启动备份） */
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

/** 恢复计划（纯函数、可单测）：共有 provider 的共有 model 回退到备份值 + 该 provider 下被删 model 复活（按备份原序追加末尾）；
 * 被整删 provider 与启动后新增一律跳过；恢复值过 `stripEmptyFields`；`models` 键缺失视作「删光」；零差异不产 op；`changed` = 回退 + 复活数 */
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
        // 当前 models 键缺失/null＝删光按空数组处理（可全部复活）；其他非数组值（损坏）跳过，与备份侧同口径
        const rawCurrentModels = currentProvider.models
        if (rawCurrentModels !== undefined && rawCurrentModels !== null && !Array.isArray(rawCurrentModels)) continue
        const currentModels: Record<string, unknown>[] = Array.isArray(rawCurrentModels) ? rawCurrentModels : []
        const backupById = new Map<string, Record<string, unknown>>()
        for (const m of backupModels) {
            if (isPlainObject(m) && m.id !== undefined && m.id !== null) backupById.set(String(m.id), m)
        }
        const restored = currentModels.map((m) => {
            if (!isPlainObject(m) || m.id === undefined || m.id === null) return m
            const hit = backupById.get(String(m.id))
            // 恢复值过空壳清理（空壳留着等于把脏值写回去）；清理后与当前值相同视为「无可恢复」
            return hit === undefined ? m : stripEmptyFields(structuredClone(hit))
        })
        // 复活备份有而当前没有的 model（按 backupById 原序追加末尾，与回退共用同一份备份值）
        const presentIds = new Set<string>()
        for (const m of restored) {
            if (isPlainObject(m) && m.id !== undefined && m.id !== null) presentIds.add(String(m.id))
        }
        for (const [id, hit] of backupById) {
            if (presentIds.has(id)) continue
            presentIds.add(id)
            restored.push(stripEmptyFields(structuredClone(hit)))
        }
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

/** 恢复备份（语义见 planRestore）：全程持事件流守卫；返回回退与复活的模型数，写失败先告警再抛出 */
export async function restoreModels(ctx: Context): Promise<number> {
    // 备份缺失必须显式失败：回 0 会被显示成「已恢复 0 个模型」，与「确无可恢复」无法区分
    if (backup === undefined) throw new Error(`${PLUGIN_NAME}: 启动时未捕获到备份，本次运行无法恢复`)
    const { changed } = await guardedWritebackApi(ctx, {
        label: '恢复备份',
        unreadableProviders: () => {
            throw new Error(`${PLUGIN_NAME}: 当前 ${API_NS} 无 providers 段，无法恢复`)
        },
        plan: ({ providers }) => planRestore(backup, providers),
        noChange: '恢复备份：无可恢复的模型',
        done: ({ changed }) => `已恢复备份中的 ${changed} 个模型`,
    })
    return changed
}
