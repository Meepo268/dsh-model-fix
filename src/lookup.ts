import { HINTS, LEVELS } from '@/constants'
import type { IndexedCatalog, IndexEntry } from '@/types'
import { isCapacity } from '@/types'

/** 归一化模型 id：小写并去 `-latest` / `-openai-compact` 后缀；归一规则仅此一处（目录匹配键建索引时取自这里） */
export function normalizeId(id: string): string {
    return id.toLowerCase().replace(/-openai-compact$/, '').replace(/-latest$/, '')
}

/** 命名空间前缀：`ns:`（小写标识符 + 冒号），只在**前导**位置剥。聚合网关常给模型 id 加自己的命名空间（`cn:deepseek-v4-pro`），
 * 而目录里存的是裸名；`kenari/hy3:free` 这类**后缀**冒号是模型自带 tag，不得误剥（故不用 lastIndexOf） */
const NAMESPACE_PREFIX = /^[a-z0-9][a-z0-9_-]*:/

/** 剥掉前导命名空间前缀（`cn:deepseek-v4-pro` → `deepseek-v4-pro`）；无前缀原样返回 */
export function stripNamespace(id: string): string {
    return id.replace(NAMESPACE_PREFIX, '')
}

/** 显示名归一：小写、空白与下划线折算连字符、压缩重复连字符（`DeepSeek V4 Pro` → `deepseek-v4-pro`）；
 * 只作兜底匹配键，不替代 id（显示名可重复，故只在 id 全线失配时使用且要求唯一命中） */
export function normalizeName(name: string): string {
    return normalizeId(name.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-{2,}/g, '-'))
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

/** 按模型名前缀提示官方提供方候选（同一模型常挂在多个官方名下，返回全部候选由调用方依序尝试） */
function hintedProviders(id: string): readonly string[] {
    const bare = id.slice(id.lastIndexOf('/') + 1).toLowerCase()
    return HINTS.find(([prefix]) => bare === prefix || bare.startsWith(`${prefix}-`) || bare.startsWith(`${prefix}.`))?.[1] ?? []
}

/** 在目录中查找模型条目：组内依次 完整 id → 裸名 → 末段唯一匹配；全局官方提示依序试、兜底仅跨提供方唯一命中才认。多命中判歧义放弃（宁可漏不错配，见 decisions.md「参数来源」）。
 * `loose`（尽量匹配）时歧义不再放弃：兜底命中 ≥2 进加权合成、=1 直接返回；仍无命中则用归一裸名全局 includes 扩展候选，同样单命中直接返回、多命中合成 */
function lookupCore(indexed: IndexedCatalog, providerId: string, modelId: string, loose = false): IndexEntry | undefined {
    const { groups } = indexed
    const bare = modelId.slice(modelId.lastIndexOf('/') + 1)
    /** 组内匹配；`tailMatch` 只在 provider 严格匹配（已定域）时开启，避免裸名撞别家末段造成跨提供方错配 */
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
    // 配置 provider 精确命中目录时，仅在该 provider 内匹配（末段匹配仅在此处启用）
    if (providerId && groups.has(providerId)) {
        const same = matchIn(providerId, true)
        if (same) return same
    }
    // 模型名前缀提示的官方提供方：提示本身即定位依据，依序试到命中即认
    const hinted = hintedProviders(bare)
    for (const provider of hinted) {
        const official = matchIn(provider, false)
        if (official) return official
    }
    // 其余提供方：`loose` 时收集全部命中（候选都过了组内三级匹配），否则第二命中即放弃
    const collected: LooseCandidate[] = []
    for (const provider of groups.keys()) {
        if (provider === providerId || hinted.includes(provider)) continue
        const hit = matchIn(provider, false)
        if (!hit) continue
        if (!loose && collected.length) return
        collected.push({ entry: hit, provider })
    }

    // ≥2 命中只有 loose 可达（非 loose 已在循环内返回）
    if (collected.length === 1) return collected[0].entry
    if (collected.length > 1) return synthesize(collected)

    if (!loose) return
    const wanted = normalizeId(bare)
    const fuzzy: LooseCandidate[] = []
    for (const [provider, group] of groups) {
        for (const id of group.ids) {
            if (!id.includes(wanted)) continue
            const entry = group.byId.get(id)
            if (entry) fuzzy.push({ entry, provider })
        }
    }
    // 和collected同逻辑
    if (fuzzy.length === 1) return fuzzy[0].entry
    if (fuzzy.length > 1) return synthesize(fuzzy)
}

