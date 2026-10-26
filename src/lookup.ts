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

// ---------- 兜底匹配：命名空间前缀 / 显示名（只在三级级联全未命中时启用，见 docs/decisions-config.md「参数来源」） ----------

/** 前导命名空间前缀（`cn:` / `us:`…）。只剥开头且冒号后还有内容；`kenari/hy3:free` 的冒号在**末段**
 * （模型自带的 tag），这里不剥——剥错会把两个不同模型认成同一个 */
const NAMESPACE_PREFIX = /^[a-z0-9][a-z0-9_-]*:/

/** 剥前导命名空间前缀；无前缀原样返回 */
export function stripNamespace(id: string): string {
    const stripped = id.replace(NAMESPACE_PREFIX, '')
    return stripped === '' ? id : stripped
}

/** 显示名归一成 id 形态：小写、非 id 字符压成 `-`，保留 `.` 与数字（版本号要留住） */
export function normalizeName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
}

/** 兜底聚合的支持度门槛：剥前缀（id 证据较强）过半即可；显示名（弱证据）要六成 */
const PREFIX_SUPPORT = 0.5
const NAME_SUPPORT = 0.6

/** 收集某几种写法在目录里命中的全部条目（跨提供方，同一提供方只取首个命中） */
function entriesFor(indexed: IndexedCatalog, forms: readonly string[]): IndexEntry[] {
    const entries: IndexEntry[] = []
    for (const form of forms) {
        for (const group of indexed.groups.values()) {
            const hit = matchId(form, group.ids)
            if (hit === undefined) continue
            const entry = group.byId.get(hit)
            if (entry) entries.push(entry)
        }
    }
    return entries
}

/** 多数声明：缺席（无值/空）不算反对票；并列第一或得票不到 `support` 一律留空 */
function pickString(values: readonly (string | undefined)[], support: number): string | undefined {
    const counts = new Map<string, number>()
    let declared = 0
    for (const value of values) {
        if (value === undefined || value === '') continue
        counts.set(value, (counts.get(value) ?? 0) + 1)
        declared += 1
    }
    if (declared === 0) return
    let best: string | undefined
    let bestCount = 0
    let tied = false
    for (const [value, count] of counts) {
        if (count > bestCount) {
            best = value
            bestCount = count
            tied = false
        } else if (count === bestCount) tied = true
    }
    if (best === undefined || tied || bestCount / declared < support) return
    return best
}

/** 容量同理；并列时取较小（宁小勿大） */
function pickNumber(values: readonly (number | undefined)[], support: number): number | undefined {
    const counts = new Map<number, number>()
    let declared = 0
    for (const value of values) {
        if (value === undefined || value <= 0) continue
        counts.set(value, (counts.get(value) ?? 0) + 1)
        declared += 1
    }
    if (declared === 0) return
    let best: number | undefined
    let bestCount = 0
    let tied = false
    let tiedMin: number | undefined
    for (const [value, count] of counts) {
        if (count > bestCount) {
            best = value
            bestCount = count
            tied = false
            tiedMin = value
        } else if (count === bestCount) {
            tied = true
            tiedMin = tiedMin === undefined ? value : Math.min(tiedMin, value)
        }
    }
    if (best === undefined || bestCount / declared < support) return
    return tied ? tiedMin : best
}

/**
 * 逐维聚合：域不明（跨提供方同名）时，四个维度各自投票——缺席不算反对票，
 * 某取值在有声明者中过 `support` 才采纳，凑不出任何一维就判无匹配。
 */
function aggregate(entries: readonly IndexEntry[], support: number): IndexEntry | undefined {
    if (entries.length === 0) return
    const efforts = pickString(
        entries.map((entry) =>
            entry.efforts.length === 0 ? undefined : [...entry.efforts].map(levelOf).sort().join(','),
        ),
        support,
    )
    const contextWindow = pickNumber(
        entries.map((entry) => entry.contextWindow),
        support,
    )
    const maxTokens = pickNumber(
        entries.map((entry) => entry.maxTokens),
        support,
    )
    const image = pickString(
        entries.map((entry) => (entry.image === true ? '1' : undefined)),
        support,
    )
    if (efforts === undefined && contextWindow === undefined && maxTokens === undefined && image === undefined) return
    return {
        id: entries[0].id,
        efforts: efforts === undefined ? [] : efforts.split(','),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(image === '1' ? { image: true } : {}),
    }
}

/**
 * 兜底一：剥掉命名空间前缀，拿剥后的 id 去目录里逐维聚合。
 * 前缀是网关加的分组记号（`cn:deepseek-v4-pro`），剥掉后就是普通 id；但此时域（对应哪家提供方）
 * 仍不明，`lookup` 的全局阶段遇到第二个提供方就放弃，故这里改为「多数声明」：
 * 镜像之间的分歧集中在「某家少填一维」，缺席不该否掉别家的声明。无前缀时返回 undefined。
 */
