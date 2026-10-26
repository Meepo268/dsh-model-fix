// upstream.ts 测试：`/models` 回包解析（纯函数）、地址归一、抓取去重/TTL/失败回落、注入点
import type { Context } from '@deepseek-ai/cordis'
import { check, stable } from '@test/helper'
import {
    altModelsUrl,
    clearUpstreamCache,
    declarationOf,
    fetchDeclarations,
    modelsUrl,
    parseDeclarations,
    setDeclarationSource,
    UPSTREAM_FAIL_TTL_MS,
    UPSTREAM_TTL_MS,
} from '@/upstream'
import type { DeclarationMap } from '@/upstream'

interface Call {
    url: string
    headers: Record<string, string>
}

const CALLS: Call[] = []
const ORIGIN = globalThis.fetch

/** 用假 fetch 替换全局（只影响本文件用例），按 url 决定回包 */
function stubFetch(reply: (url: string) => { status?: number; body?: unknown }): void {
    globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
        const url = String(input)
        CALLS.push({ url, headers: init?.headers ?? {} })
        const { status = 200, body = { data: [] } } = reply(url)
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
}

function restoreFetch(): void {
    globalThis.fetch = ORIGIN
}

/** 最小 ctx：只要 logger.debug 与 credentials.resolve */
const CTX = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    credentials: { resolve: async () => ({ value: 'sk-test' }) },
} as unknown as Context

const DECLARED = {
    data: [
        { id: 'a', reasoning_supported_efforts: ['low', 'HIGH', 'none'], context_window: 200_000, max_output_tokens: 32_000, input_modalities: ['text', 'image'] },
        { id: 'b', reasoning_options: [{ type: 'effort', values: ['medium', 'max'] }], limit: { context: 8_000, output: 4_000 } },
        { id: 'c', supported_parameters: { reasoning_efforts: ['low'] }, architecture: { input_modalities: ['text', 'image'] } },
        { id: 'd', capabilities: { reasoning_efforts: ['high'] }, supports_images: true },
        { id: 'e', context_window: 99999999, max_output_tokens: 0 },
        { id: 'f' },
        { name: 'no-id' },
        42,
        { id: 7 },
    ],
}

