import z from '@deepseek-ai/schemastery'
import { MIN_SUPPORTED_VERSION } from '@/constants'
import { parseEfforts } from '@/shared/parse'
import type { PluginConfigSnapshot } from '@/shared/types'
import type { V3CompatRules, V3FieldRules, V3PluginConfigSnapshot, V4CompatRules, V4FieldRules, V4PluginConfigSnapshot, V5CompatRules, V5FieldRules, V5PluginConfigSnapshot, V5UserExperienceRules, V6CompatRules, V6FieldRules, V6PluginConfigSnapshot, V6UserExperienceRules, V7CompatRules, V7FieldRules, V7PluginConfigSnapshot, V7UserExperienceRules } from '@/types'
import { isPlainObject } from '@/shared/types'

/**
 * 版本升级链：把任意历史版本快照逐级接力到当前版本。生产路径只走 `upgradeConfig`；
 * `upgradeTo5`/`upgradeTo6` 另为单测直接引用，其余台阶为模块内私有接力。
 *
 * 本文件是**冻结形态的堆栈**，与当前版本的配置定义刻意不共享任何可演进来源：
 * 各级的 schema、默认常量、台阶默认值一律就地写字面量，也不引用 `CONFIG_VERSION`（产物版本号写死）——
 * 否则今天调整一个默认值，明天就会连带改写历史台阶的语义，破坏高版本快照的无损回退。
 * 配套的冻结类型 `V3`–`V7` 在 `src/types.ts`，增删台阶时两边同步（约定见 docs/versioning.md）。
 *
 * 当前版本的规范化、旧快照清理与自愈不在这里，见 `src/migrate.ts`。
 */

// ---------- 历史版本（v3）迁移源代码：版本快照体系内 v3 快照的冻结形态（见 types.ts 历史版本(v3) 段说明），不引用当前版本的可演进定义。 ----------

/** 历史版本(v3)：字段规则 schema（与当前 FieldRules 同形，独立声明以冻结形态），dflt 为省略字段的默认值 */
const v3FieldRules = (dflt: boolean): z<V3FieldRules> => z.object({
    reasoning: z.boolean().default(dflt),
    context: z.boolean().default(dflt),
    image: z.boolean().default(dflt),
})

/** 历史版本(v3)：兼容性规则 schema（与当前 CompatRules 同形，独立声明以冻结形态） */
const v3CompatRules: z<V3CompatRules> = z.object({
    disableDeveloper: z.boolean().default(true),
})

/** 历史版本(v3)：默认配置——解析失败兜底与 schema 整项缺省的唯一来源 */
const V3_BASE: Omit<V3PluginConfigSnapshot, 'configVersion'> = {
    allowUpdate: { reasoning: false, context: false, image: false },
    autoFill: { reasoning: true, context: true, image: true },
    compat: { disableDeveloper: true },
}

/** 历史版本(v3)：配置 schema（仅对象写法，configVersion 等多余键被 schema 忽略；默认取 V3_BASE 的展开副本） */
const V3ConfigSchema: z<Omit<V3PluginConfigSnapshot, 'configVersion'>> = z.object({
    allowUpdate: v3FieldRules(false).default({ ...V3_BASE.allowUpdate }),
    autoFill: v3FieldRules(true).default({ ...V3_BASE.autoFill }),
    compat: v3CompatRules.default({ ...V3_BASE.compat }),
})

// ---------- 升级链（upgradeToN 的产物即 vN 快照；调用它即「升到 N」，更低版本由它在内部逐级回推） ----------

/**
 * 排除列表的台阶默认值：升级到 v4 时落空列表。
 * 写字面量而不引用 `src/shared/parse.ts` 的 `DEFAULT_CONFIG.excludes`——后者随当前版本演进，台阶产物形态必须恒定。
 */
const V4_EXCLUDES_DEFAULT: readonly string[] = []

