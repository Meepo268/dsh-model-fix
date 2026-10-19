import { PLUGIN_NAME, PLUGIN_NS } from '@/shared/constants'
import { resolveConfig } from '@/config'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { PluginConfig } from '@/shared/types'
import { isPlainObject } from '@/shared/types'
import { stripEmptyFields } from '@/empty'
import { descriptorOf } from '@/section'
import { guardedWritebackApi } from '@/writeback'

/** 重置清除的模型字段：仅推理级别——最大上下文 / 输出上限 / 图片模态可在模型页自行设置，不清除 */
const RESET_FIELD = 'reasoningEfforts'

/** 重置推理级别的模型参数计划（纯函数、可单测）：非排除 provider 逐模型仅剔除 `reasoningEfforts`（其余字段原样保留），
 * 带该键的模型所在 provider 才整段重建写回；重建值过 `stripEmptyFields`；配置段（开关）不写；`changed` 为受影响模型数 */
export function planResetModels(config: PluginConfig, providers: Record<string, unknown>): {
    modelOps: SettingsPathOp[]
    changed: number
} {
    const excluded = new Set(config.excludes)
    const modelOps: SettingsPathOp[] = []
    let changed = 0
    for (const [providerId, provider] of Object.entries(providers)) {
        if (excluded.has(providerId)) continue
        if (!isPlainObject(provider)) continue
        const models = provider.models
        if (!Array.isArray(models)) continue
        let next: Record<string, unknown>[] | undefined
        for (let i = 0; i < models.length; i++) {
            const model = models[i]
            if (!isPlainObject(model)) continue
            const kept: Record<string, unknown> = {}
            for (const [key, value] of Object.entries(model)) {
                if (key === RESET_FIELD) continue
                kept[key] = value
            }
            // 触发只看「带没带推理级别」：带空壳字段的模型不算 changed（否则卡片「重置 N 个」虚高）
            if (!Object.hasOwn(model, RESET_FIELD)) continue
            changed++
            next ??= models.slice()
            next[i] = stripEmptyFields(kept)
        }
        if (next) modelOps.push({ op: 'set', path: ['providers', providerId, 'models'], value: next })
    }
    return { modelOps, changed }
}

/** 重置全部推理级别（仅剔除 `reasoningEfforts`，配置段与其余字段原样保留，见 docs/decisions.md「写回端点」）；
 * 全程持事件流守卫，写回触发的事件被入口拦下不会反向填充；返回受影响模型数，写失败先告警再抛出 */
export async function resetModels(ctx: Context): Promise<number> {
    const { changed } = await guardedWritebackApi(ctx, {
        label: '重置',
        // 段不可读即当「本就无可重置」静默早退（与剔除同一口径）
        unreadableProviders: () => ({ modelOps: [], changed: 0 }),
        plan: ({ providers }) => {
            // 当前生效配置（损坏快照回退最高可解析版本/默认，excludes 一并生效）
            const configDescriptor = descriptorOf(ctx, PLUGIN_NS)
            // 自有段不可读时显式失败：回退 DEFAULT_CONFIG 会使 excludes 变空，
            // 重置会作用到用户实际已排除的提供方
            if (!configDescriptor) throw new Error(`${PLUGIN_NAME}: 自有配置段 ${PLUGIN_NS} 不可读，无法重置`)
            return planResetModels(resolveConfig(configDescriptor.user), providers)
        },
        noChange: '重置：无可剔除推理级别的模型',
        done: ({ changed }) => `已重置 ${changed} 个模型的推理级别`,
    })
    return changed
}
