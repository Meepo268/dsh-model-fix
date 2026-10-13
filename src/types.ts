/**
 * Node 半类型定义与纯类型守卫。
 *
 * 本文件只保留 Node 专属：models.dev 目录类型（`ModelEntry`/`CacheRecord`/…）、`isCapacity`、
 * 冻结历史版本（v3–v7）快照形态。跨半共享类型与守卫单一来源在 `src/shared/types.ts`，两半均直连。
 */

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

/**
 * 磁盘缓存条目：去掉 provider/id 两字段（分组键与嵌套键已承担），体积更小。
 * 内存索引（IndexEntry）为补全分组键的完整条目，供 lookup/fix 消费。
 */
export interface CacheRecord {
    /** 可选推理级别，'off'/'none' 为目录原值（表示可关闭推理）；无可选档位时为空数组 */
    efforts: string[]
    /** 最大上下文窗口（tokens），仅当 models.dev 提供 */
    contextWindow?: number
    /** 最大输出 tokens，仅当 models.dev 提供 */
    maxTokens?: number
    /** 支持图片输入时为 true；纯文本模型省略此字段（不缓存 false，控制体积） */
    image?: boolean
}

/** 磁盘缓存：{ provider-id: { model-id: 缓存条目 } }，provider 只作外层键，消除逐条重复 */
export type Catalog = Record<string, Record<string, CacheRecord>>

/** 内存索引条目：缓存条目（CacheRecord）补上分组键下的 model id，供 lookup/fix 按 provider+id 消费 */
export interface IndexEntry {
    id: string
    efforts: string[]
    contextWindow?: number
    maxTokens?: number
    image?: boolean
}

/** 按 provider 分组的内存索引，供 lookup 复用 */
export interface ProviderGroup {
    ids: string[]
    entries: IndexEntry[]
}

/** 目录及其预构建的 provider 分组索引 */
export interface IndexedCatalog {
    catalog: Catalog
    groups: Map<string, ProviderGroup>
}

/** 判断是否为可写回的容量值：正整数且非哨兵（harness schema 要求 step(1).min(1)；0 与 99999999 均视为无数据） */
export function isCapacity(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value !== CAPACITY_UNLIMITED
}

// ---------- 历史版本（v3）：版本快照体系内 v3 快照的冻结形态（引入 excludes 前的配置），定义不随代码演进 ----------

/** 历史版本(v3)：按字段分别控制的规则开关（与当前 FieldRules 同形，独立声明以冻结形态） */
export interface V3FieldRules {
    reasoning: boolean
    context: boolean
    image: boolean
}

/** 历史版本(v3)：兼容性规则（与当前 CompatRules 同形，独立声明以冻结形态） */
export interface V3CompatRules {
    /** 是否接管路由的 developer 角色兼容字段 */
    disableDeveloper: boolean
}

/** 历史版本(v3)：version-3 快照的完整形态 */
export interface V3PluginConfigSnapshot {
    configVersion: number
    allowUpdate: V3FieldRules
    autoFill: V3FieldRules
    compat: V3CompatRules
}

// ---------- 历史版本（v4）冻结形态：引入 efforts 之前的快照（三组布尔 + compat + excludes）；与当前 FieldRules / CompatRules 同形，独立声明以冻结形态，不引用当前版本的可演进定义。 ----------

/** 历史版本(v4)：字段规则（与当前 FieldRules 同形，独立声明以冻结形态） */
export interface V4FieldRules {
    reasoning: boolean
    context: boolean
    image: boolean
}

/** 历史版本(v4)：兼容性规则（与当前 CompatRules 同形，独立声明以冻结形态） */
export interface V4CompatRules {
    disableDeveloper: boolean
}

/** 历史版本(v4)：配置快照 */
export interface V4PluginConfigSnapshot {
    configVersion: number
    allowUpdate: V4FieldRules
    autoFill: V4FieldRules
    compat: V4CompatRules
    excludes: string[]
}

// ---------- 历史版本（v5）冻结形态：引入 defaultHigh 之前的快照（三组布尔 + compat + excludes + efforts + userExperience{rememberEfforts}），定义不随代码演进 ----------

/** 历史版本(v5)：字段规则（与当前 FieldRules 同形，独立声明以冻结形态） */
export interface V5FieldRules {
    reasoning: boolean
    context: boolean
    image: boolean
}

/** 历史版本(v5)：兼容性规则（与当前 CompatRules 同形，独立声明以冻结形态） */
export interface V5CompatRules {
    disableDeveloper: boolean
}

/** 历史版本(v5)：用户体验规则（冻结形态：不含 v6 起的 defaultHigh） */
export interface V5UserExperienceRules {
    rememberEfforts: boolean
}

/** 历史版本(v5)配置快照（efforts 是宽松记忆字段，v5 已存在故在此冻结） */
export interface V5PluginConfigSnapshot {
    configVersion: number
    allowUpdate: V5FieldRules
    autoFill: V5FieldRules
    compat: V5CompatRules
    excludes: string[]
    efforts: EffortMemory
    userExperience: V5UserExperienceRules
}

// ---------- 历史版本（v6）冻结形态：引入 forgetRemoved 之前的快照（三组布尔 + compat + excludes + efforts + userExperience{rememberEfforts, defaultHigh}），定义不随代码演进 ----------

/** 历史版本(v6)：字段规则（与当前 FieldRules 同形，独立声明以冻结形态） */
export interface V6FieldRules {
    reasoning: boolean
    context: boolean
    image: boolean
}

/** 历史版本(v6)：兼容性规则（与当前 CompatRules 同形，独立声明以冻结形态） */
export interface V6CompatRules {
    disableDeveloper: boolean
}

/** 历史版本(v6)：用户体验规则（冻结形态：含 rememberEfforts 与 defaultHigh，不含 v7 起的 forgetRemoved） */
export interface V6UserExperienceRules {
    rememberEfforts: boolean
    defaultHigh: boolean
}

/** 历史版本(v6)配置快照 */
export interface V6PluginConfigSnapshot {
    configVersion: number
    allowUpdate: V6FieldRules
    autoFill: V6FieldRules
    compat: V6CompatRules
    excludes: string[]
    efforts: EffortMemory
    userExperience: V6UserExperienceRules
}

// ---------- 历史版本（v7）冻结形态：引入 subagent 之前的快照（三组布尔 + compat + excludes + efforts + userExperience{rememberEfforts, defaultHigh, forgetRemoved}），定义不随代码演进 ----------

/** 历史版本(v7)：字段规则（与当前 FieldRules 同形，独立声明以冻结形态） */
export interface V7FieldRules {
    reasoning: boolean
    context: boolean
    image: boolean
}

/** 历史版本(v7)：兼容性规则（与当前 CompatRules 同形，独立声明以冻结形态） */
export interface V7CompatRules {
    disableDeveloper: boolean
}

/** 历史版本(v7)：用户体验规则（与当前 UserExperienceRules 同形，独立声明以冻结形态） */
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