/** 升到 v4（最低一级）：输入按 v3 冻结 schema 解析（非法整体回退 v3 默认），新增 excludes 数组并落默认 */
function upgradeTo4(config: unknown, fromVersion: number): V4PluginConfigSnapshot {
    // 全链唯一的最低版本守卫：本函数是最低一级，其输入版本下限恰为 MIN_SUPPORTED_VERSION，
    // 调用方已按该下限筛过迁移源，此处为误用兜底。
    if (fromVersion < MIN_SUPPORTED_VERSION) {
        throw new Error(`无法从 v${fromVersion} 升级：低于最低支持版本 v${MIN_SUPPORTED_VERSION}`)
    }
    let parsed: Omit<V3PluginConfigSnapshot, 'configVersion'>
    try {
        parsed = V3ConfigSchema((isPlainObject(config) ? config : {}) as unknown as Omit<V3PluginConfigSnapshot, 'configVersion'>)
    } catch {
        // 防御性加固：展开拷贝各嵌套组，产物不与模块级常量共享嵌套引用（常态下由下一级 schema 逐字段投影保证）
        parsed = {
            allowUpdate: { ...V3_BASE.allowUpdate },
            autoFill: { ...V3_BASE.autoFill },
            compat: { ...V3_BASE.compat },
        }
    }
    // 产物版本固定为 4（本函数形态恒定），更高版本由后续台阶接力，故不引用 CONFIG_VERSION
    return {
        configVersion: 4,
        allowUpdate: parsed.allowUpdate,
        autoFill: parsed.autoFill,
        // v4 的 compat 形态与 v3 完全一致（同键同默认），直接沿用台阶解析结果
        compat: { ...parsed.compat },
        excludes: [...V4_EXCLUDES_DEFAULT],
    }
}

// ---------- 历史版本（v4）迁移源代码：v4 快照的冻结形态（见 types.ts 历史版本(v4) 段说明），不引用当前版本的可演进定义。 ----------

/** 历史版本(v4)：字段规则 schema（与当前 FieldRules 同形，独立声明以冻结形态），dflt 为省略字段的默认值 */
const v4FieldRules = (dflt: boolean): z<V4FieldRules> => z.object({
    reasoning: z.boolean().default(dflt),
    context: z.boolean().default(dflt),
    image: z.boolean().default(dflt),
})

/** 历史版本(v4)：兼容性规则 schema（与当前 CompatRules 同形，独立声明以冻结形态） */
const v4CompatRules: z<V4CompatRules> = z.object({
    disableDeveloper: z.boolean().default(true),
})

/** 历史版本(v4)：默认配置——解析失败兜底与 schema 整项缺省的唯一来源 */
const V4_BASE: Omit<V4PluginConfigSnapshot, 'configVersion'> = {
    allowUpdate: { reasoning: false, context: false, image: false },
    autoFill: { reasoning: true, context: true, image: true },
    compat: { disableDeveloper: true },
    excludes: [],
}

/** 历史版本(v4)：配置 schema（仅对象写法，configVersion 等多余键被 schema 忽略；默认取 V4_BASE 的展开副本） */
const V4ConfigSchema: z<Omit<V4PluginConfigSnapshot, 'configVersion'>> = z.object({
    allowUpdate: v4FieldRules(false).default({ ...V4_BASE.allowUpdate }),
    autoFill: v4FieldRules(true).default({ ...V4_BASE.autoFill }),
    compat: v4CompatRules.default({ ...V4_BASE.compat }),
    excludes: z.array(z.string()).default([...V4_BASE.excludes]),
})

/**
 * 每模型推理级别记忆与用户体验规则的台阶默认值：v4 无这两个键，升级到 v5 时落默认。
 * 写字面量而不引用 `src/shared/parse.ts` 的 `DEFAULT_CONFIG`——后者随当前版本演进，台阶产物形态必须恒定。
 * userExperience 用冻结的 V5UserExperienceRules（只含 rememberEfforts，无 v6 的 defaultHigh）。
 */
const V5_EFFORTS_DEFAULT: Record<string, Record<string, string>> = {}
const V5_USER_EXPERIENCE_DEFAULT: V5UserExperienceRules = { rememberEfforts: true }

