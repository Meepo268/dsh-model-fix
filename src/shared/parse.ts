/**
 * 跨半共享的当前版本（v8）配置解析、默认值与存储快照物化（零 Node 依赖、零 schemastery、零非基线 `@deepseek-ai/*`）。
 *
 * 浏览器半 `decodeSection` 与 Node 半 `resolveConfig`/`migrateConfig` 共用此处的解析函数（单一来源）；
 * `toStored` 为反方向的物化（配置 -> 规范存储快照），Node 半迁移落盘与浏览器半卡片「保存」共用。
 * 语义由 `test/config.test.ts`、`test/client-model.test.ts` 与 `test/migrate.test.ts` 共同守护。
 *
 * 解析约定：
 * - 整项缺失 → 落该项默认；存在但非对象、或字段存在但非布尔 → 返回 undefined（整段快照非法）
 * - `excludes` 缺失落空数组、非数组或元素非字符串判非法；`efforts` 宽松解析（结构不符回落 {}，不判非法）
 * - 产物只含 6 个已知键（剥离 configVersion 等运行时不消费的键）；缺省容器均为新对象/新数组，不与 `DEFAULT_CONFIG` 共享引用
 */

import { CONFIG_VERSION, VERSION_PREFIX } from '@/shared/constants'
import type { CompatRules, EffortMemory, FieldRules, PluginConfig, PluginConfigSnapshot, UserExperienceRules } from '@/shared/types'
import { isPlainObject } from '@/shared/types'

/** 默认配置：全新用户的配置基线（存储形态经 `toStored` 物化，取值改动须同步 `upgrade.ts` 的台阶默认值） */
export const DEFAULT_CONFIG: PluginConfig = {
    allowUpdate: { reasoning: false, context: false, image: false },
    autoFill: { reasoning: true, context: true, image: true },
    compat: { disableDeveloper: true, disableStore: true },
    excludes: [],
    efforts: {},
    userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true },
}

/** compat 组逐字段的省略默认值 */
const COMPAT_DEFAULTS: CompatRules = { disableDeveloper: true, disableStore: true }

/** userExperience 组逐字段的省略默认值 */
const USER_EXPERIENCE_DEFAULTS: UserExperienceRules = { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true }

/** 模型参数行对应的字段键（自动填充 / 允许更新两组的行，渲染顺序与总控共用） */
export const FIELD_KEYS = ['reasoning', 'context', 'image'] as const

/** 兼容性规则键（compat 组的行）；新增 compat 键在此追加，见 docs/versioning.md */
export const COMPAT_KEYS = ['disableDeveloper', 'disableStore'] as const

/** 用户体验组的行键；新增行键在此追加，见 docs/versioning.md */
export const USER_EXPERIENCE_KEYS = ['rememberEfforts', 'defaultHigh', 'forgetRemoved', 'followParent', 'selfTune', 'hideOfficial'] as const

/** 解析版本快照键 version-N；非法返回 undefined。严格匹配规范键（重建键名需与实际键一致，禁宽泛归一） */
export function parseVersion(key: string): number | undefined {
    const match = /^version-(0|[1-9]\d*)$/.exec(key)
    return match ? Number(match[1]) : undefined
}

/** 由版本号拼出 `version-N` 快照键 */
export function versionKey(version: number): string {
    return `${VERSION_PREFIX}${version}`
}

/**
 * 解析一组字段规则（对象写法的单列）：整体缺失落该项默认；
 * 存在但非对象、或字段存在但非布尔 => 返回 undefined 表示整段快照非法（镜像 schema 抛错语义）。
 */
function parseRules(value: unknown, dflt: boolean): FieldRules | undefined {
    if (value === undefined) return { reasoning: dflt, context: dflt, image: dflt }
    if (!isPlainObject(value)) return
    const rules = {} as FieldRules
    for (const key of FIELD_KEYS) {
        const field = value[key]
        if (field === undefined) {
            rules[key] = dflt
            continue
        }
        if (typeof field !== 'boolean') return
        rules[key] = field
    }
    return rules
}