export async function run(): Promise<void> {
    // 本文件自己控制声明来源：先清掉 @test/ctx.ts 默认注入的空来源
    setDeclarationSource(undefined)
    clearUpstreamCache()

    // modelsUrl：去尾斜杠后接 /models（baseURL 已含 /v1）
    check('modelsUrl 拼接去尾斜杠', modelsUrl('https://x/v1/') === 'https://x/v1/models' && modelsUrl('https://x/v1') === 'https://x/v1/models' && modelsUrl('https://x/v1///') === 'https://x/v1/models')

    // parseDeclarations：与目录同形的声明，缺项即「未声明」
    const parsed = parseDeclarations(DECLARED)
    check('parse 只保留有可用信息的模型（无 id 与非对象条目丢弃）', stable([...parsed.keys()]) === stable(['a', 'b', 'c', 'd']))
    check('parse 档位：小写化 + none 折算 off + 过滤未知档位', stable(parsed.get('a')?.efforts) === stable(['low', 'high', 'off']))
    check('parse 容量：context_window / max_output_tokens', parsed.get('a')?.contextWindow === 200_000 && parsed.get('a')?.maxTokens === 32_000)
    check('parse 模态：input_modalities 含 image 即支持图片', parsed.get('a')?.image === true)
    check('parse reasoning_options[].values 变体', stable(parsed.get('b')?.efforts) === stable(['medium', 'max']))
    check('parse limit.context / limit.output 兜底', parsed.get('b')?.contextWindow === 8_000 && parsed.get('b')?.maxTokens === 4_000)
    check('parse supported_parameters 与 architecture 变体', stable(parsed.get('c')?.efforts) === stable(['low']) && parsed.get('c')?.image === true)
    check('parse capabilities 与 supports_images 变体', stable(parsed.get('d')?.efforts) === stable(['high']) && parsed.get('d')?.image === true)
    check('parse 哨兵容量（无上限）与非正数视为未声明', parsed.has('e') === false)
    check('parse 接受裸数组与 {models:[…]} 两种外壳', stable([...parseDeclarations([{ id: 'x', context_window: 100 }]).keys()]) === stable(['x']) && stable([...parseDeclarations({ models: [{ id: 'y' }] }).keys()]) === stable([]) && parseDeclarations({ models: [{ id: 'y', max_tokens: 10 }] }).get('y')?.maxTokens === 10)
    check('parse 垃圾回包返回空表', parseDeclarations(null).size === 0 && parseDeclarations('x').size === 0 && parseDeclarations({ data: 42 }).size === 0)

    // 抓取：同地址去重、密钥、TTL、失败回落
    clearUpstreamCache()
    CALLS.length = 0
    stubFetch(() => ({ body: DECLARED }))
    try {
        const providers = {
            a: { baseURL: 'https://gw/v1/', apiKeyEnv: 'GW_KEY' },
            b: { baseURL: 'https://gw/v1' },
            c: { models: [] },
            d: { baseURL: 'file:///tmp' },
        }
        const first = await fetchDeclarations(CTX, providers)
        check('同 baseURL 的两条路由只发一次请求（尾斜杠归一）', CALLS.length === 1 && CALLS[0]?.url === 'https://gw/v1/models', CALLS)
        check('无 baseURL 的提供方不发请求（file:// 也不算）', CALLS.every(call => call.url.startsWith('https://')))
        check('声明按提供方 id 分发给同地址的每条路由', first.has('a') && first.has('b') && first.get('b')?.get('a')?.contextWindow === 200_000)
        check('密钥取自该地址下声明了 apiKeyEnv 的提供方', CALLS[0]?.headers.authorization === 'Bearer sk-test')
    } finally {
        restoreFetch()
    }

    // 密钥乱序：带密钥的提供方排在后面也要用上
    clearUpstreamCache()
    CALLS.length = 0
    stubFetch(() => ({ body: DECLARED }))
    try {
        await fetchDeclarations(CTX, { plain: { baseURL: 'https://gw2/v1' }, keyed: { baseURL: 'https://gw2/v1', apiKeyEnv: 'K' } })
        check('密钥与提供方声明顺序无关', CALLS[0]?.headers.authorization === 'Bearer sk-test', CALLS)
    } finally {
        restoreFetch()
    }

    // 凭据解析失败：照发无鉴权请求（网关可能允许匿名），不抛
    clearUpstreamCache()
    CALLS.length = 0
    stubFetch(() => ({ body: DECLARED }))
    try {
        const denied = { ...CTX, credentials: { resolve: async () => { throw new Error('no secret') } } } as unknown as Context
        const map = await fetchDeclarations(denied, { a: { baseURL: 'https://gw3/v1', apiKeyEnv: 'K' } })
        check('凭据解析失败仍抓取（不带鉴权）', map.has('a') && CALLS[0]?.headers.authorization === undefined, CALLS)
    } finally {
        restoreFetch()
    }

    // TTL：小时内复用，超时重抓
    clearUpstreamCache()
    CALLS.length = 0
    stubFetch(() => ({ body: DECLARED }))
    try {
        const providers = { a: { baseURL: 'https://gw4/v1' } }
        const now = Date.now()
        await fetchDeclarations(CTX, providers, now)
        await fetchDeclarations(CTX, providers, now + UPSTREAM_TTL_MS - 1)
        check('TTL 内复用缓存（不重复请求）', CALLS.length === 1, CALLS.length)
        await fetchDeclarations(CTX, providers, now + UPSTREAM_TTL_MS + 1)
        check('TTL 过期后重抓', CALLS.length === 2, CALLS.length)
    } finally {
        restoreFetch()
    }

    // 失败：整批不抛、providers 不出现在结果里，短 TTL 内不反复打端点
    clearUpstreamCache()
    CALLS.length = 0
    stubFetch((url) => url.includes('bad') ? { status: 500 } : { body: DECLARED })
    try {
        const now = Date.now()
        const providers = { good: { baseURL: 'https://ok/v1' }, bad: { baseURL: 'https://bad/v1' } }
        const map = await fetchDeclarations(CTX, providers, now)
        check('单点失败不影响其它提供方', map.has('good') && !map.has('bad'))
        const before = CALLS.length
        await fetchDeclarations(CTX, providers, now + 1_000)
        check('失败态在短 TTL 内不重试（只补抓未缓存的地址）', CALLS.length === before, CALLS.length)
        await fetchDeclarations(CTX, providers, now + UPSTREAM_FAIL_TTL_MS + 1)
        check('短 TTL 过期后重试同一地址', CALLS.filter(call => call.url.includes('bad')).length === 2, CALLS.map(c => c.url))
    } finally {
        restoreFetch()
    }

    // 注入点：loader 覆盖真实抓取，传 undefined 后恢复并清缓存
    CALLS.length = 0
    stubFetch(() => ({ body: DECLARED }))
    try {
        setDeclarationSource(async () => new Map([['p', new Map([['m', { efforts: ['low'], contextWindow: 1 }]])]]))
        const injected = await fetchDeclarations(CTX, { p: { baseURL: 'https://gw5/v1' } })
        check('注入的声明来源生效且不发请求', injected.get('p')?.get('m')?.contextWindow === 1 && CALLS.length === 0, CALLS)
        setDeclarationSource(undefined)
        await fetchDeclarations(CTX, { p: { baseURL: 'https://gw5/v1' } })
        check('清除注入后恢复真实抓取', CALLS.length === 1, CALLS.length)
    } finally {
        setDeclarationSource(undefined)
        restoreFetch()
    }

    // 备用路径：baseURL 没带版本段时，404/405 才换 `/v1/models` 再试一次
    check('altModelsUrl 无版本段时补 /v1', altModelsUrl('https://gw') === 'https://gw/v1/models', altModelsUrl('https://gw'))
    check('altModelsUrl 尾斜杠归一', altModelsUrl('https://gw/') === 'https://gw/v1/models')
    check('altModelsUrl 保留已有子路径', altModelsUrl('https://gw/api') === 'https://gw/api/v1/models')
    check('altModelsUrl 已带 /v1 不再叠层', altModelsUrl('https://gw/v1') === undefined && altModelsUrl('https://gw/v1beta') === undefined && altModelsUrl('https://gw/v2/') === undefined)
    CALLS.length = 0
    clearUpstreamCache()
    stubFetch((url) => (url.endsWith('/v1/models') ? { body: DECLARED } : { status: 404 }))
    try {
        const viaAlt = await fetchDeclarations(CTX, { a: { baseURL: 'https://gw-nowrap' } })
        check('主路径 404 时回落 /v1/models 并取到声明', viaAlt.get('a')?.get('a')?.contextWindow === 200_000, CALLS.map(call => call.url))
        check('两次请求：先 /models 再 /v1/models', CALLS.length === 2 && CALLS[0]?.url.endsWith('/models') === true && CALLS[1]?.url.endsWith('/v1/models') === true, CALLS.map(call => call.url))
    } finally {
        restoreFetch()
    }
    CALLS.length = 0
    clearUpstreamCache()
    stubFetch(() => ({ status: 401 }))
    try {
        const rejected = await fetchDeclarations(CTX, { a: { baseURL: 'https://gw-locked' } })
        check('401 不换路径重试（只打一次）', rejected.size === 0 && CALLS.length === 1, CALLS.map(call => call.url))
    } finally {
        restoreFetch()
    }

    // declarationOf：网关自报的 id 与调用 id 不同形时仍能对上（宁缺不错配）
    const DECLARED_TABLE: DeclarationMap = new Map([['p', new Map([
        ['deepseek-v4-pro', { contextWindow: 1_000_000 }],
        ['cn:glm-5.3', { contextWindow: 200_000 }],
        ['hy4-preview', { contextWindow: 64_000 }],
        ['hy4-preview-f', { contextWindow: 128_000 }],
    ])]])
    check('declarationOf 原样精确命中', declarationOf(DECLARED_TABLE, 'p', 'deepseek-v4-pro')?.contextWindow === 1_000_000)
    check('declarationOf 配置带前缀、声明不带前缀', declarationOf(DECLARED_TABLE, 'p', 'cn:deepseek-v4-pro')?.contextWindow === 1_000_000)
    check('declarationOf 配置不带前缀、声明带前缀', declarationOf(DECLARED_TABLE, 'p', 'glm-5.3')?.contextWindow === 200_000)
    check('declarationOf 剥前缀后直接命中（无需判歧义）', declarationOf(DECLARED_TABLE, 'p', 'cn:hy4-preview')?.contextWindow === 64_000)
    const AMBIGUOUS: DeclarationMap = new Map([['p', new Map([
        ['cn:glm-5.3', { contextWindow: 1 }],
        ['zz:glm-5.3', { contextWindow: 2 }],
    ])]])
    check('declarationOf 多个前缀同形 → 放弃', declarationOf(AMBIGUOUS, 'p', 'glm-5.3') === undefined)
    check('declarationOf 提供方不存在给 undefined', declarationOf(DECLARED_TABLE, 'x', 'deepseek-v4-pro') === undefined && declarationOf(undefined, 'p', 'x') === undefined)
}