export function lookupStripped(indexed: IndexedCatalog, modelId: string): IndexEntry | undefined {
    const stripped = stripNamespace(modelId)
    if (stripped === modelId) return
    return aggregate(entriesFor(indexed, [stripped]), PREFIX_SUPPORT)
}

/**
 * 兜底二：显示名归一后去目录里找（含去首段厂商标识）；
 * 显示名是弱证据（各家写法不一、可能撞名），故门槛抬到六成，且并列第一即弃。
 */
export function lookupByName(indexed: IndexedCatalog, name: string): IndexEntry | undefined {
    const normalized = normalizeName(name)
    if (normalized === '') return
    const forms = [normalized]
    // 显示名常以厂商标识开头（`Xiaomi MiMo-V2.6-Pro`）：去掉首段再试一次
    const cut = normalized.indexOf('-')
    if (cut > 0) {
        const tail = normalized.slice(cut + 1)
        if (tail !== '' && !forms.includes(tail)) forms.push(tail)
    }
    return aggregate(entriesFor(indexed, forms), NAME_SUPPORT)
}

/** 转换为 reasoningEfforts 映射：key 为可选等级，value 为原始拼写（'off'/'none' 均映射到 off 键，保留原值而非 null）；七档之外的值丢弃（宿主只读七档键，写进去了也无效）。
 * 目录条目与上游声明（档位名列表）共用本函数，保证两侧写出的形状完全一致 */
export function toReasoningEffortsFromList(efforts: readonly string[] | undefined): Record<string, string | null> | undefined {
    if (!efforts) return
    const mapped: Record<string, string | null> = {}
    for (const effort of efforts) {
        if (effort !== 'none' && !LEVELS.has(effort)) continue
        const level = effort === 'none' || effort === 'off' ? 'off' : effort
        mapped[level] = level === 'off' ? effort : level
    }
    const keys = Object.keys(mapped)
    // 空或只剩 off：无可选档位，等同无匹配，不填充（与 stripEmptyFields 的空壳判据同口径）
    if (keys.length === 0 || (keys.length === 1 && keys[0] === 'off')) return
    return mapped
}

