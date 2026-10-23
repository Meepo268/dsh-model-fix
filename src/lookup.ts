import { LEVELS } from '@/constants'
import type { IndexedCatalog, IndexEntry } from '@/types'
import { isCapacity } from '@/types'

/** 归一化模型 id：小写并去 `-latest` / `-openai-compact` 后缀；归一规则仅此一处（目录匹配键建索引时取自这里） */
export function normalizeId(id: string): string {
    return id.toLowerCase().replace(/-openai-compact$/, '').replace(/-latest$/, '')
}

/** 日期式数字组（2/4 位数字、总计 4/6/8 位，长形优先）；不锚定末尾，中缀亦提取；-? 连带消费相邻连字符避免 base 残留 -- */
const DATE_GROUP_WITH_HYPHEN = /-?(?:\d{8}|\d{4}-\d{4}|\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4}|\d{6}|\d{2}-\d{4}|\d{4}-\d{2}|\d{4}|\d{2}-\d{2})/g

/** 拆 id 为 { base, digits }：digits 为各日期组剥连字符后的拼接，base 为去组后的主体 */
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

/** 匹配本地模型 id 与目录 id：精确、词干、前缀三级（`ids` 须为归一匹配键，返回归一键供 `byId` 反查） */
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

/** 档位层级：'none' 与 'off' 同归 off 键（关推理），其余为自身 */
function levelOf(effort: string): string {
    return effort === 'none' || effort === 'off' ? 'off' : effort
}

/**
 * 在目录中查找模型条目：端点 → 提供方 id → 全局模型 id 三级级联。
 * 端点命中时域已定（该端点提供的模型），同名多组只在参数上分歧：先按提供方 id 裁决，裁不了则取保守值。
 * 全局阶段多命中判歧义放弃（宁可漏不错配）；`loose`（尽量匹配）时改为收集候选合成。
 */
