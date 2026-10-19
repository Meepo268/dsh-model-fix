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

/** 模型名前缀 -> 官方提供方候选（依序尝试），用于跨提供方匹配同源模型；前缀须全小写（匹配前已对裸名 lowercase），取舍依据见 docs/decisions.md「参数来源」 */
export const HINTS: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['deepseek', ['deepseek']],
    ['claude', ['anthropic']],
    ['kimi', ['moonshotai', 'moonshotai-cn']],
    ['grok', ['xai']],
    ['gpt', ['openai']],
    ['chatgpt', ['openai']],
    ['o1', ['openai']],
    ['o3', ['openai']],
    ['o4', ['openai']],
    ['gemini', ['google']],
    ['gemma', ['google']],
    ['qwen', ['alibaba', 'alibaba-cn']],
    ['glm', ['zai', 'zhipuai']],
    ['mistral', ['mistral']],
    ['magistral', ['mistral']],
    ['codestral', ['mistral']],
    ['ministral', ['mistral']],
    ['pixtral', ['mistral']],
    ['mixtral', ['mistral']],
    ['voxtral', ['mistral']],
    ['devstral', ['mistral']],
    ['minimax', ['minimax', 'minimax-cn']],
]
