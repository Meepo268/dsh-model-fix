// upgrade.ts 纯函数测试：upgradeConfig 升级链逐级语义 / 各台阶冻结形态 / 台阶接力对 efforts 的处理 / 最低支持版本守卫
import { upgradeConfig, upgradeTo5, upgradeTo6 } from '@/upgrade'
import { DEFAULT_STORED } from '@/migrate'
import { check, stable } from '@test/helper'

/** 执行本文件的全部用例 */
export function run(): void {
    // 台阶补的默认值（与当前版本默认同值：defaultHigh 与 forgetRemoved 的台阶默认值均为 true，故全新用户直写 DEFAULT_STORED 与走升级链结果一致）
    const COMPAT = { disableDeveloper: true, disableStore: true }
    const EXCLUDES: string[] = []
    const EFFORTS: Record<string, Record<string, string>> = {}
    const USER_EXPERIENCE = { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: false }

    // ---------- v3 → v8：三组布尔与 compat 原样沿用，补 excludes（v4 起）、efforts/userExperience（v5 起）、defaultHigh（v6 起）、forgetRemoved（v7 起）、followParent / selfTune / disableStore 默认（v8 起） ----------
    const v3Stored = {
        configVersion: 3,
        allowUpdate: { reasoning: true, context: false, image: false },
        autoFill: { reasoning: false, context: true, image: true },
        compat: { disableDeveloper: false },
    }
    check('v3 快照升到 v8 且保留 compat 现值', stable(upgradeConfig(v3Stored, 3)) === stable({
        configVersion: 8,
        allowUpdate: v3Stored.allowUpdate,
        autoFill: v3Stored.autoFill,
        compat: { disableDeveloper: false, disableStore: true },
        excludes: EXCLUDES,
        efforts: EFFORTS,
        userExperience: USER_EXPERIENCE,
    }), upgradeConfig(v3Stored, 3))
    // v3 的 compat 段按 v3 冻结 schema 解析：缺键落 v3 默认，非布尔整段回 v3 默认（不牵连其他组）
    check('v3 输入 compat 非布尔回 v3 默认', stable(upgradeConfig({ autoFill: { reasoning: true }, compat: 'x' }, 3)) === stable({
        configVersion: 8,
        allowUpdate: { reasoning: false, context: false, image: false },
        autoFill: { reasoning: true, context: true, image: true },
        compat: COMPAT,
        excludes: EXCLUDES,
        efforts: EFFORTS,
        userExperience: USER_EXPERIENCE,
    }), upgradeConfig({ autoFill: { reasoning: true }, compat: 'x' }, 3))
    check('v3 垃圾输入回 v3 默认再补 excludes / efforts / userExperience', stable(upgradeConfig('garbage', 3)) === stable({
        configVersion: 8,
        allowUpdate: { reasoning: false, context: false, image: false },
        autoFill: { reasoning: true, context: true, image: true },
        compat: COMPAT,
        excludes: EXCLUDES,
        efforts: EFFORTS,
        userExperience: USER_EXPERIENCE,
    }), upgradeConfig('garbage', 3))
    // 台阶产物形态恒定：即便未来默认演进，历史各台阶补的仍是空对象与默认开关
    check('升级产物不携带用户段之外的多余键', Object.keys(upgradeConfig(v3Stored, 3)).sort().join(',') === 'allowUpdate,autoFill,compat,configVersion,efforts,excludes,userExperience', upgradeConfig(v3Stored, 3))

    // ---------- v4 → v8：三组布尔 + compat + excludes 原样沿用，补 efforts / userExperience（v5 起）、defaultHigh（v6 起）、forgetRemoved（v7 起）、followParent / selfTune / disableStore 默认（v8 起） ----------
    const v4Stored = {
        configVersion: 4,
        allowUpdate: { reasoning: true, context: false, image: true },
        autoFill: { reasoning: false, context: true, image: false },
        compat: { disableDeveloper: false },
        excludes: ['acme-gateway'],
    }
    check('v4 快照升到 v8 且保留全部字段', stable(upgradeConfig(v4Stored, 4)) === stable({
        configVersion: 8,
        allowUpdate: v4Stored.allowUpdate,
        autoFill: v4Stored.autoFill,
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['acme-gateway'],
        efforts: EFFORTS,
        userExperience: USER_EXPERIENCE,
    }), upgradeConfig(v4Stored, 4))
    check('v4 垃圾输入回 v4 默认再补 efforts / userExperience / defaultHigh / forgetRemoved', stable(upgradeConfig('garbage', 4)) === stable({
        configVersion: 8,
        allowUpdate: { reasoning: false, context: false, image: false },
        autoFill: { reasoning: true, context: true, image: true },
        compat: COMPAT,
        excludes: EXCLUDES,
        efforts: EFFORTS,
        userExperience: USER_EXPERIENCE,
    }), upgradeConfig('garbage', 4))

    // ---------- v5 → v8：原样沿用三组布尔 + compat + excludes + efforts + userExperience{rememberEfforts}，补 defaultHigh 与 forgetRemoved 默认 true，再补 followParent 默认 ----------
    const v5Stored = {
        configVersion: 5,
        allowUpdate: { reasoning: true, context: false, image: true },
        autoFill: { reasoning: false, context: true, image: false },
        compat: { disableDeveloper: false },
        excludes: ['acme-gateway'],
        efforts: { 'z-ai': { 'glm-5.2': 'high' } },
        userExperience: { rememberEfforts: false },
    }
    check('v5 快照升到 v8 且保留 efforts 记忆与 userExperience 现值，补 defaultHigh / forgetRemoved 默认', stable(upgradeConfig(v5Stored, 5)) === stable({
        configVersion: 8,
        allowUpdate: v5Stored.allowUpdate,
        autoFill: v5Stored.autoFill,
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['acme-gateway'],
        efforts: { 'z-ai': { 'glm-5.2': 'high' } },
        userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: false },
    }), upgradeConfig(v5Stored, 5))
    // v5 输入的 userExperience 经 v5 冻结 schema 解析：缺 rememberEfforts 落 v5 默认 true，非布尔回 v5 默认（不牵连其他组）
    check('v5 输入 userExperience 缺字段落 v5 默认', stable((upgradeConfig({ ...v5Stored, userExperience: {} }, 5) as { userExperience: { rememberEfforts: boolean; defaultHigh: boolean; forgetRemoved: boolean; followParent: boolean } }).userExperience) === stable({ rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: false }), upgradeConfig({ ...v5Stored, userExperience: {} }, 5))
    check('v5 输入 userExperience 非布尔回 v5 默认再补 defaultHigh / forgetRemoved', stable((upgradeConfig({ ...v5Stored, userExperience: { rememberEfforts: 'yes' } }, 5) as { userExperience: { rememberEfforts: boolean; defaultHigh: boolean; forgetRemoved: boolean; followParent: boolean } }).userExperience) === stable({ rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: false }), upgradeConfig({ ...v5Stored, userExperience: { rememberEfforts: 'yes' } }, 5))
    // v5 输入的 efforts 宽松保留：坏结构只回落 {}，不拖垮整段配置
    check('v5 输入 efforts 坏结构回落空但保留其余字段', stable(upgradeConfig({ ...v5Stored, efforts: 'bad' }, 5)) === stable({
        configVersion: 8,
        allowUpdate: v5Stored.allowUpdate,
        autoFill: v5Stored.autoFill,
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['acme-gateway'],
        efforts: {},
        userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: false },
    }), upgradeConfig({ ...v5Stored, efforts: 'bad' }, 5))
    check('v5 垃圾输入回 v5 默认再补 defaultHigh / forgetRemoved', stable(upgradeConfig('garbage', 5)) === stable({
        configVersion: 8,
        allowUpdate: { reasoning: false, context: false, image: false },
        autoFill: { reasoning: true, context: true, image: true },
        compat: COMPAT,
        excludes: EXCLUDES,
        efforts: EFFORTS,
        userExperience: USER_EXPERIENCE,
    }), upgradeConfig('garbage', 5))
    // v5 台阶冻结形态：upgradeTo5 产物只含 rememberEfforts（无 defaultHigh），确认历史台阶不被当前演进污染
    check('v5 台阶产物 userExperience 不含 defaultHigh', stable(upgradeTo5('garbage', 5).userExperience) === stable({ rememberEfforts: true }), upgradeTo5('garbage', 5).userExperience)

    // ---------- v6 → v8：原样沿用全部 v6 字段与 efforts 记忆，userExperience 补 forgetRemoved 默认 true（维持「忘记已删除模型」的既有行为），再补 followParent 默认 ----------
    const v6Stored = {
        configVersion: 6,
        allowUpdate: { reasoning: true, context: false, image: true },
        autoFill: { reasoning: false, context: true, image: false },
        compat: { disableDeveloper: false },
        excludes: ['acme-gateway'],
        efforts: { 'z-ai': { 'glm-5.2': 'high' } },
        userExperience: { rememberEfforts: false, defaultHigh: true },
    }
    check('v6 快照升到 v8 且保留 efforts 记忆与 userExperience 现值，补 forgetRemoved 默认', stable(upgradeConfig(v6Stored, 6)) === stable({
        configVersion: 8,
        allowUpdate: v6Stored.allowUpdate,
        autoFill: v6Stored.autoFill,
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['acme-gateway'],
        efforts: { 'z-ai': { 'glm-5.2': 'high' } },
        userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: false },
    }), upgradeConfig(v6Stored, 6))
    // v6 输入的 userExperience 经 v6 冻结 schema 解析：缺字段落 v6 默认，非布尔回 v6 默认（不牵连其他组）
    check('v6 输入 userExperience 缺字段落 v6 默认', stable((upgradeConfig({ ...v6Stored, userExperience: {} }, 6) as { userExperience: { rememberEfforts: boolean; defaultHigh: boolean; forgetRemoved: boolean; followParent: boolean } }).userExperience) === stable({ rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: false }), upgradeConfig({ ...v6Stored, userExperience: {} }, 6))
    check('v6 输入 userExperience defaultHigh 非布尔回 v6 默认再补 forgetRemoved', stable((upgradeConfig({ ...v6Stored, userExperience: { rememberEfforts: true, defaultHigh: 'yes' } }, 6) as { userExperience: { rememberEfforts: boolean; defaultHigh: boolean; forgetRemoved: boolean; followParent: boolean } }).userExperience) === stable({ rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: false }), upgradeConfig({ ...v6Stored, userExperience: { rememberEfforts: true, defaultHigh: 'yes' } }, 6))
    // v6 输入的 efforts 宽松保留：坏结构只回落 {}，不拖垮整段配置
    check('v6 输入 efforts 坏结构回落空但保留其余字段', stable(upgradeConfig({ ...v6Stored, efforts: 'bad' }, 6)) === stable({
        configVersion: 8,
        allowUpdate: v6Stored.allowUpdate,
        autoFill: v6Stored.autoFill,
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['acme-gateway'],
        efforts: {},
        userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: false },
    }), upgradeConfig({ ...v6Stored, efforts: 'bad' }, 6))
    check('v6 垃圾输入回 v6 默认再补 forgetRemoved', stable(upgradeConfig('garbage', 6)) === stable({
        configVersion: 8,
        allowUpdate: { reasoning: false, context: false, image: false },
        autoFill: { reasoning: true, context: true, image: true },
        compat: COMPAT,
        excludes: EXCLUDES,
        efforts: EFFORTS,
        userExperience: USER_EXPERIENCE,
    }), upgradeConfig('garbage', 6))
    // v6 台阶冻结形态：upgradeTo6 产物只含 rememberEfforts 与 defaultHigh（无 forgetRemoved），确认历史台阶不被当前演进污染
    check('v6 台阶产物 userExperience 不含 forgetRemoved', stable(upgradeTo6('garbage', 6).userExperience) === stable({ rememberEfforts: true, defaultHigh: true }), upgradeTo6('garbage', 6).userExperience)

    // ---------- v7 → v8：原样沿用全部 v7 字段与 efforts 记忆，userExperience 新增 followParent 行并落台阶默认（不跟随） ----------
    const v7Stored = {
        configVersion: 7,
        allowUpdate: { reasoning: true, context: false, image: true },
        autoFill: { reasoning: false, context: true, image: false },
        compat: { disableDeveloper: false },
        excludes: ['acme-gateway'],
        efforts: { 'z-ai': { 'glm-5.2': 'high' } },
        userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: false },
    }
    check('v7 快照升到 v8 且保留 efforts 记忆与 userExperience 现值，followParent 落默认', stable(upgradeConfig(v7Stored, 7)) === stable({
        configVersion: 8,
        allowUpdate: v7Stored.allowUpdate,
        autoFill: v7Stored.autoFill,
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['acme-gateway'],
        efforts: { 'z-ai': { 'glm-5.2': 'high' } },
        userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: false, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: false },
    }), upgradeConfig(v7Stored, 7))
    check('v7 垃圾输入回 v7 默认再补 followParent 默认', stable(upgradeConfig('garbage', 7)) === stable({
        configVersion: 8,
        allowUpdate: { reasoning: false, context: false, image: false },
        autoFill: { reasoning: true, context: true, image: true },
        compat: COMPAT,
        excludes: EXCLUDES,
        efforts: EFFORTS,
        userExperience: USER_EXPERIENCE,
    }), upgradeConfig('garbage', 7))
    // v7 冻结 schema 不含 followParent 键：跨版本残留或手写的同名字段一律不认，落台阶默认
    check('v7 输入带 followParent 键也不认（按 v7 冻结 schema 忽略，落台阶默认）',
        (upgradeConfig({ ...v7Stored, userExperience: { ...v7Stored.userExperience, followParent: true } }, 7) as { userExperience: { followParent: boolean } }).userExperience.followParent === false,
        upgradeConfig({ ...v7Stored, userExperience: { ...v7Stored.userExperience, followParent: true } }, 7))
    check('v7 输入 efforts 坏结构回落空但保留其余字段与 followParent 默认', stable(upgradeConfig({ ...v7Stored, efforts: 'bad' }, 7)) === stable({
        configVersion: 8,
        allowUpdate: v7Stored.allowUpdate,
        autoFill: v7Stored.autoFill,
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['acme-gateway'],
        efforts: {},
        userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: false, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: false },
    }), upgradeConfig({ ...v7Stored, efforts: 'bad' }, 7))

    // ---------- 台阶接力的参数化守护：fromVersion 全档 × 合法/非法 efforts，守护台阶冻结形态与 efforts 宽松保留语义 ----------
    const V5_INPUT = {
        configVersion: 5,
        allowUpdate: { reasoning: false, context: false, image: false },
        autoFill: { reasoning: true, context: true, image: true },
        compat: { disableDeveloper: true },
        excludes: [] as string[],
        userExperience: { rememberEfforts: true },
    }
    const GOOD_EFFORTS = { 'z-ai': { 'glm-5.2': 'high' } }
    // upgradeTo5 产物形态恒定：efforts 恒落台阶默认 {}（v5 台阶语义即「新增 efforts 并落默认」，输入记忆不进台阶产物；
    // 真实链路中记忆保留由 upgradeTo6 的 parseEfforts 直接对输入做，不经过本台阶产物），与 fromVersion 和输入均无关
    for (const from of [3, 4, 5]) {
        for (const [label, efforts] of [['合法', GOOD_EFFORTS], ['非法', 'bad']] as const) {
            check(
                `upgradeTo5 台阶产物 efforts 恒落默认（from=${from}，${label} efforts 输入）`,
                stable(upgradeTo5({ ...V5_INPUT, efforts }, from).efforts) === stable({}),
            )
        }
    }
    // upgradeTo6：from ∈ {3,4} 经 upgradeTo5 接力，输入 efforts 不跨台阶（恒落 {}）；
    // from ∈ {5,6} 直接解析输入，parseEfforts 宽松保留（合法保留原值 / 非法回落空，不拖垮整段）
    for (const from of [3, 4, 5, 6]) {
        const relayed = from < 5
        for (const [label, efforts] of [['合法', GOOD_EFFORTS], ['非法', 'bad']] as const) {
            const expected = relayed ? {} : label === '合法' ? GOOD_EFFORTS : {}
            check(
                `upgradeTo6 的 efforts ${relayed ? '经接力不保留' : '宽松保留'}（from=${from}，${label} efforts 输入）`,
                stable(upgradeTo6({ ...V5_INPUT, efforts }, from).efforts) === stable(expected),
            )
        }
    }

    // ---------- 守卫：低于最低支持版本（MIN_SUPPORTED_VERSION = 3）的输入由链上台阶拒绝 ----------
    let guarded = ''
    try {
        upgradeConfig({ autoFill: { reasoning: true } }, 2)
    } catch (error) {
        guarded = error instanceof Error ? error.message : String(error)
    }
    check('低于最低支持版本抛错', guarded.includes('低于最低支持版本'), guarded)

    // 默认快照与升级链的一致性（全新用户直写默认 vs 空配置走升级链，结果必须相同）
    check('DEFAULT_STORED 与升级链空输入一致', stable(DEFAULT_STORED) === stable(upgradeConfig({}, 3)), { DEFAULT_STORED, chain: upgradeConfig({}, 3) })
}
