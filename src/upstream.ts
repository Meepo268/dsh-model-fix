/**
 * 上游能力声明：自定义/聚合供应商的 `GET {baseURL}/models` 常自报推理档位、容量与输入模态
 * （`reasoning_supported_efforts` / `context_window` / `input_modalities`…）。这类声明比 models.dev 权威——
 * models.dev 是第三方镜像，档位名与容量都会滞后或按官方口径改写（例：网关公告 `high,xhigh` 而镜像写 `low,high,max`）。
 *
 * 本文件只做两件事：把端点回包解析成与目录同形的声明（纯函数，可单测），以及带缓存的抓取（best-effort）。
 * 抓取失败一律当作「端点没说话」，由调用方回落到 models.dev：网络问题不该拦下填充。
 *
 * 取舍见 docs/decisions-config.md「参数来源」：手填 > 上游声明 > models.dev。
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { FETCH_MS, LEVELS } from '@/constants'
import { isCapacity } from '@/types'
import { isPlainObject } from '@/shared/types'

/** 单个模型的上游声明：缺项表示端点未声明该维度（不是「声明为无」） */
export interface Declaration {
    /** 推理档位（已过滤到 harness 支持的取值，`none` 已折算为 `off`） */
    efforts?: string[]
    contextWindow?: number
    maxTokens?: number
    image?: boolean
}

/** provider id → 模型 id（原样，含命名空间前缀）→ 声明 */
export type DeclarationMap = Map<string, Map<string, Declaration>>

/** 声明来源（测试注入点）：给定提供方表，返回各提供方的声明表；生产实现见 `fetchFromEndpoints` */
export type DeclarationLoader = (providers: Record<string, unknown>) => Promise<DeclarationMap>

/** 抓取结果缓存时长：与目录刷新同节奏，避免每次保存都打端点 */
export const UPSTREAM_TTL_MS = 6 * 60 * 60 * 1000
/** 抓取失败的短缓存：既不反复打挂掉的端点，也给修好的端点一分钟内自愈的机会 */
export const UPSTREAM_FAIL_TTL_MS = 60 * 1000

/** 端点回包里取数组：OpenAI 风格 `{data:[…]}`、少数网关 `{models:[…]}`、或直接是数组 */
function entriesOf(payload: unknown): unknown[] | undefined {
    if (Array.isArray(payload)) return payload
    if (!isPlainObject(payload)) return
    const data = payload.data
    if (Array.isArray(data)) return data
    const models = payload.models
    return Array.isArray(models) ? models : undefined
}

/** 取第一个正整数容量（哨兵值与非正数视为未声明） */
function firstCapacity(...values: unknown[]): number | undefined {
    for (const value of values) {
        if (isCapacity(value)) return value
    }
}

/** 从若干候选字段里收集档位名：`reasoning_supported_efforts` / `supported_parameters.reasoning_efforts` /
 * `reasoning_options[].values` / `capabilities.reasoning_efforts`，统一小写并把 `none` 折算为 `off` */
function effortsOf(entry: Record<string, unknown>): string[] | undefined {
    const candidates: unknown[] = [entry.reasoning_supported_efforts]
    const supported = entry.supported_parameters
    if (isPlainObject(supported)) candidates.push(supported.reasoning_efforts)
    const capabilities = entry.capabilities
    if (isPlainObject(capabilities)) candidates.push(capabilities.reasoning_efforts)
    const options = entry.reasoning_options
    if (Array.isArray(options)) {
        for (const option of options) {
            if (isPlainObject(option) && Array.isArray(option.values)) candidates.push(option.values)
        }
    }
    const collected: string[] = []
    for (const candidate of candidates) {
        if (!Array.isArray(candidate)) continue
        for (const value of candidate) {
            if (typeof value !== 'string') continue
            const level = value.toLowerCase() === 'none' ? 'off' : value.toLowerCase()
            if (LEVELS.has(level) && !collected.includes(level)) collected.push(level)
        }
    }
    return collected.length > 0 ? collected : undefined
}

