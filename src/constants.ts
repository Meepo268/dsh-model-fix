import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EFFORT_LEVELS } from '@/shared/constants'

/** 最低支持（可升级读取）的版本；低于此值的版本快照视为已失效（运行时不读取、迁移时清理） */
export const MIN_SUPPORTED_VERSION = 3
/**
 * 低于当前版本的旧快照保留上限，超出在启动时从最低版本清理（等于或高于当前版本的快照始终保留，供无损回退）。
 * 取 1 ⇒ 段内低于当前版本的快照合计最多留 1 个，其余从最低版本起淘汰。
 */
export const MAX_OLD_SNAPSHOTS = 1

/** models.dev 容量字段对"无限/未公布"的哨兵建模值，视为无数据 */
export const CAPACITY_UNLIMITED = 99_999_999

export const API_URL = 'https://models.dev/api.json'
/** 拉取超时（毫秒） */
export const FETCH_MS = 10_000
/** 拉取、缓存写入与填充冲突共用的总尝试次数 */
export const MAX_ATTEMPTS = 3
/** 拉取与缓存写入失败后的固定重试间隔（毫秒） */
export const RETRY_DELAY_MS = 5_000
/** 事件驱动刷新的最小间隔（毫秒）：距上次成功拉取不足该时长时，事件只填充不重新拉取 */
export const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 缓存文件路径（基于模块路径定位，public/ 经构建平铺复制到 lib/ 根；网络拉取成功后覆盖） */
export const CACHE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'models-cache.json')

/** 推理级别取值集合，与 harness 的 ModelThinkingLevel 一致（有序表在跨半共享层，两半同源） */
export const LEVELS: ReadonlySet<string> = new Set(EFFORT_LEVELS)

/**
 * compat 组开关共同管辖的协议：只作用于 OpenAI Chat Completions 风格的路由（自定义端点的主流形态）。
 * 宿主只在 `openai-completions` offer 这两个字段（`COMPLETIONS_COMPAT_GATE`，见 docs/host-api.md），其余协议的写入被宿主按协议 gate 静默跳过。
 */
export const COMPAT_APIS = new Set(['openai-completions'])
/** disableDeveloper 对应的 provider 路由 compat 字段名（开启写 false，关闭删键） */
export const DEVELOPER_COMPAT_FIELD = 'supportsDeveloperRole'
/** disableStore 对应的 provider 路由 compat 字段名（开启写 false，关闭删键） */
export const STORE_COMPAT_FIELD = 'supportsStore'

/** 模型名前缀 -> 官方提供方，用于跨提供方匹配同源模型 */
export const HINTS: ReadonlyArray<readonly [string, string]> = [
    ['deepseek', 'deepseek'],
    ['claude', 'anthropic'],
    ['kimi', 'moonshotai'],
    ['grok', 'xai'],
    ['gpt', 'openai'],
]
