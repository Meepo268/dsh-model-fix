import { HINTS } from '@/constants'
import type { IndexedCatalog, IndexEntry } from '@/types'

/** 归一化模型 id：小写并去 -latest / -openai-compact 后缀噪音 */
function normalizeId(id: string): string {
    return id.toLowerCase().replace(/-openai-compact$/, '').replace(/-latest$/, '')
}

/** 日期式数字组（2/4 位数字、总计 4/6/8 位，长形优先）；不锚定末尾，中缀亦提取；-? 连带消费相邻连字符避免 base 残留 -- */
const DATE_GROUP_WITH_HYPHEN = /-?(?:\d{8}|\d{4}-\d{4}|\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4}|\d{6}|\d{2}-\d{4}|\d{4}-\d{2}|\d{4}|\d{2}-\d{2})/g

/** 拆 id 为 { base, digits }：digits 为各日期组剥除连字符后直接拼接的纯数字串（08-31 与 0831 视作同一），base 为去各组后的主体 */
function stem(id: string): { base: string; digits: string } {
    const normalized = normalizeId(id)
    let digits = ''
    const stripped = normalized.replace(DATE_GROUP_WITH_HYPHEN, (m) => {
        digits += m.replace(/^-/, '').replace(/-/g, '')
        return ''
    })
    if (!digits) return { base: normalized, digits: '' }
    const base = stripped.replace(/-{2,}/g, '-').replace(/^-+/, '').replace(/-+$/, '')
    return { base, digits }
}

/** 匹配本地模型 id 与目录 id：精确、词干、前缀三级 */
function matchId(localId: string, ids: readonly string[]): string | undefined {
    const normalized = normalizeId(localId)
    if (ids.includes(normalized)) return normalized
    // 裸名不参与词干/前缀匹配：无分隔符时词干会把 'foo' 与 'foo2' 视作同一 base
    if (!normalized.includes('-') && !normalized.includes('.')) return
    const localStem = stem(normalized)
    // base 相同即候选；仅当两边都有 digits 时才比对 digits，相同才算命中——
    // 同一 base 的多个日期变体因此被区分开，只剩唯一候选；多命中仍按单命中门槛判无命中。
    const stemHits = ids.filter((id) => {
        const s = stem(id)
        if (s.base !== localStem.base) return false
        if (localStem.digits && s.digits) return s.digits === localStem.digits
        return true
    })
    if (stemHits.length === 1) return stemHits[0]
    const prefix = ids.filter((id) => id.startsWith(`${normalized}-`) || id.startsWith(`${normalized}.`))
    if (prefix.length === 1) return prefix[0]
}

/** 按模型名前缀提示官方提供方 */
function hintedProvider(id: string): string | undefined {
    const bare = id.slice(id.lastIndexOf('/') + 1).toLowerCase()
    return HINTS.find(([prefix]) => bare === prefix || bare.startsWith(`${prefix}-`) || bare.startsWith(`${prefix}.`))?.[1]
}

/** 在目录中查找模型条目：优先按 provider+modelId，失败再仅按 modelId 全局匹配 */
export function lookup(indexed: IndexedCatalog, providerId: string, modelId: string): IndexEntry | undefined {
    const { groups } = indexed
    const bare = modelId.slice(modelId.lastIndexOf('/') + 1)
    const matchIn = (provider: string): IndexEntry | undefined => {
        const group = groups.get(provider)
        if (!group) return
        const hit = matchId(bare, group.ids)
        if (hit === undefined) return
        return group.entries.find((entry) => entry.id === hit)
    }
    // 配置 provider 精确命中目录时，仅在该 provider 内匹配
    if (providerId && groups.has(providerId)) {
        const same = matchIn(providerId)
        if (same) return same
    }
    // 否则按 modelId 全局匹配：先提示提供方，再全部提供方
    const hinted = hintedProvider(bare)
    if (hinted) {
        const official = matchIn(hinted)
        if (official) return official
    }
    for (const provider of groups.keys()) {
        if (provider === providerId || provider === hinted) continue
        const hit = matchIn(provider)
        if (hit) return hit
    }
}

/** 转换为 reasoningEfforts 映射：key 为可选等级，value 为目录原始拼写（'off'/'none' 均映射到 off 键，保留原值而非 null） */
export function toReasoningEfforts(entry: IndexEntry | undefined): Record<string, string | null> | undefined {
    if (!entry) return
    const mapped: Record<string, string | null> = {}
    for (const effort of entry.efforts) {
        const level = effort === 'none' || effort === 'off' ? 'off' : effort
        mapped[level] = level === 'off' ? effort : level
    }
    const keys = Object.keys(mapped)
    if (keys.length === 0) return
    // 仅剩 off 表示无可选档位，等同无匹配，不填充
    if (keys.length === 1 && keys[0] === 'off') return
    return mapped
}