/** 在目录中查找模型条目：先按 id 走三级匹配与提供方定位；id 全线失配时依次尝试
 * ① 剥掉前导命名空间前缀后的 id（`cn:deepseek-v4-pro`）② 归一后的**显示名**（`DeepSeek-V4-Pro`）。
 * 两级兜底都只认唯一命中（宁可漏不错配，见 decisions.md「参数来源」）：网关 id 前缀与显示名都可能撞名，
 * 放宽成歧义合成会把别家参数写进本模型配置。 */
export function lookup(
    indexed: IndexedCatalog,
    providerId: string,
    modelId: string,
    loose = false,
    name?: string,
): IndexEntry | undefined {
    const direct = lookupCore(indexed, providerId, modelId, loose)
    if (direct) return direct
    const bare = stripNamespace(modelId)
    if (bare !== modelId) {
        const stripped = lookupCore(indexed, providerId, bare, loose)
        if (stripped) return stripped
    }
    // 显示名兜底不走 loose：显示名可比 id 模糊得多（`DeepSeek V4` 对 `deepseek-v4-pro`），合成必错配
    const named = name === undefined ? '' : normalizeName(name)
    if (named === '' || named === normalizeId(bare) || named === normalizeId(modelId)) return
    return lookupCore(indexed, providerId, named, false)
}

/** 尽量匹配的 60% 判据：efforts / image 支持门槛，容量分位位置 */
const LOOSE_SHARE = 0.6

/** 投票权重：官方 ×5，其余 ×1 */
const LOOSE_OFFICIAL_WEIGHT = 5

/** 官方 = HINTS 值集合（与 hintedProviders 同源） */
const OFFICIAL_PROVIDERS: ReadonlySet<string> = new Set(HINTS.flatMap(([, providers]) => providers))

/** 候选：条目 + 提供方（提供方定投票权重） */
interface LooseCandidate {
    entry: IndexEntry
    provider: string
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

// ---------- 尽量匹配：加权合成（纯函数，见 docs/decisions.md「参数来源」） ----------

function weightOf(provider: string): number {
    return OFFICIAL_PROVIDERS.has(provider) ? LOOSE_OFFICIAL_WEIGHT : 1
}

/** 容量「安全 N」：有值容量取 60 分位；官方 ×5 不展开进分位（否则单条官方值即可顶高 N） */
function safeCapacity(candidates: readonly LooseCandidate[], field: 'contextWindow' | 'maxTokens'): number | undefined {
    const values: number[] = []
    for (const { entry } of candidates) {
        const value = entry[field]
        if (isCapacity(value)) values.push(value)
    }
    values.sort((a, b) => a - b)
    return values[Math.ceil(values.length * LOOSE_SHARE) - 1]
}

function synthesize(candidates: readonly LooseCandidate[]): IndexEntry | undefined {
    const total = candidates.reduce((sum, candidate) => sum + weightOf(candidate.provider), 0)
    const effortVotes = new Map<string, number>() // 档位 -> 票数
    const offSpellings = new Map<string, number>() // off 原拼写 -> 票数（含 none）
    for (const { entry, provider } of candidates) {
        const weight = weightOf(provider)
        const seen = new Set<string>()
        for (const effort of entry.efforts) {
            const level = effort === 'none' || effort === 'off' ? 'off' : effort
            if (seen.has(level)) continue
            seen.add(level)
            effortVotes.set(level, (effortVotes.get(level) ?? 0) + weight)
            if (level === 'off') offSpellings.set(effort, (offSpellings.get(effort) ?? 0) + weight)
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
    // 图片：声明 true 的候选权重 ≥60% 总权重才写（目录只缓存正向信息，false 即无值）
    const imageVotes = candidates.reduce((sum, { entry, provider }) => entry.image ? sum + weightOf(provider) : sum, 0)
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
