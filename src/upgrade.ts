import z from '@deepseek-ai/schemastery'
import { MIN_SUPPORTED_VERSION, parseEfforts } from '@/shared/config-schema'
import type { PluginConfigSnapshot } from '@/shared/types'
import type { V7CompatRules, V7FieldRules, V7PluginConfigSnapshot, V7UserExperienceRules } from '@/types'
import { isPlainObject } from '@/shared/types'

/**
 * 配置版本升级链：把 v7 快照升到当前 v8。
 *
 * 本文件是**冻结形态的堆栈**，与当前版本的配置定义刻意不共享任何可演进来源：
 * v7 schema、默认常量、台阶默认值一律就地写字面量，也不引用 CONFIG_VERSION——
 * 否则今天调整一个默认值，明天就会连带改写历史台阶的语义，破坏高版本快照的无损回退。
 *
 * 台阶写法约定（见 docs/versioning.md）：
 * - `upgradeToN` 只负责把低一级的配置升到 N：输入下限 N-1，低于即转交 upgradeToN-1。
 * - 当前链只有两级：upgradeTo8 → upgradeTo7（最低一级，校验 MIN_SUPPORTED_VERSION）。
 *
 * 当前版本的规范化、旧快照清理与自愈不在这里，见 src/migrate.ts。
 */

// ---------- 历史版本（v7）冻结形态 ----------

/** v7 字段规则 schema（与当前 FieldRules 同形，独立声明以冻结形态），dflt 为省略字段默认值 */
const v7FieldRules = (dflt: boolean): z<V7FieldRules> => z.object({
    reasoning: z.boolean().default(dflt),
    context: z.boolean().default(dflt),
    image: z.boolean().default(dflt),
})

/** v7 兼容性规则 schema：只含 disableDeveloper（v8 新增 disableStore） */
const v7CompatRules: z<V7CompatRules> = z.object({
    disableDeveloper: z.boolean().default(true),
})

/** v7 用户体验规则 schema：不含 v8 新增的五键 */
const v7UserExperienceRules: z<V7UserExperienceRules> = z.object({
    rememberEfforts: z.boolean().default(true),
    defaultHigh: z.boolean().default(true),
    forgetRemoved: z.boolean().default(true),
})

/** v7 默认配置：解析失败兜底与 schema 整项缺省的唯一来源 */
const V7_BASE: Omit<V7PluginConfigSnapshot, 'configVersion'> & { efforts: Record<string, Record<string, string>> } = {
    allowUpdate: { reasoning: false, context: false, image: false },
    autoFill: { reasoning: true, context: true, image: true },
    compat: { disableDeveloper: true },
    excludes: [],
    userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true },
    efforts: {},
}

/** v7 配置 schema（仅对象写法；efforts 由 parseEfforts 单独宽松保留，不进 schema） */
const V7ConfigSchema: z<Omit<V7PluginConfigSnapshot, 'configVersion' | 'efforts'>> = z.object({
    allowUpdate: v7FieldRules(false).default({ ...V7_BASE.allowUpdate }),
    autoFill: v7FieldRules(true).default({ ...V7_BASE.autoFill }),
    compat: v7CompatRules.default({ ...V7_BASE.compat }),
    excludes: z.array(z.string()).default([...V7_BASE.excludes]),
    userExperience: v7UserExperienceRules.default({ ...V7_BASE.userExperience }),
})

// ---------- v8 台阶默认值 ----------

/**
 * 同组新增键在 v8 形态内落地（未递增 CONFIG_VERSION），台阶侧补字面量默认值。
 * 写字面量而不引用当前版本的 DEFAULT_CONFIG——台阶产物形态必须恒定，否则默认演进会改写历史台阶语义。
 */
const V8_FOLLOW_PARENT_DEFAULT = false
const V8_SELF_TUNE_DEFAULT = false
const V8_HIDE_OFFICIAL_DEFAULT = true
const V8_LOCALIZE_EFFORTS_DEFAULT = true
const V8_SHOW_ORIGINAL_EFFORTS_DEFAULT = true
const V8_DISABLE_STORE_DEFAULT = true