export function lookup(
    indexed: IndexedCatalog,
    providerId: string,
    baseUrl: string | undefined,
    modelId: string,
    loose = false,
): IndexEntry | undefined {
    const { groups, endpoints } = indexed
    const bare = modelId.slice(modelId.lastIndexOf('/') + 1)
    /** 组内匹配；`tailMatch` 只在域已定（端点命中 / 提供方严格匹配）时开启，避免裸名撞别家末段造成跨提供方错配 */
    const matchIn = (provider: string, tailMatch: boolean): IndexEntry | undefined => {
        const group = groups.get(provider)
        if (!group) return
        const exact = matchId(modelId, group.ids)
        if (exact !== undefined) return group.byId.get(exact)
        if (bare !== modelId) {
            const looseHit = matchId(bare, group.ids)
            if (looseHit !== undefined) return group.byId.get(looseHit)
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
    // 端点：严格字符串匹配（不归一），命中的提供方集合即域
    if (baseUrl) {
        const candidates = endpoints.get(baseUrl)
        if (candidates) {
            const hits: { provider: string; entry: IndexEntry }[] = []
            for (const provider of candidates) {
                const hit = matchIn(provider, true)
                if (hit) hits.push({ provider, entry: hit })
            }
            if (hits.length === 1) return hits[0].entry
            if (hits.length > 1) {
                const named = hits.find((hit) => hit.provider === providerId)
                if (named) return named.entry
                return mergeConservative(hits.map((hit) => hit.entry))
            }
        }
    }
    // 提供方 id：路由 id 命中目录时仅在该提供方内匹配
    if (providerId && groups.has(providerId)) {
        const same = matchIn(providerId, true)
        if (same) return same
    }
    // 全局：跨提供方按模型 id 匹配，唯一命中才认
    const collected: IndexEntry[] = []
    for (const provider of groups.keys()) {
        if (provider === providerId) continue
        const hit = matchIn(provider, false)
        if (!hit) continue
        if (!loose && collected.length) return
        collected.push(hit)
    }
    if (collected.length === 1) return collected[0]
    if (collected.length > 1) return synthesize(collected)
    if (!loose) return
    const wanted = normalizeId(bare)
    const fuzzy: IndexEntry[] = []
    for (const group of groups.values()) {
        for (const id of group.ids) {
            if (!id.includes(wanted)) continue
            const entry = group.byId.get(id)
            if (entry) fuzzy.push(entry)
        }
    }
    if (fuzzy.length === 1) return fuzzy[0]
    if (fuzzy.length > 1) return synthesize(fuzzy)
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

// ---------- 合成：跨提供方同名条目的保守合并与尽量匹配的候选合成（纯函数，见 docs/decisions-config.md「参数来源」） ----------

/** 保守合并：档位取交集、容量取小、图片需全支持（宁小勿大，宁缺勿滥） */
function mergeConservative(entries: readonly IndexEntry[]): IndexEntry | undefined {
    const efforts: string[] = []
    for (const effort of entries[0].efforts) {
        const level = levelOf(effort)
        if (entries.every((entry) => entry.efforts.some((other) => levelOf(other) === level))) efforts.push(effort)
    }
    const contextWindow = minCapacity(entries.map((entry) => entry.contextWindow))
    const maxTokens = minCapacity(entries.map((entry) => entry.maxTokens))
    const image = entries.every((entry) => entry.image === true) ? true : undefined
    if (efforts.length === 0 && contextWindow === undefined && maxTokens === undefined && !image) return
    return { id: entries[0].id, efforts, contextWindow, maxTokens, ...(image ? { image: true } : {}) }
}

/** 有值容量取最小（无值不参与比较） */
function minCapacity(values: readonly (number | undefined)[]): number | undefined {
    let min: number | undefined
    for (const value of values) {
        if (!isCapacity(value)) continue
        if (min === undefined || value < min) min = value
    }
    return min
}

/** 尽量匹配的 60% 判据：efforts / image 支持门槛，容量分位位置 */
const LOOSE_SHARE = 0.6

/** 容量「安全 N」：有值容量取 60 分位 */
function safeCapacity(candidates: readonly IndexEntry[], field: 'contextWindow' | 'maxTokens'): number | undefined {
    const values: number[] = []
    for (const entry of candidates) {
        const value = entry[field]
        if (isCapacity(value)) values.push(value)
    }
    values.sort((a, b) => a - b)
    return values[Math.ceil(values.length * LOOSE_SHARE) - 1]
}

/** 尽量匹配的合成：档位与图片取 60% 候选支持，容量取有值候选的 60 分位 */
function synthesize(candidates: readonly IndexEntry[]): IndexEntry | undefined {
    const total = candidates.length
    const effortVotes = new Map<string, number>() // 档位 -> 票数
    const offSpellings = new Map<string, number>() // off 原拼写 -> 票数（含 none）
    for (const entry of candidates) {
        const seen = new Set<string>()
        for (const effort of entry.efforts) {
            const level = levelOf(effort)
            if (seen.has(level)) continue
            seen.add(level)
            effortVotes.set(level, (effortVotes.get(level) ?? 0) + 1)
            if (level === 'off') offSpellings.set(effort, (offSpellings.get(effort) ?? 0) + 1)
        }
    }
    const efforts: string[] = []
    for (const [level, votes] of effortVotes) {
        if (votes < total * LOOSE_SHARE) continue
        if (level === 'off') {
            // off 拼写不一致取票数最高者（保留原值而非 null，见 decisions.md「参数来源」）
            efforts.push([...offSpellings.entries()].sort((a, b) => b[1] - a[1])[0][0])
        } else {
            efforts.push(level)
        }
    }
    const contextWindow = safeCapacity(candidates, 'contextWindow')
    const maxTokens = safeCapacity(candidates, 'maxTokens')
    // 图片：声明 true 的候选 ≥60% 才写（目录只缓存正向信息，false 即无值）
    const imageVotes = candidates.reduce((sum, entry) => entry.image ? sum + 1 : sum, 0)
    const image = imageVotes >= total * LOOSE_SHARE || undefined
    if (efforts.length === 0 && contextWindow === undefined && maxTokens === undefined && !image) return
    return {
        id: '', // 合成条目无对应目录 id
        efforts,
        contextWindow,
        maxTokens,
        ...(image ? { image: true } : {}),
    }
}
