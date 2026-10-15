import { readFile, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { API_URL, CACHE_FILE, FETCH_MS, LEVELS, MAX_ATTEMPTS, RETRY_DELAY_MS } from '@/constants'
import { PLUGIN_NAME } from '@/shared/constants'
import { errorText } from '@/shared/errors'
import type { CacheRecord, Catalog, IndexedCatalog, ModelEntry, ProviderGroup, IndexEntry } from '@/types'
import { isCapacity } from '@/types'
import { normalizeId } from '@/lookup'
import { isPlainObject } from '@/shared/types'

/** 目录尚未可用时的空兜底 */
const EMPTY_INDEX: IndexedCatalog = { catalog: {}, groups: new Map() }

// 内存索引：缓存加载或网络拉取成功后整体替换
let indexedCache: IndexedCatalog | undefined

/** 当前目录（未初始化时返回空兜底） */
export function getCatalog(): IndexedCatalog {
    return indexedCache ?? EMPTY_INDEX
}

/** 整体替换内存索引 */
export function setCatalog(indexed: IndexedCatalog): void {
    indexedCache = indexed
}

/** 解析 models.dev 单条模型数据为推理、容量与模态结果；无有效信息返回 undefined */
function fromApiEntry(entry: unknown): ModelEntry | undefined {
    if (!isPlainObject(entry)) return
    const { reasoning, reasoning_options: rawOptions, limit, modalities } = entry as {
        reasoning?: boolean
        reasoning_options?: unknown
        limit?: unknown
        modalities?: unknown
    }
    const options = Array.isArray(rawOptions) ? rawOptions : []
    const efforts: string[] = []
    let toggle = false
    for (const option of options) {
        if (!isPlainObject(option)) continue
        const { type, values } = option as { type?: unknown; values?: unknown }
        if (type === 'toggle') toggle = true
        if (type === 'effort' && Array.isArray(values)) {
            for (const value of values) {
                if (typeof value === 'string' && value) efforts.push(value)
            }
        }
    }
    // 容量字段（limit.context / limit.output）：非正整数与 99999999 哨兵（"无限/未公布"建模）视为无数据
    const limitRecord = isPlainObject(limit) ? limit : undefined
    const rawContext = limitRecord?.context
    const rawOutput = limitRecord?.output
    const contextWindow = isCapacity(rawContext) ? rawContext : undefined
    const maxTokens = isCapacity(rawOutput) ? rawOutput : undefined
    // 图片模态（modalities.input 含 'image'）：仅记录支持图片的模型（置 true）；
    // 不含 image、无数组或空数组均省略（不缓存 false，控制体积）；pdf/video/audio 等其他值忽略
    const rawInput = isPlainObject(modalities) && Array.isArray(modalities.input) ? modalities.input : undefined
    const image = !!rawInput && rawInput.includes('image')
    // 有推理级别、容量或图片支持才算有效数据
    const hasReasoning = reasoning === true && (toggle || efforts.length > 0)
    const hasContext = contextWindow !== undefined || maxTokens !== undefined
    if (!hasReasoning && !hasContext && !image) return
    return { reasoning: hasReasoning, toggle, efforts, contextWindow, maxTokens, image }
}

/**
 * 将 models.dev 原始 JSON 构建为分组缓存：{ provider: { model-id: 条目 } }，
 * 仅保留有可用推理级别、容量或支持图片的模型；
 * efforts 过滤为 harness 支持的取值，'off' 与 'none' 均按目录原值保留（不归一、不合成）。
 * 目录未列关闭档（off/none）时不写入该档——"能通"不等于"能关"，不替目录猜测可关闭。
 */
export function buildCatalog(api: Record<string, unknown> | undefined): Catalog {
    const catalog: Catalog = {}
    for (const [provider, block] of Object.entries(api ?? {})) {
        if (!isPlainObject(block)) continue
        const models = (block as { models?: unknown }).models
        if (!isPlainObject(models)) continue
        const group: Record<string, CacheRecord> = {}
        for (const [id, entry] of Object.entries(models as Record<string, unknown>)) {
            const parsed = fromApiEntry(entry)
            if (!parsed) continue
            const efforts = [...new Set(parsed.efforts.filter((effort) => effort === 'none' || LEVELS.has(effort)))]
            const hasUsableReasoning = parsed.reasoning && efforts.some((effort) => effort !== 'none' && effort !== 'off')
            // 仅有 none 的推理能力（无可选档位）不视为推理数据，但容量或图片支持仍可入库
            if (!hasUsableReasoning && parsed.contextWindow === undefined && parsed.maxTokens === undefined && !parsed.image) continue
            const result: CacheRecord = { efforts: hasUsableReasoning ? efforts : [] }
            if (parsed.contextWindow !== undefined) result.contextWindow = parsed.contextWindow
            if (parsed.maxTokens !== undefined) result.maxTokens = parsed.maxTokens
            if (parsed.image) result.image = parsed.image
            group[id] = result
        }
        if (Object.keys(group).length > 0) catalog[provider] = group
    }
    return catalog
}

/** 构建带 provider 分组索引的目录；catalog 本身保留原引用（fetchLatest 以它做序列化对比），索引条目另建（省一份 provider/id 存储） */
function indexFromCatalog(catalog: Catalog): IndexedCatalog {
    const groups = new Map<string, ProviderGroup>()
    for (const [provider, models] of Object.entries(catalog)) {
        const ids: string[] = []
        const byId = new Map<string, IndexEntry>()
        for (const [id, record] of Object.entries(models)) {
            if (!isCacheRecord(record)) continue
            const entry: IndexEntry = { id, efforts: record.efforts.slice() }
            if (record.contextWindow !== undefined) entry.contextWindow = record.contextWindow
            if (record.maxTokens !== undefined) entry.maxTokens = record.maxTokens
            if (record.image) entry.image = true
            // 匹配键必须归一：目录 id 保留原始大小写（`tencent/Hy3`），而三级匹配只在小写空间进行，
            // 不归一则这类 id 连精确匹配都过不去（口径见 docs/decisions.md「参数来源」）
            const key = normalizeId(id)
            ids.push(key)
            if (!byId.has(key)) byId.set(key, entry)
        }
        if (ids.length === 0) continue
        groups.set(provider, { ids, byId })
    }
    return { catalog, groups }
}

/**
 * 缓存条目结构校验（单条，嵌套于 provider→model 两层键之下）：条目来自磁盘 JSON（用户可编辑、写入可能被截断），
 * 而填充流程直接迭代 `entry.efforts`——一条坏条目会让整批填充抛错，故在入库前逐条判定。
 * 档位取值与 buildCatalog 写入口径严格一致（none ∪ LEVELS，含 'off'——目录原值保留，不归一）；
 * 任一条非法即整份文件作废走网络重拉（坏盘自愈优先级高于坏条丢弃）。
 * 未知多余键忽略（向前兼容：比当前代码更新的缓存不应整盘作废）；
 * provider/id 键属分组与嵌套键已承担的定位信息，出现在记录本体即判非法。
 */
export function isCacheRecord(value: unknown): value is CacheRecord {
    if (!isPlainObject(value)) return false
    const { efforts, contextWindow, maxTokens, image } = value as Partial<CacheRecord> & Record<string, unknown>
    if (!Array.isArray(efforts) || !efforts.every((effort) => typeof effort === 'string' && (effort === 'none' || LEVELS.has(effort)))) return false
    if (contextWindow !== undefined && !isCapacity(contextWindow)) return false
    if (maxTokens !== undefined && !isCapacity(maxTokens)) return false
    if (image !== undefined && image !== true) return false
    if ('provider' in value || 'id' in value) return false
    return true
}

/** 判断缓存文件顶层条目（model -> 记录映射）是否全部合法；任一不合法返回 undefined */
export function parseCacheGroup(value: unknown): Record<string, CacheRecord> | undefined {
    if (!isPlainObject(value)) return
    const group: Record<string, CacheRecord> = {}
    for (const [model, record] of Object.entries(value)) {
        if (!isCacheRecord(record)) return
        group[model] = record
    }
    return group
}

/**
 * 从缓存文件异步加载目录：顶层必须为对象（provider→model 两层嵌套；其他形态一律判不可用，交由网络拉取覆盖），
 * 逐层逐条校验，任一层/条不合法整份文件不可用（缓存为派生数据，坏盘自愈优先级高于坏条丢弃）。
 */
export async function readCache(): Promise<IndexedCatalog | undefined> {
    try {
        const parsed = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as unknown
        if (!isPlainObject(parsed)) return
        const catalog: Catalog = {}
        let usable = 0
        for (const [provider, group] of Object.entries(parsed)) {
            const records = parseCacheGroup(group)
            if (records === undefined) return
            if (Object.keys(records).length === 0) continue
            catalog[provider] = records
            usable += 1
        }
        if (usable === 0) return
        return indexFromCatalog(catalog)
    } catch {
        return
    }
}

/** 拉取 models.dev 最新数据：数据非空才构建索引；缓存内容有变化才写入，失败按 MAX_ATTEMPTS 重试并逐次告警，耗尽则放弃（不抛，本次运行仍用新目录）。拉取失败或数据为空时抛出，由调用方记录日志 */
export async function fetchLatest(ctx: Context): Promise<IndexedCatalog> {
    const res = await fetch(API_URL, {
        signal: AbortSignal.timeout(FETCH_MS),
        headers: { 'User-Agent': PLUGIN_NAME },
    })
    if (!res.ok) throw new Error(`${API_URL} -> ${res.status}`)
    const api = (await res.json()) as Record<string, unknown>
    const catalog = buildCatalog(api)
    // 空数据拒绝覆盖，避免坏响应破坏现有目录
    if (Object.keys(catalog).length === 0) throw new Error(`${API_URL} 返回的数据未包含可用的模型信息`)
    const indexed = indexFromCatalog(catalog)
    const serialized = JSON.stringify(catalog)
    if (!indexedCache || serialized !== JSON.stringify(indexedCache.catalog)) {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (!ctx.fiber.store) break
            try {
                await writeFile(CACHE_FILE, serialized)
                break
            } catch (error) {
                // 每次失败都记录，便于判断是一次成功还是重试后才成功
                ctx.logger.warn(
                    `${PLUGIN_NAME}: 写入缓存失败（第 ${attempt}/${MAX_ATTEMPTS} 次）：${errorText(error)}`,
                )
                if (attempt < MAX_ATTEMPTS) {
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
                }
            }
        }
    }
    return indexed
}
