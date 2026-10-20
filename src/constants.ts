import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EFFORT_LEVELS, MAX_ATTEMPTS } from '@/shared/constants'

// MAX_ATTEMPTS 跨半共享在 src/shared/constants.ts；此处 re-export 保持 Node 半既有 import 路径不变
export { MAX_ATTEMPTS }

/** models.dev 容量字段对"无限/未公布"的哨兵建模值，视为无数据 */
export const CAPACITY_UNLIMITED = 99_999_999

export const API_URL = 'https://models.dev/api.json'
/** 拉取超时（毫秒） */
export const FETCH_MS = 10_000
/** 拉取与缓存写入失败后的固定重试间隔（毫秒） */
export const RETRY_DELAY_MS = 5_000
/** 事件驱动刷新的最小间隔（毫秒）：距上次成功拉取不足该时长时，事件只填充不重新拉取 */
export const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 缓存文件路径（基于模块路径定位，public/ 经构建平铺复制到 lib/ 根；网络拉取成功后覆盖） */
export const CACHE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'models-cache.json')

/** 推理级别取值集合，与 harness 的 ModelThinkingLevel 一致（有序表在跨半共享层，两半同源） */
export const LEVELS: ReadonlySet<string> = new Set(EFFORT_LEVELS)

/** compat 组开关共同管辖的协议：只作用于 OpenAI Chat Completions 风格路由；宿主只在 `openai-completions` offer 这两个字段，其余协议的写入被宿主按协议 gate 静默跳过 */
export const COMPAT_APIS = new Set(['openai-completions'])
/** disableDeveloper 对应的 provider 路由 compat 字段名（开启写 false，关闭删键） */
export const DEVELOPER_COMPAT_FIELD = 'supportsDeveloperRole'
/** disableStore 对应的 provider 路由 compat 字段名（开启写 false，关闭删键） */
export const STORE_COMPAT_FIELD = 'supportsStore'

/**
 * models.dev 缺失 api 字段时的端点补全表：provider id → 端点。
 * 只收端点固定稳定的主流提供方（账号级/环境变量决定的端点不入表，那类端点本就静态不可知）。
 * 仅在构建缓存时使用；models.dev 自带 api 时以其为准。
 */
export const PROVIDER_API_FALLBACKS: Readonly<Record<string, string | undefined>> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com',
    google: 'https://generativelanguage.googleapis.com/v1beta',
    xai: 'https://api.x.ai/v1',
    groq: 'https://api.groq.com/openai/v1',
    mistral: 'https://api.mistral.ai',
    cerebras: 'https://api.cerebras.ai/v1',
    togetherai: 'https://api.together.ai/v1',
    perplexity: 'https://api.perplexity.ai',
    cohere: 'https://api.cohere.ai/compatibility/v1',
    vercel: 'https://ai-gateway.vercel.sh/v1',
}