/** 升到 v5：低于 v5 的输入先由 upgradeTo4 逐级接力到 v4，再按 v4 冻结 schema 解析（非法整体回退 v4 默认），新增 efforts 对象与 userExperience 并落默认 */
export function upgradeTo5(config: unknown, fromVersion: number): V5PluginConfigSnapshot {
    const v4 = fromVersion < 4 ? upgradeTo4(config, fromVersion) : config
    let parsed: Omit<V4PluginConfigSnapshot, 'configVersion'>
    try {
        parsed = V4ConfigSchema((isPlainObject(v4) ? v4 : {}) as unknown as Omit<V4PluginConfigSnapshot, 'configVersion'>)
    } catch {
        // 同 upgradeTo4：展开拷贝防共享嵌套引用
        parsed = {
            allowUpdate: { ...V4_BASE.allowUpdate },
            autoFill: { ...V4_BASE.autoFill },
            compat: { ...V4_BASE.compat },
            excludes: [...V4_BASE.excludes],
        }
    }
    return {
        configVersion: 5,
        allowUpdate: parsed.allowUpdate,
        autoFill: parsed.autoFill,
        compat: { ...parsed.compat },
        excludes: [...parsed.excludes],
        efforts: { ...V5_EFFORTS_DEFAULT },
        userExperience: { ...V5_USER_EXPERIENCE_DEFAULT },
    }
}

// ---------- 历史版本（v5）迁移源代码：v5 快照的冻结形态（见 types.ts 历史版本(v5) 段说明），不引用当前版本的可演进定义。 ----------

/** 历史版本(v5)：字段规则 schema（与 v4 同形，独立声明以冻结形态），dflt 为省略字段的默认值 */
const v5FieldRules = (dflt: boolean): z<V5FieldRules> => z.object({
    reasoning: z.boolean().default(dflt),
    context: z.boolean().default(dflt),
    image: z.boolean().default(dflt),
})

/** 历史版本(v5)：兼容性规则 schema（与 v4 同形，独立声明以冻结形态） */
const v5CompatRules: z<V5CompatRules> = z.object({
    disableDeveloper: z.boolean().default(true),
})

/** 历史版本(v5)：用户体验规则 schema（冻结形态：只含 rememberEfforts，无 v6 的 defaultHigh） */
const v5UserExperienceRules: z<V5UserExperienceRules> = z.object({
    rememberEfforts: z.boolean().default(true),
})

/** 历史版本(v5)：默认配置——解析失败兜底与 schema 整项缺省的唯一来源 */
const V5_BASE: Omit<V5PluginConfigSnapshot, 'configVersion'> = {
    allowUpdate: { reasoning: false, context: false, image: false },
    autoFill: { reasoning: true, context: true, image: true },
    compat: { disableDeveloper: true },
    excludes: [],
    efforts: {},
    userExperience: { rememberEfforts: true },
}

/**
 * 历史版本(v5)：配置 schema（仅对象写法，configVersion 等多余键被 schema 忽略；默认取 V5_BASE 的展开副本）。
 * efforts 是宽松记忆字段，不进 schema（坏结构只该回落 {} 而非拖垮整段），由 upgradeTo6 经 parseEfforts 单独保留。
 */
const V5ConfigSchema: z<Omit<V5PluginConfigSnapshot, 'configVersion' | 'efforts'>> = z.object({
    allowUpdate: v5FieldRules(false).default({ ...V5_BASE.allowUpdate }),
    autoFill: v5FieldRules(true).default({ ...V5_BASE.autoFill }),
    compat: v5CompatRules.default({ ...V5_BASE.compat }),
    excludes: z.array(z.string()).default([...V5_BASE.excludes]),
    userExperience: v5UserExperienceRules.default({ ...V5_BASE.userExperience }),
})

/**
 * defaultHigh 的台阶默认值：v5 无该字段，升级到 v6 时落默认（true，即默认使用 high）。
 * 写字面量而不引用 `src/shared/parse.ts` 的 `DEFAULT_CONFIG.userExperience.defaultHigh`——后者随当前版本演进，台阶产物形态必须恒定；
 * 两者当前取值一致，`DEFAULT_STORED 与升级链空输入一致` 的不变量才成立（调整默认值时须同步本字面量）。
 */
