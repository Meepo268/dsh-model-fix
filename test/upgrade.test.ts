// upgrade.ts 纯函数测试：upgradeConfig v7→v8 语义 / 最低支持版本守卫 / DEFAULT_STORED 一致性
import { upgradeConfig } from '@/upgrade'
import { DEFAULT_STORED } from '@/migrate'
import { check, stable } from '@test/helper'

/** 执行本文件的全部用例 */
export function run(): void {
    // 当前版本默认值（台阶侧的逐级升级语义已退化为 v7→v8 一级）
    const COMPAT = { disableDeveloper: true, disableStore: true }
    const EXCLUDES: string[] = []
    const EFFORTS: Record<string, Record<string, string>> = {}
    const USER_EXPERIENCE = { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: true, showOriginalEfforts: true, looseMatch: false }
    const BEHAVIOR = { showInModels: true, showInBuiltinPlugins: true, showInComposer: true, showFollowStatus: true, backToChat: true }

    // ---------- v7 → v8：原样沿用各组字段，补 compat.disableStore 与 userExperience 的 followParent / selfTune / hideOfficial / localizeEfforts / showOriginalEfforts 默认，并补 v8 形态内新增的 behavior 段 ----------
    const v7Stored = {
        configVersion: 7,
        allowUpdate: { reasoning: true, context: false, image: false },
        autoFill: { reasoning: false, context: true, image: true },
        compat: { disableDeveloper: false },
        excludes: ['acme-gateway'],
        efforts: { 'z-ai': { 'glm-5.2': 'high' } },
        written: {},
        userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: false },
    }
    check('v7 快照升到 v8 保留全部现值与 efforts 记忆', stable(upgradeConfig(v7Stored, 7)) === stable({
        configVersion: 8,
        allowUpdate: v7Stored.allowUpdate,
        autoFill: v7Stored.autoFill,
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['acme-gateway'],
        efforts: { 'z-ai': { 'glm-5.2': 'high' } },
        written: {},
        behavior: BEHAVIOR,
        userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: false, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: true, showOriginalEfforts: true, looseMatch: false },
    }), upgradeConfig(v7Stored, 7))
    // v7 输入 compat 非布尔 → schema 整体回 V7_BASE（任意组非法都整段回退，避免带着坏值继续升级），efforts 仍宽松保留
    check('v7 输入 compat 非布尔整段回 v7 默认再补 disableStore', stable(upgradeConfig({ ...v7Stored, compat: 'x' }, 7)) === stable({
        configVersion: 8,
        allowUpdate: { reasoning: false, context: false, image: false },
        autoFill: { reasoning: true, context: true, image: true },
        compat: COMPAT,
        excludes: EXCLUDES,
        efforts: { 'z-ai': { 'glm-5.2': 'high' } },
        written: {},
        behavior: BEHAVIOR,
        userExperience: USER_EXPERIENCE,
    }), upgradeConfig({ ...v7Stored, compat: 'x' }, 7))
    // 垃圾输入：schema 整体回 V7_BASE → 产物形态恒定
    check('v7 垃圾输入回 v7 默认再补 v8 新键', stable(upgradeConfig('garbage', 7)) === stable({
        configVersion: 8,
        allowUpdate: { reasoning: false, context: false, image: false },
        autoFill: { reasoning: true, context: true, image: true },
        compat: COMPAT,
        excludes: EXCLUDES,
        efforts: EFFORTS,
        written: {},
        behavior: BEHAVIOR,
        userExperience: USER_EXPERIENCE,
    }), upgradeConfig('garbage', 7))
    // 升级产物只含当前 schema 的已知键（configVersion + 六组），剥离多余键（schema 未声明的键被忽略）
    check('升级产物剥离多余键', Object.keys(upgradeConfig({ ...v7Stored, extra: 'ignored' }, 7)).sort().join(',') === 'allowUpdate,autoFill,behavior,compat,configVersion,efforts,excludes,userExperience,written', upgradeConfig({ ...v7Stored, extra: 'ignored' }, 7))

    // efforts 宽松保留：坏结构回落 {}，不拖垮整段配置
    check('v7 efforts 坏结构回落空但保留其余字段', stable(upgradeConfig({ ...v7Stored, efforts: 'bad' }, 7)) === stable({
        configVersion: 8,
        allowUpdate: v7Stored.allowUpdate,
        autoFill: v7Stored.autoFill,
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['acme-gateway'],
        efforts: {},
        written: {},
        behavior: BEHAVIOR,
        userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: false, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: true, showOriginalEfforts: true, looseMatch: false },
    }), upgradeConfig({ ...v7Stored, efforts: 'bad' }, 7))

    // ---------- 守卫：低于最低支持版本（MIN_SUPPORTED_VERSION = 7）的输入由最低一级台阶拒绝 ----------
    let guarded = ''
    try {
        upgradeConfig({ autoFill: { reasoning: true } }, 6)
    } catch (error) {
        guarded = error instanceof Error ? error.message : String(error)
    }
    check('低于最低支持版本抛错', guarded.includes('低于最低支持版本'), guarded)

    // 默认快照与升级链的一致性（全新用户直写默认 vs 空配置走升级链，结果必须相同）
    check('DEFAULT_STORED 与升级链空输入一致', stable(DEFAULT_STORED) === stable(upgradeConfig({}, 7)), { DEFAULT_STORED, chain: upgradeConfig({}, 7) })
}
