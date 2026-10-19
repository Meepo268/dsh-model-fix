/**
 * 当前版本（v8）配置形态的完整定义与解析/物化（跨半共享、零 Node 依赖）：
 * 版本常量、键前缀、最低支持版本、旧快照上限、各组键名清单、默认值、解析函数、存储物化函数的单一入口，
 * 浏览器半 `decodeSection` 与 Node 半 `resolveConfig`/`migrateConfig`/`upgradeConfig` 共用。
 *
 * 解析约定：整项缺失落默认；非对象、字段非布尔判非法（返回 undefined）；
 * excludes 缺失落空数组、非数组或元素非字符串判非法；efforts 宽松解析（结构不符回落 {}）；
 * 产物只含当前 schema 的已知键，缺省容器均为新对象/新数组。
 */

import type { BehaviorRules, CompatRules, EffortMemory, FieldRules, PluginConfig, PluginConfigSnapshot, UserExperienceRules } from '@/shared/types'
import { isPlainObject } from '@/shared/types'

/** 当前配置快照版本号（段内键 `version-N` 的 N）；只有不兼容才递增（见 docs/versioning.md） */
export const CONFIG_VERSION = 8

/** 低于此值的快照视为已失效（不读取、不选为迁移源、清理时 unset） */
export const MIN_SUPPORTED_VERSION = 7

/** 低于当前版本的旧快照保留上限（超出从最低起淘汰；当前与更高版本永不删） */
export const MAX_OLD_SNAPSHOTS = 1

/** 版本快照键前缀，段内键形如 version-N */
const VERSION_PREFIX = 'version-'

/** compat 组默认值（整组缺失或字段缺失落此） */
const COMPAT_DEFAULTS: CompatRules = { disableDeveloper: true, disableStore: true }

/** userExperience 组默认值（整组缺失或字段缺失落此） */
const USER_EXPERIENCE_DEFAULTS: UserExperienceRules = {
    rememberEfforts: true,
    defaultHigh: true,
    forgetRemoved: true,
    followParent: false,
    selfTune: false,
    hideOfficial: true,
    localizeEfforts: true,
    showOriginalEfforts: true,
}

/**
 * behavior 组默认值（整组缺失或字段缺失落此）：四项全开。
 * 全开是唯一与「装本插件但看不见任何 UI」相容的缺省；缺段的老快照落此即保持既有观感（见 docs/versioning.md）。
 */
const BEHAVIOR_DEFAULTS: BehaviorRules = {
    showInModels: true,
    showInBuiltinPlugins: true,
    showInComposer: true,
    showFollowStatus: true,
}

/** 默认配置：全新用户的配置基线（存储形态经 `toStored` 物化；取值改动须同步 src/upgrade.ts 的台阶字面量） */
export const DEFAULT_CONFIG: PluginConfig = {
    allowUpdate: { reasoning: false, context: false, image: false },
    autoFill: { reasoning: true, context: true, image: true },
    compat: { ...COMPAT_DEFAULTS },
    excludes: [],
    efforts: {},
    behavior: { ...BEHAVIOR_DEFAULTS },
    userExperience: { ...USER_EXPERIENCE_DEFAULTS },
}

/** 模型参数行对应的字段键（自动填充 / 允许更新两组的行，渲染顺序与总控共用） */
export const FIELD_KEYS = ['reasoning', 'context', 'image'] as const

/** 兼容性规则键（compat 组的行）；新增 compat 键在此追加 */
export const COMPAT_KEYS = ['disableDeveloper', 'disableStore'] as const

/** 用户体验组的行键；新增行键在此追加 */
export const USER_EXPERIENCE_KEYS = [
    'rememberEfforts',
    'defaultHigh',
    'forgetRemoved',
    'followParent',
    'selfTune',
    'hideOfficial',
    'localizeEfforts',
    'showOriginalEfforts',
] as const

/** UI 可见性组的行键；新增席位可见性开关在此追加 */
export const BEHAVIOR_KEYS = [
    'showInModels',
    'showInBuiltinPlugins',
    'showInComposer',
    'showFollowStatus',
] as const

/** 解析版本快照键 version-N；非法返回 undefined。严格匹配规范键（禁宽泛归一） */
export function parseVersion(key: string): number | undefined {
    const match = /^version-(0|[1-9]\d*)$/.exec(key)
    return match ? Number(match[1]) : undefined
}

/** 由版本号拼出 `version-N` 快照键 */
export function versionKey(version: number): string {
    return `${VERSION_PREFIX}${version}`
}

/** 解析一组字段规则：整体缺失落默认；非对象、字段非布尔 => undefined */
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

/** 解析 compat 组：整体缺失落默认；非对象、字段非布尔 => undefined */
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

/** 解析 excludes 组：整项缺失落空数组；非数组或元素非字符串 => undefined */
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

/** 解析 behavior 组：整体缺失落默认；非对象、字段非布尔 => undefined */
function parseBehavior(value: unknown): BehaviorRules | undefined {
    if (value === undefined) return { ...BEHAVIOR_DEFAULTS }
    if (!isPlainObject(value)) return
    const rules = {} as BehaviorRules
    for (const key of BEHAVIOR_KEYS) {
        const field = value[key]
        if (field === undefined) {
            rules[key] = BEHAVIOR_DEFAULTS[key]
            continue
        }
        if (typeof field !== 'boolean') return
        rules[key] = field
    }
    return rules
}

/** 每模型推理级别记忆的宽松解析：结构不符回落 {}，坏值不判整段快照非法 */
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

/** 解析 userExperience 组：整体缺失落默认；非对象、字段非布尔 => undefined */
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

/** 解析单个快照值并物化默认；剥离 configVersion 等运行时不消费的键，非法返回 undefined */
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
    const behavior = parseBehavior(value.behavior)
    if (!behavior) return
    const userExperience = parseUserExperience(value.userExperience)
    if (!userExperience) return
    const efforts = parseEfforts(value.efforts)
    return { allowUpdate, autoFill, compat, excludes, efforts, behavior, userExperience }
}

/** 运行时配置 -> 规范 v8 存储快照。字段一律拷贝，防 DEFAULT_CONFIG 被就地改写 */
export function toStored(config: PluginConfig): PluginConfigSnapshot {
    return {
        configVersion: CONFIG_VERSION,
        allowUpdate: { ...config.allowUpdate },
        autoFill: { ...config.autoFill },
        compat: { ...config.compat },
        excludes: [...config.excludes],
        efforts: { ...config.efforts },
        behavior: { ...config.behavior },
        userExperience: { ...config.userExperience },
    }
}
