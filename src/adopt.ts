/** 模型上新：把勾选的「待上线」追加进模型列表，未勾选的一律记进 `known`（等价于逐个「忽略」）。
 *  写回形状要点：宿主的 `providers[p].models` 是**数组**（元素 `{ id, name, … }`），
 *  既不能按 id 拼深路径（会被当数组下标：`Config array index "cn:x" is out of range`），
 *  也不能整对象覆盖（`expected array but got [object Object]`）。只能读出数组、追加、整数组写回。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { API_NS, PLUGIN_NAME, PLUGIN_NS } from '@/shared/constants'
import { CONFIG_VERSION, versionKey } from '@/shared/config-schema'
import { descriptorOf } from '@/section'
import { resolveConfig } from '@/config'
import { fix } from '@/fix'
import { queueTask } from '@/host'
import { isPlainObject, providersOf } from '@/shared/types'

/** 一条待上线的定位 */
export interface PendingRef {
    provider: string
    model: string
}

/** 一键上线结果：本轮真正追加进列表的 id（已在列表里的不算） */
export interface AdoptResult {
    added: string[]
    /** 本轮按「未勾选 = 忽略」记进 known 的 id */
    ignored: string[]
}

/** 一键上线：追加勾选的条目，未勾选的在同一次写回里记为已知；随后跑一轮填充补参数 */
export async function adoptPending(ctx: Context, picked: readonly PendingRef[]): Promise<AdoptResult> {
    const plugin = descriptorOf(ctx, PLUGIN_NS)
    if (!plugin) throw new Error(`${PLUGIN_NAME}: 自有配置段 ${PLUGIN_NS} 不可读`)
    const api = descriptorOf(ctx, API_NS)
    if (!api) throw new Error(`${PLUGIN_NAME}: 配置段 ${API_NS} 不可读`)
    const config = resolveConfig(plugin.user)
    const providers = providersOf(api.user) ?? {}
    const wanted = picked.filter(({ provider, model }) => config.pending[provider]?.[model] !== undefined)
    const wantedKeys = new Set(wanted.map(({ provider, model }) => `${provider}\u0000${model}`))

    // 未勾选的一律算忽略：pending 里除勾选外的全部 id
    const known: Record<string, string[]> = {}
    const ignored: string[] = []
    for (const [providerId, entries] of Object.entries(config.pending)) {
        const kept = [...(config.known[providerId] ?? [])]
        for (const id of Object.keys(entries)) {
            if (wantedKeys.has(`${providerId}\u0000${id}`)) continue
            ignored.push(id)
            if (!kept.includes(id)) kept.push(id)
        }
        if (ignored.length > 0 || config.known[providerId] !== undefined) known[providerId] = kept
    }
    // 勾选的也记进已知：免得下一轮上游再报一次（列表里已有，roster 也会补记，这里显式落一次更稳）
    for (const { provider, model } of wanted) {
        const kept = known[provider] ?? [...(config.known[provider] ?? [])]
        if (!kept.includes(model)) kept.push(model)
        known[provider] = kept
    }

    // 追加到各自的 models 数组（同一提供方只写一次）
    const byProvider = new Map<string, string[]>()
    for (const { provider, model } of wanted) {
        byProvider.set(provider, [...(byProvider.get(provider) ?? []), model])
    }
    const ops: SettingsPathOp[] = []
    const added: string[] = []
    for (const [providerId, ids] of byProvider) {
        const profile = providers[providerId]
        if (!isPlainObject(profile)) continue
        const list = Array.isArray(profile.models) ? profile.models.slice() : []
        const present = new Set(
            list.filter((row): row is Record<string, unknown> => isPlainObject(row))
                .map((row) => row.id)
                .filter((id): id is string => typeof id === 'string'),
        )
        let touched = false
        for (const id of ids) {
            if (present.has(id)) continue
            const name = config.pending[providerId]?.[id]?.name
            list.push(name === undefined || name === id ? { id } : { id, name })
            added.push(id)
            touched = true
        }
        if (touched) ops.push({ op: 'set', path: ['providers', providerId, 'models'], value: list })
    }

    if (ops.length > 0) await queueTask(() => ctx.settings.mutate(API_NS, ops, api!.revision))
    // pending 清空、known 补记：一次整对象写回
    await queueTask(() => ctx.settings.mutate(PLUGIN_NS, [
        { op: 'set', path: [versionKey(CONFIG_VERSION), 'known'], value: known },
        { op: 'set', path: [versionKey(CONFIG_VERSION), 'pending'], value: {} },
    ], plugin.revision))

    // 新条目的参数由既有填充补齐
    if (added.length > 0) await fix(ctx)
    return { added, ignored }
}