/** 端点是否声明了图片输入：`input_modalities`（网关）或 `architecture.input_modalities` / `supports_images`（OpenRouter 风格） */
function imageOf(entry: Record<string, unknown>): boolean | undefined {
    if (entry.supports_images === true) return true
    const lists: unknown[] = [entry.input_modalities]
    const architecture = entry.architecture
    if (isPlainObject(architecture)) lists.push(architecture.input_modalities)
    for (const list of lists) {
        if (!Array.isArray(list)) continue
        if (list.some((item) => typeof item === 'string' && item.toLowerCase() === 'image')) return true
    }
}

/**
 * 解析端点 `/models` 回包为「模型 id → 声明」；无任何可用信息的模型直接丢弃（与目录同口径：空壳不参与）。
 * 纯函数：不抓网络、不读配置。
 */
export function parseDeclarations(payload: unknown): Map<string, Declaration> {
    const result = new Map<string, Declaration>()
    for (const entry of entriesOf(payload) ?? []) {
        if (!isPlainObject(entry)) continue
        const rawId = entry.id ?? entry.model
        if (typeof rawId !== 'string' || rawId === '') continue
        const limit = isPlainObject(entry.limit) ? entry.limit : undefined
        const top = isPlainObject(entry.top_provider) ? entry.top_provider : undefined
        const declaration: Declaration = {}
        const efforts = effortsOf(entry)
        if (efforts) declaration.efforts = efforts
        const contextWindow = firstCapacity(
            entry.context_window,
            entry.context_length,
            entry.max_input_tokens,
            limit?.context,
            top?.context_length,
        )
        if (contextWindow !== undefined) declaration.contextWindow = contextWindow
        const maxTokens = firstCapacity(
            entry.max_output_tokens,
            entry.max_completion_tokens,
            entry.max_tokens,
            limit?.output,
            top?.max_completion_tokens,
        )
        if (maxTokens !== undefined) declaration.maxTokens = maxTokens
        const image = imageOf(entry)
        if (image) declaration.image = image
        if (Object.keys(declaration).length > 0) result.set(rawId, declaration)
    }
    return result
}

/** 端点地址：`baseURL` 去掉尾斜杠后接 `/models`（OpenAI 兼容路由的 baseURL 已含 `/v1`） */
export function modelsUrl(baseURL: string): string {
    return `${baseURL.replace(/\/+$/, '')}/models`
}

/** 抓取缓存：按 baseURL 记（同一地址多路由共享一份回包） */
interface CacheSlot {
    readonly at: number
    readonly value: Map<string, Declaration>
    readonly ttl: number
}
const cache = new Map<string, CacheSlot>()

/** 进行中的抓取（同地址并发去重：一批里多条路由共用一次请求） */
const inflight = new Map<string, Promise<Map<string, Declaration>>>()

/** 测试注入的声明来源；未注入时走真实端点抓取 */
let loader: DeclarationLoader | undefined

/** 注入声明来源（测试用）；传 undefined 恢复真实抓取并清空缓存 */
export function setDeclarationSource(next: DeclarationLoader | undefined): void {
    loader = next
    if (next === undefined) cache.clear()
}

/** 清空抓取缓存（测试与「强制更新」用） */
export function clearUpstreamCache(): void {
    cache.clear()
}

/** 解析提供方密钥：`apiKeyEnv` 是凭据**引用名**，经 `ctx.credentials` 现解析；未配置或解析失败返回 undefined。
 * 引用名合法性不在这里预判——宿主的环境变量名形态五花八门（`GW_KEY`、`WK7002_API_KEY`…），
 * 交给 `credentialRef()` 与 `resolve()` 判定，异常吞掉即可（抓不到密钥就发匿名请求，端点自会拒绝） */
async function resolveKey(ctx: Context, profile: Record<string, unknown>): Promise<string | undefined> {
    const env = profile.apiKeyEnv
    if (typeof env !== 'string' || env.trim() === '') return
    try {
        const resolved = await ctx.credentials.resolve(credentialRef(env.trim()))
        return resolved?.value
    } catch {
        return
    }
}

