import { readFile, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { API_URL, CACHE_FILE, FETCH_MS, LEVELS, MAX_ATTEMPTS, PROVIDER_API_FALLBACKS, RETRY_DELAY_MS } from '@/constants'
import { PLUGIN_NAME } from '@/shared/constants'
import { errorText } from '@/shared/errors'
import type { CacheGroup, CacheRecord, Catalog, IndexedCatalog, ModelEntry, ProviderGroup, IndexEntry } from '@/types'
import { isCapacity } from '@/types'
import { normalizeId } from '@/lookup'
import { isPlainObject } from '@/shared/types'

/** 目录尚未可用时的空兜底 */
const EMPTY_INDEX: IndexedCatalog = { catalog: {}, groups: new Map(), endpoints: new Map() }

let indexedCache: IndexedCatalog | undefined

export function getCatalog(): IndexedCatalog {
    return indexedCache ?? EMPTY_INDEX
}

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
    // 容量字段：非正整数与 99999999 哨兵（"无限/未公布"）视为无数据
    const limitRecord = isPlainObject(limit) ? limit : undefined
    const rawContext = limitRecord?.context
    const rawOutput = limitRecord?.output
    const contextWindow = isCapacity(rawContext) ? rawContext : undefined
    const maxTokens = isCapacity(rawOutput) ? rawOutput : undefined
    // 图片模态：仅记录支持图片的模型（置 true）；其他模态值忽略
    const rawInput = isPlainObject(modalities) && Array.isArray(modalities.input) ? modalities.input : undefined
    const image = !!rawInput && rawInput.includes('image')
    const hasReasoning = reasoning === true && (toggle || efforts.length > 0)
    const hasContext = contextWindow !== undefined || maxTokens !== undefined
    if (!hasReasoning && !hasContext && !image) return
    return { reasoning: hasReasoning, toggle, efforts, contextWindow, maxTokens, image }
}

/** 端点串：只认 http 开头（模板串与非 http 端点不作匹配依据） */
function isEndpoint(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith('http')
}

/** 提供方端点：models.dev 的 api 优先，否则查静态补全表 */
function providerApiOf(raw: unknown, providerId: string): string | undefined {
    if (isEndpoint(raw)) return raw
    return PROVIDER_API_FALLBACKS[providerId]
}

/** 模型级端点：models.dev 的 models.<id>.provider.api（对象形态） */
function modelApiOf(entry: unknown): string | undefined {
    if (!isPlainObject(entry)) return
    const provider = (entry as { provider?: unknown }).provider
    if (!isPlainObject(provider)) return
    const api = (provider as { api?: unknown }).api
    if (isEndpoint(api)) return api
}

/**
 * 将 models.dev 原始 JSON 构建为分组缓存：{ provider-id: { api?, models: { model-id: 条目 } } }，
 * 仅保留有可用推理级别、容量或支持图片的模型。
 * 组级 api 取 models.dev 的 provider.api（缺失时由静态补全表补），模型级 api 取该模型的 provider.api。
 * efforts 过滤为 harness 支持的取值，'off'/'none' 按目录原值保留；目录未列关闭档时不写入（"能通"不等于"能关"）。
 */
export function buildCatalog(api: Record<string, unknown> | undefined): Catalog {
    const catalog: Catalog = {}
    for (const [key, block] of Object.entries(api ?? {})) {
        if (!isPlainObject(block)) continue
        const models = (block as { models?: unknown }).models
        if (!isPlainObject(models)) continue
        const providerId = typeof (block as { id?: unknown }).id === 'string' ? (block as { id: string }).id : key
        const group: CacheGroup = { models: {} }
        const groupApi = providerApiOf((block as { api?: unknown }).api, providerId)
        if (groupApi !== undefined) group.api = groupApi
        for (const [id, entry] of Object.entries(models as Record<string, unknown>)) {
            const parsed = fromApiEntry(entry)
            if (!parsed) continue
            const efforts = [...new Set(parsed.efforts.filter((effort) => effort === 'none' || LEVELS.has(effort)))]
            const hasUsableReasoning = parsed.reasoning && efforts.some((effort) => effort !== 'none' && effort !== 'off')
            // 仅 none 的推理能力（无可选档位）不入库；容量或图片仍可
            if (!hasUsableReasoning && parsed.contextWindow === undefined && parsed.maxTokens === undefined && !parsed.image) continue
            const result: CacheRecord = {}
            if (hasUsableReasoning) result.efforts = efforts
            if (parsed.contextWindow !== undefined) result.contextWindow = parsed.contextWindow
            if (parsed.maxTokens !== undefined) result.maxTokens = parsed.maxTokens
            if (parsed.image) result.image = parsed.image
            const modelApi = modelApiOf(entry)
            if (modelApi !== undefined) result.api = modelApi
            group.models[id] = result
        }
        if (Object.keys(group.models).length > 0) catalog[providerId] = group
    }
    return catalog
}