const V6_DEFAULT_HIGH_DEFAULT = true

/** 升到 v6：低于 v6 的输入先由 upgradeTo5 逐级接力到 v5，再按 v5 冻结 schema 解析（非法整体回退 v5 默认），新增 userExperience.defaultHigh 并落默认；efforts 经 parseEfforts 宽松保留 */
export function upgradeTo6(config: unknown, fromVersion: number): V6PluginConfigSnapshot {
    const v5 = fromVersion < 5 ? upgradeTo5(config, fromVersion) : config
    let parsed: Omit<V5PluginConfigSnapshot, 'configVersion' | 'efforts'>
    try {
        parsed = V5ConfigSchema((isPlainObject(v5) ? v5 : {}) as unknown as Omit<V5PluginConfigSnapshot, 'configVersion' | 'efforts'>)
    } catch {
        // 同 upgradeTo4（efforts 不进 schema，不在 parsed 内）
        parsed = {
            allowUpdate: { ...V5_BASE.allowUpdate },
            autoFill: { ...V5_BASE.autoFill },
            compat: { ...V5_BASE.compat },
            excludes: [...V5_BASE.excludes],
            userExperience: { ...V5_BASE.userExperience },
        }
    }
    // efforts 宽松保留
    const efforts = parseEfforts(isPlainObject(v5) ? v5.efforts : undefined)
    return {
        configVersion: 6,
        allowUpdate: parsed.allowUpdate,
        autoFill: parsed.autoFill,
        compat: { ...parsed.compat },
        excludes: [...parsed.excludes],
        efforts,
        userExperience: { ...parsed.userExperience, defaultHigh: V6_DEFAULT_HIGH_DEFAULT },
    }
}

// ---------- 历史版本（v6）迁移源代码：v6 快照的冻结形态（见 types.ts 历史版本(v6) 段说明），不引用当前版本的可演进定义。 ----------

/** 历史版本(v6)：字段规则 schema（与 v5 同形，独立声明以冻结形态），dflt 为省略字段的默认值 */
const v6FieldRules = (dflt: boolean): z<V6FieldRules> => z.object({
    reasoning: z.boolean().default(dflt),
    context: z.boolean().default(dflt),
    image: z.boolean().default(dflt),
})

/** 历史版本(v6)：兼容性规则 schema（与 v5 同形，独立声明以冻结形态） */
const v6CompatRules: z<V6CompatRules> = z.object({
    disableDeveloper: z.boolean().default(true),
})

/** 历史版本(v6)：用户体验规则 schema（冻结形态：含 rememberEfforts 与 defaultHigh，无 v7 起的 forgetRemoved）；defaultHigh 省略时落 v6 默认值 true */
const v6UserExperienceRules: z<V6UserExperienceRules> = z.object({
    rememberEfforts: z.boolean().default(true),
    defaultHigh: z.boolean().default(true),
})

/** 历史版本(v6)：默认配置——解析失败兜底与 schema 整项缺省的唯一来源 */
const V6_BASE: Omit<V6PluginConfigSnapshot, 'configVersion'> = {
    allowUpdate: { reasoning: false, context: false, image: false },
    autoFill: { reasoning: true, context: true, image: true },
    compat: { disableDeveloper: true },
    excludes: [],
    efforts: {},
    userExperience: { rememberEfforts: true, defaultHigh: true },
}

/**
 * 历史版本(v6)：配置 schema（仅对象写法，configVersion 等多余键被 schema 忽略；默认取 V6_BASE 的展开副本）。
 * efforts 是宽松记忆字段，不进 schema（坏结构只该回落 {} 而非拖垮整段），由 upgradeTo7 经 parseEfforts 单独保留。
 */
const V6ConfigSchema: z<Omit<V6PluginConfigSnapshot, 'configVersion' | 'efforts'>> = z.object({
    allowUpdate: v6FieldRules(false).default({ ...V6_BASE.allowUpdate }),
    autoFill: v6FieldRules(true).default({ ...V6_BASE.autoFill }),
    compat: v6CompatRules.default({ ...V6_BASE.compat }),
    excludes: z.array(z.string()).default([...V6_BASE.excludes]),
    userExperience: v6UserExperienceRules.default({ ...V6_BASE.userExperience }),
})