/** 解析 compat 组：整体缺失落默认；非对象、或字段存在但非布尔 => undefined（整段快照非法） */
function parseCompat(value: unknown): CompatRules | undefined {
    if (value === undefined) return { ...COMPAT_DEFAULTS }
    if (!isPlainObject(value)) return
    const rules = {} as CompatRules
    for (const key of COMPAT_KEYS) {
        const field = value[key]
        if (field === undefined) {
            rules[key] = COMPAT_DEFAULTS[key]
            continue
        }
        if (typeof field !== 'boolean') return
        rules[key] = field
    }
    return rules
}

/** 解析 excludes 组：整项缺失落空数组；非数组或元素非字符串 => undefined（整段快照非法） */
function parseExcludes(value: unknown): string[] | undefined {
    if (value === undefined) return []
    if (!Array.isArray(value)) return
    const ids: string[] = []
    for (const item of value) {
        if (typeof item !== 'string') return
        ids.push(item)
    }
    return ids
}

/** 每模型推理级别记忆的宽松解析（结构不符回落 {}）：记忆坏值不判整段快照非法，避免连累配置自愈重写丢配置 */
export function parseEfforts(value: unknown): EffortMemory {
    if (!isPlainObject(value)) return {}
    const result: EffortMemory = {}
    for (const [provider, models] of Object.entries(value)) {
        if (!isPlainObject(models)) continue
        const entry: Record<string, string> = {}
        for (const [model, level] of Object.entries(models)) {
            if (typeof level === 'string') entry[model] = level
        }
        if (Object.keys(entry).length > 0) result[provider] = entry
    }
    return result
}

/** 解析 userExperience 组：整体缺失落默认；非对象、或字段存在但非布尔 => undefined（整段快照非法） */
function parseUserExperience(value: unknown): UserExperienceRules | undefined {
    if (value === undefined) return { ...USER_EXPERIENCE_DEFAULTS }
    if (!isPlainObject(value)) return
    const rules = {} as UserExperienceRules
    for (const key of USER_EXPERIENCE_KEYS) {
        const field = value[key]
        if (field === undefined) {
            rules[key] = USER_EXPERIENCE_DEFAULTS[key]
            continue
        }
        if (typeof field !== 'boolean') return
        rules[key] = field
    }
    return rules
}

/**
 * 解析单个快照值并物化默认；剥离 configVersion 等运行时不消费的键，非法返回 undefined。
 * 浏览器半 `decodeSection` 与 Node 半 `resolveConfig`/`migrateConfig` 共用此函数（单一来源）。
 */
export function parseSnapshot(value: unknown): PluginConfig | undefined {
    if (!isPlainObject(value)) return
    const allowUpdate = parseRules(value.allowUpdate, false)
    if (!allowUpdate) return
    const autoFill = parseRules(value.autoFill, true)
    if (!autoFill) return
    const compat = parseCompat(value.compat)
    if (!compat) return
    const excludes = parseExcludes(value.excludes)
    if (!excludes) return
    const userExperience = parseUserExperience(value.userExperience)
    if (!userExperience) return
    const efforts = parseEfforts(value.efforts)
    return { allowUpdate, autoFill, compat, excludes, efforts, userExperience }
}

/**
 * 运行时配置 -> 规范 v8 存储快照（configVersion + 四组 + excludes + efforts + userExperience 全显式）。
 * Node 半 migrate（自愈重写/高版本降级落盘）与浏览器半卡片「保存」共用（单一来源）。
 * 各组浅拷贝、excludes 复制、`efforts` 引用传递（调用方以写入当刻的实时记忆覆盖传入）；产物仅供立即序列化写入。
 */
export function toStored(config: PluginConfig): PluginConfigSnapshot {
    return {
        configVersion: CONFIG_VERSION,
        allowUpdate: { ...config.allowUpdate },
        autoFill: { ...config.autoFill },
        compat: { ...config.compat },
        excludes: [...config.excludes],
        efforts: config.efforts,
        userExperience: { ...config.userExperience },
    }
}