/** 构建带 provider 分组索引与端点索引的目录；catalog 保留原引用（供 fetchLatest 序列化对比），索引条目另建 */
function indexFromCatalog(catalog: Catalog): IndexedCatalog {
    const groups = new Map<string, ProviderGroup>()
    const endpoints = new Map<string, string[]>()
    const register = (endpoint: string, provider: string): void => {
        const list = endpoints.get(endpoint)
        if (!list) endpoints.set(endpoint, [provider])
        else if (!list.includes(provider)) list.push(provider)
    }
    for (const [provider, group] of Object.entries(catalog)) {
        const ids: string[] = []
        const byId = new Map<string, IndexEntry>()
        for (const [id, record] of Object.entries(group.models)) {
            if (!isCacheRecord(record)) continue
            const entry: IndexEntry = { id, efforts: record.efforts ? record.efforts.slice() : [] }
            if (record.contextWindow !== undefined) entry.contextWindow = record.contextWindow
            if (record.maxTokens !== undefined) entry.maxTokens = record.maxTokens
            if (record.image) entry.image = true
            // 匹配键必须归一：目录 id 保留原始大小写，匹配只在小写空间进行（口径见 docs/decisions-config.md「参数来源」）
            const key = normalizeId(id)
            ids.push(key)
            if (!byId.has(key)) byId.set(key, entry)
        }
        if (ids.length === 0) continue
        groups.set(provider, { ids, byId })
        // 端点索引：组级 api 与模型级 api 都登记（模型级 api 是该模型的真实端点，组级 api 是该提供方的默认端点）
        if (group.api) register(group.api, provider)
        for (const record of Object.values(group.models)) {
            if (record.api) register(record.api, provider)
        }
    }
    return { catalog, groups, endpoints }
}

/**
 * 缓存条目结构校验：条目来自磁盘 JSON（用户可编辑、写入可能被截断），填充流程直接迭代 `entry.efforts`，故入库前逐条判定。
 * 档位键可缺省（模型无推理能力），取值须落在 none ∪ LEVELS（'off' 原值保留）；任一条非法即整份作废走网络重拉（坏盘自愈优先于坏条丢弃）；
 * 未知多余键忽略（向前兼容）；记录本体出现 `provider`/`id` 键即判非法。
 */
export function isCacheRecord(value: unknown): value is CacheRecord {
    if (!isPlainObject(value)) return false
    const { efforts, contextWindow, maxTokens, image, api } = value as Partial<CacheRecord> & Record<string, unknown>
    if (efforts !== undefined && (!Array.isArray(efforts) || !efforts.every((effort) => typeof effort === 'string' && (effort === 'none' || LEVELS.has(effort))))) return false
    if (contextWindow !== undefined && !isCapacity(contextWindow)) return false
    if (maxTokens !== undefined && !isCapacity(maxTokens)) return false
    if (image !== undefined && image !== true) return false
    if (api !== undefined && !isEndpoint(api)) return false
    if ('provider' in value || 'id' in value) return false
    return true
}

/** 判断缓存文件的一个分组条目是否合法（{ api?, models }）；不合法返回 undefined */
export function parseCacheGroup(value: unknown): CacheGroup | undefined {
    if (!isPlainObject(value)) return
    const { api, models } = value as { api?: unknown; models?: unknown }
    if (api !== undefined && !isEndpoint(api)) return
    if (!isPlainObject(models)) return
    const group: CacheGroup = { models: {} }
    if (api !== undefined) group.api = api
    for (const [model, record] of Object.entries(models)) {
        if (!isCacheRecord(record)) return
        group.models[model] = record
    }
    return group
}

/**
 * 从缓存文件异步加载目录：顶层必须为对象，逐层逐条校验；任一层/条不合法整份不可用（缓存为派生数据，坏盘自愈优先于坏条丢弃）。
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
            if (Object.keys(records.models).length === 0) continue
            catalog[provider] = records
            usable += 1
        }
        if (usable === 0) return
        return indexFromCatalog(catalog)
    } catch {
        return
    }
}

/** 拉取 models.dev 最新数据：数据非空才构建索引，内容有变化才写缓存；写缓存失败按 MAX_ATTEMPTS 重试，耗尽则放弃（本次运行仍用新目录）；拉取失败或数据为空抛出，由调用方记录日志 */
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