/**
 * forgetRemoved 的台阶默认值：v6 无该字段，升级到 v7 时落默认（true，即维持「忘记已删除模型」的既有行为）。
 * 写字面量而不引用 `src/shared/parse.ts` 的 `DEFAULT_CONFIG.userExperience.forgetRemoved`——后者随当前版本演进，台阶产物形态必须恒定。
 */
const V7_FORGET_REMOVED_DEFAULT = true

/** 升到 v7：低于 v7 的输入先由 upgradeTo6 逐级接力到 v6，再按 v6 冻结 schema 解析（非法整体回退 v6 默认），新增 userExperience.forgetRemoved 并落默认；efforts 经 parseEfforts 宽松保留 */
function upgradeTo7(config: unknown, fromVersion: number): V7PluginConfigSnapshot {
    const v6 = fromVersion < 6 ? upgradeTo6(config, fromVersion) : config
    let parsed: Omit<V6PluginConfigSnapshot, 'configVersion' | 'efforts'>
    try {
        parsed = V6ConfigSchema((isPlainObject(v6) ? v6 : {}) as unknown as Omit<V6PluginConfigSnapshot, 'configVersion' | 'efforts'>)
    } catch {
        // 同 upgradeTo4（efforts 不进 schema，不在 parsed 内）
        parsed = {
            allowUpdate: { ...V6_BASE.allowUpdate },
            autoFill: { ...V6_BASE.autoFill },
            compat: { ...V6_BASE.compat },
            excludes: [...V6_BASE.excludes],
            userExperience: { ...V6_BASE.userExperience },
        }
    }
    // efforts 宽松保留
    const efforts = parseEfforts(isPlainObject(v6) ? v6.efforts : undefined)
    return {
        configVersion: 7,
        allowUpdate: parsed.allowUpdate,
        autoFill: parsed.autoFill,
        compat: { ...parsed.compat },
        excludes: [...parsed.excludes],
        efforts,
        userExperience: { ...parsed.userExperience, forgetRemoved: V7_FORGET_REMOVED_DEFAULT },
    }
}

// ---------- 历史版本（v7）迁移源代码：v7 快照的冻结形态（见 types.ts 历史版本(v7) 段说明），不引用当前版本的可演进定义。 ----------

/** 历史版本(v7)：字段规则 schema（与 v6 同形，独立声明以冻结形态），dflt 为省略字段的默认值 */
const v7FieldRules = (dflt: boolean): z<V7FieldRules> => z.object({
    reasoning: z.boolean().default(dflt),
    context: z.boolean().default(dflt),
    image: z.boolean().default(dflt),
})

/** 历史版本(v7)：兼容性规则 schema（与 v6 同形，独立声明以冻结形态） */
const v7CompatRules: z<V7CompatRules> = z.object({
    disableDeveloper: z.boolean().default(true),
})

/** 历史版本(v7)：用户体验规则 schema（与 v6 同形，独立声明以冻结形态）；三项均为省略时的默认值 */
const v7UserExperienceRules: z<V7UserExperienceRules> = z.object({
    rememberEfforts: z.boolean().default(true),
    defaultHigh: z.boolean().default(true),
    forgetRemoved: z.boolean().default(true),
})

/** 历史版本(v7)：默认配置——解析失败兜底与 schema 整项缺省的唯一来源 */
const V7_BASE: Omit<V7PluginConfigSnapshot, 'configVersion'> = {
    allowUpdate: { reasoning: false, context: false, image: false },
    autoFill: { reasoning: true, context: true, image: true },
    compat: { disableDeveloper: true },
    excludes: [],
    efforts: {},
    userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true },
}

/**
 * 历史版本(v7)：配置 schema（仅对象写法，configVersion 等多余键被 schema 忽略；默认取 V7_BASE 的展开副本）。
 * efforts 是宽松记忆字段，不进 schema（坏结构只该回落 {} 而非拖垮整段），由 upgradeTo8 经 parseEfforts 单独保留。
 */
