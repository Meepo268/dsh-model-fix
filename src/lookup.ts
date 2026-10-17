import { HINTS, LEVELS } from '@/constants'
import type { IndexedCatalog, IndexEntry } from '@/types'

/**
 * 归一化模型 id：小写并去 -latest / -openai-compact 后缀噪音。
 *
 * 由本模块导出：目录索引的匹配键在 `src/catalog.ts` 建索引时就取自这里——目录 id 保留原始大小写与
 * 命名空间前缀，而三级匹配只在归一空间进行，故归一规则只有这一处实现。
 */
export function normalizeId(id: string): string {
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

/**
 * 匹配本地模型 id 与目录 id：精确、词干、前缀三级。
 *
 * `ids` 必须是建索引时归一过的匹配键（见 `ProviderGroup.ids`），返回的也是归一键，供 `byId` 反查条目本体。
 */
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

/**
 * 在目录中查找模型条目。定位分两级：
 *
 * - **组内**（provider 精确命中目录时）：依次试**完整 id** → **裸名** → **末段唯一匹配**。前两级是
 *   `matchId` 的三级匹配（完整 id 优先是因为目录 id 常自带命名空间前缀，如 `tencent/Hy3`），
 *   key 相同时只查一次；末段匹配见 `matchIn` 的 `tailMatch`。
 * - **全局**：官方提供方提示命中即认（模型名前缀自带定位依据）；其余走兜底，只在跨提供方唯一命中时才认。
 *
 * 宁可漏也不错配：多命中一律判歧义放弃，不猜。
 */
export function lookup(indexed: IndexedCatalog, providerId: string, modelId: string): IndexEntry | undefined {
    const { groups } = indexed
    const bare = modelId.slice(modelId.lastIndexOf('/') + 1)
    /**
     * 组内匹配。`tailMatch` 只在 provider 严格匹配时开启——用户指定了提供方即已定域，此时「裸名等于
     * 目录 id 末段且唯一」不构成歧义。兜底遍历与官方提示两处不开：那里没有定域依据，裸名撞末段会把
     * 别家的条目也纳入候选，正是要防的跨提供方错配。
     */
    const matchIn = (provider: string, tailMatch: boolean): IndexEntry | undefined => {
        const group = groups.get(provider)
        if (!group) return
        const exact = matchId(modelId, group.ids)
        if (exact !== undefined) return group.byId.get(exact)
        if (bare !== modelId) {
            const loose = matchId(bare, group.ids)
            if (loose !== undefined) return group.byId.get(loose)
        }
        if (!tailMatch) return
        // 裸名过不了三级匹配：它不以目录 id 开头，词干 base 也带着前缀，故改比末段；
        // 末段相同的**不同条目**仍判歧义（同一 entry 的重复键不算多命中）
        const wanted = normalizeId(bare)
        let tailHit: IndexEntry | undefined
        for (const id of group.ids) {
            if (id.slice(id.lastIndexOf('/') + 1) !== wanted) continue
            const entry = group.byId.get(id)
            if (!entry) continue
            if (tailHit && tailHit !== entry) return
            tailHit = entry
        }
        return tailHit
    }
    // 配置 provider 精确命中目录时，仅在该 provider 内匹配（末段匹配仅在此处启用）
    if (providerId && groups.has(providerId)) {
        const same = matchIn(providerId, true)
        if (same) return same
    }
    // 模型名前缀提示的官方提供方：提示本身即定位依据，命中即认
    const hinted = hintedProvider(bare)
    if (hinted) {
        const official = matchIn(hinted, false)
        if (official) return official
    }
    // 其余提供方：唯一命中才认，第二个命中即判歧义放弃（见函数头「宁可漏也不错配」）
    let found: IndexEntry | undefined
    for (const provider of groups.keys()) {
        if (provider === providerId || provider === hinted) continue
        const hit = matchIn(provider, false)
        if (!hit) continue
        if (found) return
        found = hit
    }
    return found
}

/** 转换为 reasoningEfforts 映射：key 为可选等级，value 为目录原始拼写（'off'/'none' 均映射到 off 键，保留原值而非 null）；七档之外的值丢弃（宿主只读七档键，写进去了也无效） */
export function toReasoningEfforts(entry: IndexEntry | undefined): Record<string, string | null> | undefined {
    if (!entry) return
    const mapped: Record<string, string | null> = {}
    for (const effort of entry.efforts) {
        if (effort !== 'none' && !LEVELS.has(effort)) continue
        const level = effort === 'none' || effort === 'off' ? 'off' : effort
        mapped[level] = level === 'off' ? effort : level
    }
    const keys = Object.keys(mapped)
    // 空或只剩 off：无可选档位，等同无匹配，不填充（与 stripEmptyFields 的空壳判据同口径）
    if (keys.length === 0 || (keys.length === 1 && keys[0] === 'off')) return
    return mapped
}