/**
 * v8 形态内新增顶级组 `behavior` 的台阶默认值（四项全开）。
 *
 * 写入字面量而不引用当前版本的 BEHAVIOR_DEFAULTS，理由同上：台阶产物形态必须恒定。
 * 此前落盘的 v8 快照没有这一段，解析时同样落全开，两条路径口径一致。
 */
const V8_BEHAVIOR_DEFAULT = true

// ---------- 最低一级台阶（持守卫） ----------

/**
 * 升到 v7：最低一级。v7 已是本仓支持的最早形态、无更早台阶可转交，
 * 守卫确认输入不低于全局最低支持版本后原样返回——v7 即终态，无「升级动作」可言。
 */
function upgradeToMinVersion(config: unknown, fromVersion: number): V7PluginConfigSnapshot {
    if (fromVersion < MIN_SUPPORTED_VERSION) {
        throw new Error(`无法从 v${fromVersion} 升级：低于最低支持版本 v${MIN_SUPPORTED_VERSION}`)
    }
    return config as V7PluginConfigSnapshot
}

/** 升到 v7 的台阶名（与 upgradeToN 命名法对齐；本体即最低一级的校验） */
const upgradeTo7 = upgradeToMinVersion

/**
 * 升到 v8。输入按 v7 冻结 schema 解析（非法整体回退 v7 默认）；efforts 经 parseEfforts 宽松保留；
 * 补 compat.disableStore、userExperience 的五个新键默认值，以及 behavior 段（四项全开）。
 *
 * 输入下限是 7：低于 7 交给 upgradeTo7。
 */
function upgradeTo8(config: unknown, fromVersion: number): PluginConfigSnapshot {
    // 输入下限 7：低于即转交最低一级（只可能抛错——校验不过直接终止，返回值无产物意义）
    if (fromVersion < 7) upgradeTo7(config, fromVersion)
    let parsed: Omit<V7PluginConfigSnapshot, 'configVersion' | 'efforts'>
    try {
        parsed = V7ConfigSchema((isPlainObject(config) ? config : {}) as unknown as Omit<V7PluginConfigSnapshot, 'configVersion' | 'efforts'>)
    } catch {
        parsed = {
            allowUpdate: { ...V7_BASE.allowUpdate },
            autoFill: { ...V7_BASE.autoFill },
            compat: { ...V7_BASE.compat },
            excludes: [...V7_BASE.excludes],
            userExperience: { ...V7_BASE.userExperience },
        }
    }
    const efforts = parseEfforts(isPlainObject(config) ? config.efforts : undefined)
    return {
        configVersion: 8,
        allowUpdate: parsed.allowUpdate,
        autoFill: parsed.autoFill,
        compat: { ...parsed.compat, disableStore: V8_DISABLE_STORE_DEFAULT },
        excludes: [...parsed.excludes],
        efforts,
        behavior: {
            showInModels: V8_BEHAVIOR_DEFAULT,
            showInBuiltinPlugins: V8_BEHAVIOR_DEFAULT,
            showInComposer: V8_BEHAVIOR_DEFAULT,
            showFollowStatus: V8_BEHAVIOR_DEFAULT,
        },
        userExperience: {
            ...parsed.userExperience,
            followParent: V8_FOLLOW_PARENT_DEFAULT,
            selfTune: V8_SELF_TUNE_DEFAULT,
            hideOfficial: V8_HIDE_OFFICIAL_DEFAULT,
            localizeEfforts: V8_LOCALIZE_EFFORTS_DEFAULT,
            showOriginalEfforts: V8_SHOW_ORIGINAL_EFFORTS_DEFAULT,
        },
    }
}

/**
 * 配置版本迁移入口：只调最新一级台阶，产物即当前形态的快照。
 * 新版本发布时追加新台阶、把本函数改指它，既有台阶逻辑一律不改。
 */
export function upgradeConfig(config: unknown, fromVersion: number): PluginConfigSnapshot {
    return upgradeTo8(config, fromVersion)
}