/** 目录条目 -> reasoningEfforts 映射（无条目即 undefined） */
export function toReasoningEfforts(entry: IndexEntry | undefined): Record<string, string | null> | undefined {
    return toReasoningEffortsFromList(entry?.efforts)
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

// ---------- 参数来源：候选枚举（「参数来源」下拉用，纯函数） ----------

/** 参数来源候选键的拼法：`<provider>/<modelId>`；写进配置的 pin 值与下拉回传值共用这一个拼法 */
export function sourceKey(provider: string, id: string): string {
    return `${provider}/${id}`
}

/** 目录候选（下拉里的一行）：来源键 + 提供方 + 条目本身 + 被折叠的同值来源数 */
export interface CatalogCandidate {
    key: string
    provider: string
    entry: IndexEntry
    /** 同 id 形态、同参数的其它来源键（只计数不列出）：`also > 0` 即「另有 N 家同值」 */
    also: string[]
}

/** 单模型候选上限：目录里同一模型最多挂在几十家提供方下（实测 83 条），全列会把下拉撑爆 */
const SOURCE_CANDIDATE_LIMIT = 24
/** 精确命中的代表条数上限：同值来源折叠后一般只剩几条，其余名额留给同族变体 */
const SOURCE_EXACT_LIMIT = 8

/** 参数指纹：档位 + 两个容量 + 图片。同指纹的目录条目对填充而言完全等价，下拉里可以折叠成一行 */
function signatureOf(entry: IndexEntry): string {
    return [entry.efforts.join(','), entry.contextWindow ?? '', entry.maxTokens ?? '', entry.image === true ? '1' : '0'].join('|')
}

/** 允许跟在匹配键后的「同模型不同渠道/推理形态」限定词。版本号（`glm-5` 之于 `glm-5.3`）与
 * `-flash` / `-air` 这类是另一个模型，不在表内——下拉里混进上一代模型比少列一条更糟 */
const VARIANT_QUALIFIERS: ReadonlySet<string> = new Set(['free', 'free-tier', 'thinking', 'nothinking', 'reasoning', 'noreasoning', 'chat', 'instruct'])

/** 变体距离：末段等于键（渠道加了 `vendor/` 前缀的镜像）记 0；两边只差允许的限定词（`-free`、`:free`、`-thinking`，
 * 任一方向都算——网关叫 `-free` 而目录叫裸名时同样可选）记差出的长度；`glm-5` 这种版本级父级直接不收 */
function variantDistance(tail: string, key: string): number | undefined {
    if (tail === key) return 0
    const longer = tail.length > key.length ? tail : key
    const shorter = tail.length > key.length ? key : tail
    if (!longer.startsWith(shorter)) return
    const rest = longer.slice(shorter.length)
    if (rest === '' || !/^[-:]/.test(rest)) return
    const parts = rest.split(/[-:]/).filter((part) => part !== '')
    if (parts.length === 0 || parts.some((part) => !VARIANT_QUALIFIERS.has(part))) return
    return rest.length
}

/** 收集某模型在目录里的全部候选条目（供人工指定来源）：两轮扫描。
 * 第一轮按三种匹配键（原 id / 剥命名空间前缀后的 id / 归一显示名）逐提供方取首个三级命中；
 * 第二轮补「同族变体」：目录 id 的末段等于匹配键（`z-ai/glm-5.3-flash` 只是多一层厂商前缀的镜像），
 * 或只多出渠道/推理限定词（`glm-5.3-flash` 收 `glm-5.3-flash-free`、`-thinking`；`glm-5` 是上一代模型，不收）。
 * 变体只进下拉、绝不参与自动匹配。
 * 同 id 形态且参数指纹相同的来源折叠成一行（`also` 记账）：83 条同值镜像否则会把变体全挤掉，而它们填出来的参数一模一样。
 * 精确命中占前 8 个名额（同值折叠后一般只剩一两条），剩余名额按「末段长度差」由近及远给同族变体，
 * 整体截到 `limit` 条。不判歧义也不合成——下拉就是把选择权交还用户 */
export function collectCandidates(
    indexed: IndexedCatalog,
    providerId: string,
    modelId: string,
    name?: string,
    limit = SOURCE_CANDIDATE_LIMIT,
): CatalogCandidate[] {
    const keys = [normalizeId(modelId)]
    const bare = stripNamespace(modelId)
    if (bare !== modelId) keys.push(normalizeId(bare))
    const named = name === undefined ? '' : normalizeName(name)
    if (named !== '' && !keys.includes(named)) keys.push(named)
    // 变体扫描的包含键：太短的键（`hy3`、`o3`）会把整片目录都收进来，只留 ≥ 4 字符的
    const variantKeys = keys.filter((key) => key.length >= 4)
    // 本配置的提供方优先（目录里真有同名组时它的条目最可能是用户想要的）
    const order = [providerId, ...[...indexed.groups.keys()].filter((provider) => provider !== providerId)]
    /** 同 id 形态 + 同指纹的条目折叠到同一个代表行，被折叠的来源键记进 `also`。
     * 折叠键取末段（`zai/glm-5.3-flash` 与 `glm-5.3-flash` 是同一模型，只差渠道前缀） */
    const foldInto = (bucket: Map<string, CatalogCandidate>, candidate: CatalogCandidate): void => {
        const id = candidate.entry.id
        const tail = id.slice(id.lastIndexOf('/') + 1).toLowerCase()
        const foldKey = `${tail}|${signatureOf(candidate.entry)}`
        const representative = bucket.get(foldKey)
        if (representative === undefined) bucket.set(foldKey, candidate)
        else representative.also.push(candidate.key)
    }
    const exactReps = new Map<string, CatalogCandidate>()
    const exactKeys = new Set<string>()
    for (const provider of order) {
        const group = indexed.groups.get(provider)
        if (!group) continue
        for (const key of keys) {
            const hit = matchId(key, group.ids)
            if (hit === undefined) continue
            const entry = group.byId.get(hit)
            if (!entry) continue
            const candidate = { key: sourceKey(provider, entry.id), provider, entry, also: [] }
            exactKeys.add(candidate.key)
            foldInto(exactReps, candidate)
            break
        }
    }
    /** 同族变体的远近：末段等于匹配键的镜像排最前（同一模型的另一套数），其余按多出的限定词长短由近及远 */
    const variantRows: Array<{ candidate: CatalogCandidate; distance: number }> = []
    const variantSeen = new Set<string>()
    for (const provider of order) {
        const group = indexed.groups.get(provider)
        if (!group) continue
        for (const id of group.ids) {
            const entry = group.byId.get(id)
            if (!entry) continue
            const key = sourceKey(provider, entry.id)
            if (exactKeys.has(key) || variantSeen.has(key)) continue
            const tail = id.slice(id.lastIndexOf('/') + 1).toLowerCase()
            let distance: number | undefined
            for (const wanted of variantKeys) {
                const found = variantDistance(tail, wanted)
                if (found === undefined) continue
                distance = distance === undefined ? found : Math.min(distance, found)
            }
            if (distance === undefined) continue
            variantSeen.add(key)
            variantRows.push({ candidate: { key, provider, entry, also: [] }, distance })
        }
    }
    variantRows.sort((left, right) => left.distance - right.distance)
    const variantReps = new Map<string, CatalogCandidate>()
    for (const row of variantRows) foldInto(variantReps, row.candidate)
    // 精确命中占前 8 个名额（同值折叠后一般只剩一两条），剩下的名额按远近给同族变体
    const exact = [...exactReps.values()].slice(0, Math.min(SOURCE_EXACT_LIMIT, limit))
    const variants = [...variantReps.values()].slice(0, Math.max(0, limit - exact.length))
    return [...exact, ...variants]
}