const V7ConfigSchema: z<Omit<V7PluginConfigSnapshot, 'configVersion' | 'efforts'>> = z.object({
    allowUpdate: v7FieldRules(false).default({ ...V7_BASE.allowUpdate }),
    autoFill: v7FieldRules(true).default({ ...V7_BASE.autoFill }),
    compat: v7CompatRules.default({ ...V7_BASE.compat }),
    excludes: z.array(z.string()).default([...V7_BASE.excludes]),
    userExperience: v7UserExperienceRules.default({ ...V7_BASE.userExperience }),
})

/**
 * userExperience.followParent 的台阶默认值：v7 无该键，升级到 v8 时落默认（false，即不干预），
 * 与 v8 出厂默认一致。写字面量而不引用 `src/shared/parse.ts` 的 `DEFAULT_CONFIG.userExperience.followParent`
 * ——后者随当前版本演进，台阶产物形态必须恒定。
 */
const V8_FOLLOW_PARENT_DEFAULT = false

/**
 * userExperience.selfTune 的台阶默认值：与 followParent 同批在 v8 形态内落地（同组新增键不递增
 * CONFIG_VERSION，见 docs/versioning.md），升级到 v8 时一并落默认（false，即不注入），与出厂默认一致。
 * 同样写字面量而不引用 `DEFAULT_CONFIG`——台阶产物形态必须恒定。
 */
const V8_SELF_TUNE_DEFAULT = false

/**
 * compat.disableStore 的台阶默认值：v7 无该键，升级到 v8 时落默认（true，与 v8 出厂默认一致）。
 * 与 userExperience 两项同批在 v8 形态内落地（同组新增键不递增 CONFIG_VERSION，见 docs/versioning.md）；
 * 同样写字面量而不引用 `DEFAULT_CONFIG`——台阶产物形态必须恒定。
 */
const V8_DISABLE_STORE_DEFAULT = true

/** 升到 v8（当前版本）：低于 v8 的输入先由 upgradeTo7 逐级接力到 v7，再按 v7 冻结 schema 解析（非法整体回退 v7 默认），新增 userExperience.followParent / selfTune 与 compat.disableStore 并落默认；efforts 经 parseEfforts 宽松保留 */
function upgradeTo8(config: unknown, fromVersion: number): PluginConfigSnapshot {
    const v7 = fromVersion < 7 ? upgradeTo7(config, fromVersion) : config
    let parsed: Omit<V7PluginConfigSnapshot, 'configVersion' | 'efforts'>
    try {
        parsed = V7ConfigSchema((isPlainObject(v7) ? v7 : {}) as unknown as Omit<V7PluginConfigSnapshot, 'configVersion' | 'efforts'>)
    } catch {
        // 同 upgradeTo4（efforts 不进 schema，不在 parsed 内）
        parsed = {
            allowUpdate: { ...V7_BASE.allowUpdate },
            autoFill: { ...V7_BASE.autoFill },
            compat: { ...V7_BASE.compat },
            excludes: [...V7_BASE.excludes],
            userExperience: { ...V7_BASE.userExperience },
        }
    }
    // efforts 宽松保留
    const efforts = parseEfforts(isPlainObject(v7) ? v7.efforts : undefined)
    return {
        configVersion: 8,
        allowUpdate: parsed.allowUpdate,
        autoFill: parsed.autoFill,
        compat: { ...parsed.compat, disableStore: V8_DISABLE_STORE_DEFAULT },
        excludes: [...parsed.excludes],
        efforts,
        userExperience: {
            ...parsed.userExperience,
            followParent: V8_FOLLOW_PARENT_DEFAULT,
            selfTune: V8_SELF_TUNE_DEFAULT,
        },
    }
}

/**
 * 配置版本迁移入口：只调用最新一级台阶，产物即当前 CONFIG_VERSION 的快照形态。
 * 新版本发布时只追加 `upgradeToN` 并把本函数改指它，既有台阶的逻辑一律不改（约定见 docs/versioning.md）。
 */
export function upgradeConfig(config: unknown, fromVersion: number): PluginConfigSnapshot {
    return upgradeTo8(config, fromVersion)
}
