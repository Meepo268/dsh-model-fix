/** Node 半类型定义与纯类型守卫：models.dev 目录类型、`isCapacity`、冻结历史版本（当前只剩 v7）快照形态。
 * 跨半共享类型与守卫单一来源在 `src/shared/types.ts`，两半均直连 */

import { CAPACITY_UNLIMITED } from '@/constants'
import type { EffortMemory } from '@/shared/types'

/** models.dev 单条条目的推理、容量与模态解析结果 */
export interface ModelEntry {
    reasoning: boolean
    toggle: boolean
    efforts: string[]
    /** 最大上下文窗口（tokens），models.dev 未提供时为 undefined */
    contextWindow?: number
    /** 最大输出 tokens，models.dev 未提供时为 undefined */
    maxTokens?: number
    /** 支持图片输入（modalities.input 含 'image'）时为 true；纯文本或未提供模态信息均为 undefined */
    image?: boolean
}

/** 磁盘缓存条目：去掉 provider/id 两字段（分组键与嵌套键已承担），体积更小；内存索引（IndexEntry）为补全分组键的完整条目 */
export interface CacheRecord {
    /** 可选推理级别，'off'/'none' 为目录原值（表示可关闭推理）；模型无可用推理能力时整个键不写 */
    efforts?: string[]
    /** 最大上下文窗口（tokens），仅当 models.dev 提供 */
    contextWindow?: number
    /** 最大输出 tokens，仅当 models.dev 提供 */
    maxTokens?: number
    /** 支持图片输入时为 true；纯文本模型省略此字段（不缓存 false，控制体积） */
    image?: boolean
    /** 该模型的实际端点（models.dev 模型级 provider.api）；缺省即继承所属提供方的 api */
    api?: string
}

/** 磁盘缓存的一个提供方分组：组级端点 + 该提供方的模型表 */
export interface CacheGroup {
    /** 该提供方的端点（models.dev provider.api；缺失时由静态端点表补全） */
    api?: string
    /** 模型表：模型 id → 缓存条目 */
    models: Record<string, CacheRecord>
}

/** 磁盘缓存：{ provider-id: 分组 }，provider 只作外层键，消除逐条重复 */
export type Catalog = Record<string, CacheGroup>

/** 内存索引条目：缓存条目（CacheRecord）补上分组键下的 model id，供 lookup/fix 按 provider+id 消费 */
export interface IndexEntry {
    id: string
    efforts: string[]
    contextWindow?: number
    maxTokens?: number
    image?: boolean
}

/** 按 provider 分组的内存索引（供 lookup 复用）：`ids` 存归一后的匹配键（三级匹配在归一空间进行，键须先归一），`byId` 是归一键到条目的直查表（同组内归一后重复保留首个）。口径见 docs/decisions.md「参数来源」 */
export interface ProviderGroup {
    ids: string[]
    byId: Map<string, IndexEntry>
}

/** 目录及其预构建的 provider 分组索引 */
export interface IndexedCatalog {
    catalog: Catalog
    groups: Map<string, ProviderGroup>
    /** 端点 → 指向该端点的提供方 id（组级 api 与模型级 api 都登记；严格字符串匹配，不做归一） */
    endpoints: Map<string, string[]>
}

/** 判断是否为可写回的容量值：正整数且非哨兵（harness schema 要求 step(1).min(1)；0 与 99999999 均视为无数据） */
export function isCapacity(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value !== CAPACITY_UNLIMITED
}

// ---------- 历史版本（v7）冻结形态：定义不随代码演进（引入 subagent 之前的快照） ----------

/** 历史版本(v7)：字段规则（冻结形态，独立声明） */
export interface V7FieldRules {
    reasoning: boolean
    context: boolean
    image: boolean
}

/** 历史版本(v7)：兼容性规则（冻结形态，独立声明；只含 disableDeveloper） */
export interface V7CompatRules {
    disableDeveloper: boolean
}

/** 历史版本(v7)：用户体验规则（冻结形态，独立声明；只含三键） */
export interface V7UserExperienceRules {
    rememberEfforts: boolean
    defaultHigh: boolean
    forgetRemoved: boolean
}

/** 历史版本(v7)配置快照 */
export interface V7PluginConfigSnapshot {
    configVersion: number
    allowUpdate: V7FieldRules
    autoFill: V7FieldRules
    compat: V7CompatRules
    excludes: string[]
    efforts: EffortMemory
    userExperience: V7UserExperienceRules
}
