/** 参数来源：解析「这个模型该用谁的参数」与「参数来源」弹层的取数。
 *
 * 优先级（见 docs/decisions.md「参数来源」）：**手改 > 人工 pin > 上游声明 > models.dev 目录**。
 * pin 的三种取值：缺省 / 空串 = 自动（上游声明 > 目录）；`upstream` = 只认上游声明；`<provider>/<id>` = 只认该目录条目。
 * 本文件只做纯计算（零 ctx），RPC 与写回在 `rpc.ts` / `fix.ts`。 */

import { collectCandidates, entryBySourceKey, lookup } from '@/lookup'
import { SOURCE_UPSTREAM, isPlainObject, type PluginConfig } from '@/shared/types'
import { formatEfforts } from '@/shared/source-view'
import type { IndexedCatalog, IndexEntry } from '@/types'
import type { Declaration, DeclarationMap } from '@/upstream'
import type { SourceCandidateView, SourceFieldsView, SourceModelView, SourceProviderView, SourceSnapshot } from '@/shared/source-view'

/** 一个模型本轮实际用的来源 */
export interface ResolvedSource {
    /** 生效 pin 值（未指定 / 空串均为空串 = 自动） */
    pin: string
    /** 目录条目（pin 为 `upstream` 或被 pin 的条目已从目录消失且无自动命中时为 undefined） */
    entry: IndexEntry | undefined
    /** 上游声明（pin 指向目录条目时不给：用户已明确只要该条目） */
    declared: Declaration | undefined
}

/** 解析一个模型的参数来源：pin 决定认哪一侧，缺省走自动优先级（上游声明 > 目录） */
export function resolveSource(
    cfg: PluginConfig,
    indexed: IndexedCatalog,
    declarations: DeclarationMap | undefined,
    providerId: string,
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
    return {
        pin: '',
        entry: lookup(indexed, providerId, modelId, cfg.userExperience.looseMatch, name),
        declared: declaredAuto,
    }
}

/** 条目 -> 展示用四字段 */
function fieldsOfEntry(entry: IndexEntry | undefined): SourceFieldsView {
    return {
        efforts: formatEfforts(entry?.efforts),
        contextWindow: entry?.contextWindow,
        maxTokens: entry?.maxTokens,
        image: entry?.image === true,
    }
}

/** 上游声明 -> 展示用四字段（未声明的维度同目录口径留空） */
function fieldsOfDeclaration(declared: Declaration | undefined): SourceFieldsView | undefined {
    if (!declared) return undefined
    return {
        efforts: formatEfforts(declared.efforts),
        contextWindow: declared.contextWindow,
        maxTokens: declared.maxTokens,
        image: declared.image === true,
    }
}

/** 配置行现值 -> 展示用四字段（`cleaned` 已剔除空壳，此处直接读） */
function fieldsOfModel(model: Record<string, unknown>): SourceFieldsView {
    const efforts = model.reasoningEfforts
    const input = model.input
    const contextWindow = model.contextWindow
    const maxTokens = model.maxTokens
    return {
        efforts: isPlainObject(efforts) ? formatEfforts(Object.keys(efforts)) : '',
        contextWindow: typeof contextWindow === 'number' ? contextWindow : undefined,
        maxTokens: typeof maxTokens === 'number' ? maxTokens : undefined,
        image: Array.isArray(input) && input.includes('image'),
    }
}

/** 构造「参数来源」弹层的整份快照（纯函数、可单测）：遍历配置里的提供方与模型，
 * 给出每行当前 pin、实际取胜来源、上游声明、目录候选与配置行现值。 */
export function buildSourceSnapshot(
    cfg: PluginConfig,
    providers: Record<string, unknown>,
    indexed: IndexedCatalog,
    declarations: DeclarationMap | undefined,
): SourceSnapshot {
    const excluded = new Set(cfg.excludes)
    const rows: SourceProviderView[] = []
    for (const [providerId, provider] of Object.entries(providers)) {
        if (!isPlainObject(provider)) continue
        const models = provider.models
        if (!Array.isArray(models)) continue
        const list: SourceModelView[] = []
        for (const model of models) {
            if (!isPlainObject(model) || model.id === undefined || model.id === null) continue
            const modelId = String(model.id)
            const name = typeof model.name === 'string' ? model.name : undefined
            const resolved = resolveSource(cfg, indexed, declarations, providerId, modelId, name)
            const matched = resolved.entry
            // 自动优先级：手头有声明就是上游赢；否则认目录命中（pin 时按 pin 记账）
            const source = resolved.declared !== undefined
                ? 'upstream'
                : matched !== undefined ? 'catalog' : 'none'
            const rawCandidates = collectCandidates(indexed, providerId, modelId, name)
            // 候选条目与 lookup 命中的是同一份对象引用（都取自组内 byId），按引用认出发起匹配的那条
            const matchedKey = rawCandidates.find((candidate) => candidate.entry === matched)?.key
            const candidates: SourceCandidateView[] = rawCandidates.map((candidate) => ({
                key: candidate.key,
                provider: candidate.provider,
                id: candidate.entry.id,
                fields: fieldsOfEntry(candidate.entry),
            }))
            // 手工 pin 的条目未必进得了候选（它的 id/名字与本行不同形）：补一行同 key 的选项，
            // 否则下拉会显示成「自动」——那正是用户最需要看见自己指定过什么的地方
            const pinnedEntry = resolved.entry
            const pinnedOnly = resolved.pin !== '' && pinnedEntry !== undefined && matchedKey === undefined
            if (pinnedOnly && pinnedEntry !== undefined) {
                const cut = resolved.pin.indexOf('/')
                candidates.unshift({
                    key: resolved.pin,
                    provider: cut > 0 ? resolved.pin.slice(0, cut) : resolved.pin,
                    id: pinnedEntry.id,
                    fields: fieldsOfEntry(pinnedEntry),
                })
            }
            list.push({
                id: modelId,
                ...(name === undefined ? {} : { name }),
                pin: resolved.pin,
                source,
                ...(matchedKey === undefined && !pinnedOnly ? {} : { matchedKey: matchedKey ?? resolved.pin }),
                current: fieldsOfModel(model),
                ...(resolved.declared === undefined ? {} : { upstream: fieldsOfDeclaration(resolved.declared) }),
                candidates,
                excluded: excluded.has(providerId),
            })
        }
        if (list.length > 0) rows.push({ id: providerId, models: list })
    }
    return { providers: rows }
}
