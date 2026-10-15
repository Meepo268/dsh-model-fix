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
 * - 升级链只有一级（upgradeTo8），它是最低一级、自持最低版本守卫。
 * - 冻结类型 V7* 配套在 src/types.ts；台阶与冻结类型同步演进。
 * - 未来形态不兼容时：追加新台阶 upgradeTo9、新冻结类型 V8*、提升 MIN_SUPPORTED_VERSION。
 *   届时 upgradeTo9 变为最低一级、自持守卫，upgradeTo8 去掉守卫改为中间接力台阶。
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
 * 取值与当前出厂默认一致。
 */
const V8_FOLLOW_PARENT_DEFAULT = false
const V8_SELF_TUNE_DEFAULT = false
const V8_HIDE_OFFICIAL_DEFAULT = true
const V8_LOCALIZE_EFFORTS_DEFAULT = true
const V8_SHOW_ORIGINAL_EFFORTS_DEFAULT = true
const V8_DISABLE_STORE_DEFAULT = true

// ---------- 最低一级台阶（持守卫） ----------

/**
 * 升到 v8（当前最低一级，自持最低版本守卫）。
 * 输入按 v7 冻结 schema 解析（非法整体回退 v7 默认）；efforts 经 parseEfforts 宽松保留；
 * 补 compat.disableStore 与 userExperience 的 followParent/selfTune/hideOfficial/localizeEfforts/showOriginalEfforts 默认值。
 *
 * 守卫：本函数是最低一级，其输入版本下限恰为 MIN_SUPPORTED_VERSION。
 * 调用方（migrateConfig 的候选过滤）已按该下限筛过迁移源，此处为误用兜底。
 */
function upgradeTo8(config: unknown, fromVersion: number): PluginConfigSnapshot {
    if (fromVersion < MIN_SUPPORTED_VERSION) {
        throw new Error(`无法从 v${fromVersion} 升级：低于最低支持版本 v${MIN_SUPPORTED_VERSION}`)
    }
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
