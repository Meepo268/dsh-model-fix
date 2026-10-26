/** 参数来源：解析「这个模型该用谁的参数」。
 *
 * 优先级（见 docs/decisions-config.md「参数来源」）：**手改 > 人工 pin > 上游声明 > models.dev 目录**。
 * pin 的三种取值：缺省 / 空串 = 自动（上游声明 > 目录）；`upstream` = 只认上游声明；`<provider>/<id>` = 只认该目录条目。
 * 本文件只做纯计算（零 ctx），写回在 `fix.ts`；选择来源的 UI 与 RPC 见 `rpc.ts` / 浏览器半。
 */

import { lookup, lookupByName, lookupStripped, normalizeId } from '@/lookup'
import { SOURCE_UPSTREAM, type PluginConfig } from '@/shared/types'
import type { IndexedCatalog, IndexEntry } from '@/types'
import type { Declaration, DeclarationMap } from '@/upstream'

/** 一个模型本轮实际用的来源 */
export interface ResolvedSource {
    /** 生效的 pin 值（自动时为空串） */
    pin: string
    /** 目录条目（pin 为 `upstream` 时为 undefined） */
    entry: IndexEntry | undefined
    /** 上游声明（pin 指向目录条目时为 undefined：用户已明确只要该条目） */
    declared: Declaration | undefined
}

/** 按候选键 `<provider>/<modelId>` 反查目录条目：先按原样查，再按归一化 id 查（目录 `byId` 的键已归一） */
export function entryBySourceKey(indexed: IndexedCatalog, key: string): IndexEntry | undefined {
    const cut = key.indexOf('/')
    if (cut <= 0 || cut === key.length - 1) return
    const group = indexed.groups.get(key.slice(0, cut))
    if (!group) return
    const tail = key.slice(cut + 1)
    return group.byId.get(tail) ?? group.byId.get(normalizeId(tail))
}

/** 解析一个模型的参数来源：pin 决定认哪一侧，缺省走自动优先级（上游声明 > 目录）。
 * `name` 是宿主里该模型的显示名，仅用于兜底匹配（`userExperience.nameFallback` 开时才试） */
export function resolveSource(
    cfg: PluginConfig,
    indexed: IndexedCatalog,
    declarations: DeclarationMap | undefined,
    providerId: string,
    baseUrl: string | undefined,
    modelId: string,
    name?: string,
): ResolvedSource {
    const raw = cfg.sources[providerId]?.[modelId]
    const pin = typeof raw === 'string' ? raw.trim() : ''
    const declaredAuto = declarations?.get(providerId)?.get(modelId)
    if (pin === SOURCE_UPSTREAM) return { pin, entry: undefined, declared: declaredAuto }
    if (pin !== '') {
        const pinned = entryBySourceKey(indexed, pin)
        // 陈旧 pin（目录刷新后条目消失）：回落自动，不让一个失效键把该模型永久留空
        if (pinned) return { pin, entry: pinned, declared: undefined }
    }
    // 自动：三级级联 → 兜底一（剥命名空间前缀，仍走三级级联）→ 兜底二（显示名，要求唯一一组参数）
    const strict =
        lookup(indexed, providerId, baseUrl, modelId, cfg.userExperience.looseMatch) ??
        lookupStripped(indexed, modelId)
    const entry =
        strict ?? (cfg.userExperience.nameFallback && name ? lookupByName(indexed, name) : undefined)
    return { pin: '', entry, declared: declaredAuto }
}