/** 抓一个端点的声明；失败抛错由调用方吞掉（best-effort） */
async function fetchOne(url: string, key: string | undefined): Promise<Map<string, Declaration>> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (key !== undefined && key !== '') headers.authorization = `Bearer ${key}`
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_MS) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return parseDeclarations(await response.json())
}

/**
 * 抓取所有「有 baseURL 的提供方」的上游声明：并发发起、单点失败静默（回落到目录），结果按 TTL 缓存。
 * 同一地址的多条路由共享一份回包（`/models` 与路由无关）：**去重键是归一化后的 URL**，
 * 故 `https://gw/v1` 与 `https://gw/v1/` 算同一端点，只发一次请求；并发期用进行中的 Promise 去重，
 * 密钥取该地址下任一声明了 `apiKeyEnv` 的提供方。
 * 返回 provider id → 声明表；无任何可用声明时返回空 Map（调用方据此跳过装配）。
 */
async function fetchFromEndpoints(
    ctx: Context,
    providers: Record<string, unknown>,
    now: number,
): Promise<DeclarationMap> {
    const result: DeclarationMap = new Map()
    /** url → 声明（空表 = 本批已知失败，直接回落目录）；同批多个提供方共享 */
    const loaded = new Map<string, Map<string, Declaration>>()
    /** 参与抓取的提供方（先扫一遍再抓，密钥与地址的顺序差异才不影响结果） */
    const targets: { providerId: string; url: string }[] = []
    /** url → 该地址下第一条声明了 apiKeyEnv 的提供方（回包与路由无关，谁有密钥都一样） */
    const keys = new Map<string, string>()
    for (const [providerId, profile] of Object.entries(providers)) {
        if (!isPlainObject(profile)) continue
        const baseURL = profile.baseURL
        if (typeof baseURL !== 'string' || !/^https?:\/\//i.test(baseURL)) continue
        const url = modelsUrl(baseURL)
        targets.push({ providerId, url })
        if (typeof profile.apiKeyEnv === 'string' && !keys.has(url)) keys.set(url, profile.apiKeyEnv)
    }
    const jobs: Promise<void>[] = []
    for (const { url } of targets) {
        if (loaded.has(url)) continue
        const slot = cache.get(url)
        if (slot && now - slot.at < slot.ttl) {
            loaded.set(url, slot.value)
            continue
        }
        const pending = inflight.get(url)
        if (pending) {
            loaded.set(url, new Map())
            jobs.push(pending.then((value) => { loaded.set(url, value) }))
            continue
        }
        const job = (async (): Promise<Map<string, Declaration>> => {
            try {
                const value = await fetchOne(url, await resolveKey(ctx, { apiKeyEnv: keys.get(url) }))
                cache.set(url, { at: Date.now(), value, ttl: UPSTREAM_TTL_MS })
                return value
            } catch (error) {
                // 端点不可达/拒绝：短缓存失败态，交给目录兜底；仅告警不抛（保存配置不该因上游抖动失败）
                cache.set(url, { at: Date.now(), value: new Map(), ttl: UPSTREAM_FAIL_TTL_MS })
                ctx.logger.debug(`upstream: 声明抓取失败（${url}）：${String(error)}`)
                return new Map()
            }
        })()
        inflight.set(url, job)
        loaded.set(url, new Map())
        jobs.push(job.then((value) => { loaded.set(url, value) }).finally(() => { inflight.delete(url) }))
    }
    await Promise.all(jobs)
    for (const { providerId, url } of targets) {
        const value = loaded.get(url)
        if (value !== undefined && value.size > 0) result.set(providerId, value)
    }
    return result
}

/** 抓取上游声明（带缓存与失败回落）；测试可经 `setDeclarationSource` 换掉真实端点 */
export async function fetchDeclarations(
    ctx: Context,
    providers: Record<string, unknown>,
    now = Date.now(),
): Promise<DeclarationMap> {
    if (loader) return loader(providers)
    return fetchFromEndpoints(ctx, providers, now)
}
