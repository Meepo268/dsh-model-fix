// config.ts 纯函数测试：resolveConfig / parseSnapshot / versionKey / parseVersion
import { resolveConfig } from '@/config'
import { DEFAULT_CONFIG, parseSnapshot, parseVersion, versionKey } from '@/shared/config-schema'
import { check, stable } from '@test/helper'

export function run(): void {
    check('versionKey 拼接', versionKey(1) === 'version-1')
    check('parseVersion 合法', parseVersion('version-12') === 12 && parseVersion('version-0') === 0)
    check('parseVersion 非法返回 undefined', parseVersion('version-x') === undefined && parseVersion('allowUpdate') === undefined)
    // 非规范键必须拒绝：collectVersions/pruneOps 会用 versionKey() 重建键名，宽泛归一会导致读空、清理脱靶
    for (const bad of ['version-', 'version-01', 'version- 1', 'version-+1', 'version-1e3', 'version-1.0', 'version--1']) {
        check(`parseVersion 拒绝非规范键 ${bad}`, parseVersion(bad) === undefined, bad)
    }
    const DEFAULT_STABLE = stable({
        allowUpdate: { reasoning: false, context: false, image: false },
        autoFill: { reasoning: true, context: true, image: true },
        compat: { disableDeveloper: true, disableStore: true },
        excludes: [],
        efforts: {},
        written: {},
        sources: {},
        behavior: { showInModels: true, showInBuiltinPlugins: true, showInComposer: true, showFollowStatus: true, backToChat: true, showInFloat: true, classicSetting: true },
        userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: true, showOriginalEfforts: true, looseMatch: false, nameFallback: true },
    })
    // userExperience 组的出厂默认（parseSnapshot 省略整项时物化的那份）
    const UE_DEFAULT = { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: true, showOriginalEfforts: true, looseMatch: false, nameFallback: true }
    // behavior 组的出厂默认（v8 形态内新增的顶级组；此前落盘的快照无此段，解析时落这份全开值）
    const BEHAVIOR_DEFAULT = { showInModels: true, showInBuiltinPlugins: true, showInComposer: true, showFollowStatus: true, backToChat: true, showInFloat: true, classicSetting: true }
    // v7 快照（最低支持版本；缺 efforts 与 userExperience 整项的形态）
    const v7Entry = {
        configVersion: 7,
        autoFill: { reasoning: true, context: false, image: false },
        allowUpdate: { reasoning: false, context: false, image: true },
        compat: { disableDeveloper: false },
        excludes: ['acme-gateway', 'lab-7'],
    }
    // 当前版本（v8）快照：userExperience 组原样沿用（含非默认值 followParent），其余缺项落默认
    const v8Entry = {
        configVersion: 8,
        autoFill: { reasoning: false, context: true, image: false },
        allowUpdate: { reasoning: false, context: false, image: false },
        compat: { disableDeveloper: false },
        excludes: ['x'],
        userExperience: { rememberEfforts: true, defaultHigh: false, forgetRemoved: true, followParent: true },
    }
    check('段内无 v8 快照时降取最高可解析的 v7 快照', stable(resolveConfig({ 'version-7': v7Entry })) === stable({
        autoFill: { reasoning: true, context: false, image: false },
        allowUpdate: { reasoning: false, context: false, image: true },
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['acme-gateway', 'lab-7'],
        efforts: {},
        written: {},
        sources: {},
        behavior: { showInModels: true, showInBuiltinPlugins: true, showInComposer: true, showFollowStatus: true, backToChat: true, showInFloat: true, classicSetting: true },
        userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: true, showOriginalEfforts: true, looseMatch: false, nameFallback: true },
    }), resolveConfig({ 'version-7': v7Entry }))
    // 兼容语义：v7 无 followParent / selfTune / hideOfficial / localizeEfforts / showOriginalEfforts / disableStore，
    // 经当前 schema 解析后落这些键的默认值（新增键向后兼容，见 docs/versioning.md）
    const v7WithUE = {
        configVersion: 7,
        autoFill: { reasoning: true, context: false, image: false },
        allowUpdate: { reasoning: false, context: false, image: true },
        compat: { disableDeveloper: false },
        excludes: ['acme-gateway', 'lab-7'],
        userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: true },
    }
    check('取 v7 快照补 v8 新键默认', stable(resolveConfig({ 'version-7': v7WithUE })) === stable({
        autoFill: { reasoning: true, context: false, image: false },
        allowUpdate: { reasoning: false, context: false, image: true },
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['acme-gateway', 'lab-7'],
        efforts: {},
        written: {},
        sources: {},
        behavior: { showInModels: true, showInBuiltinPlugins: true, showInComposer: true, showFollowStatus: true, backToChat: true, showInFloat: true, classicSetting: true },
        userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: true, showOriginalEfforts: true, looseMatch: false, nameFallback: true },
    }), resolveConfig({ 'version-7': v7WithUE }))
    check('布尔写法在 v7 快照中非法，回退默认', stable(resolveConfig({ 'version-7': { configVersion: 7, allowUpdate: true, autoFill: false } })) === DEFAULT_STABLE, resolveConfig({ 'version-7': { configVersion: 7, allowUpdate: true, autoFill: false } }))
    check('缺字段按整项默认补齐（含 image）', stable(resolveConfig({ 'version-7': { configVersion: 7, autoFill: { context: false } } })) === stable({
        allowUpdate: { reasoning: false, context: false, image: false },
        autoFill: { reasoning: true, context: false, image: true },
        compat: { disableDeveloper: true, disableStore: true },
        excludes: [],
        efforts: {},
        written: {},
        sources: {},
        behavior: BEHAVIOR_DEFAULT,
        userExperience: UE_DEFAULT,
    }), resolveConfig({ 'version-7': { configVersion: 7, autoFill: { context: false } } }))
    check('compat 缺整项落默认', stable(resolveConfig({ 'version-7': { configVersion: 7, compat: {} } })) === DEFAULT_STABLE, resolveConfig({ 'version-7': { configVersion: 7, compat: {} } }))
    // excludes 与其余组同严格度：非数组、元素非字符串都判整段非法（宁可整段回默认，也不带着坏值继续写回）
    check('excludes 非数组整段回退默认', stable(resolveConfig({ 'version-7': { configVersion: 7, excludes: 'acme' } })) === DEFAULT_STABLE, resolveConfig({ 'version-7': { configVersion: 7, excludes: 'acme' } }))
    check('excludes 元素非字符串整段回退默认', stable(resolveConfig({ 'version-7': { configVersion: 7, excludes: ['ok', 42] } })) === DEFAULT_STABLE, resolveConfig({ 'version-7': { configVersion: 7, excludes: ['ok', 42] } }))
    check('excludes 空数组合法', stable(resolveConfig({ 'version-7': { configVersion: 7, excludes: [] } })) === DEFAULT_STABLE, resolveConfig({ 'version-7': { configVersion: 7, excludes: [] } }))
    // 唯一性由录入端保证（重复即提示并拒绝写入），故解析端只原样保留、不去重也不排序（顺序是用户意图）
    check('excludes 解析端原样保留（不去重、不排序）', stable((resolveConfig({ 'version-7': { configVersion: 7, excludes: ['b', 'a', 'b'] } }) as { excludes: string[] }).excludes) === stable(['b', 'a', 'b']), resolveConfig({ 'version-7': { configVersion: 7, excludes: ['b', 'a', 'b'] } }))
    // userExperience 与 compat 同严格度：整项非对象、字段非布尔判整段非法；省略字段落默认
    check('userExperience 非对象整段回退默认', stable(resolveConfig({ 'version-7': { configVersion: 7, userExperience: 'x' } })) === DEFAULT_STABLE, resolveConfig({ 'version-7': { configVersion: 7, userExperience: 'x' } }))
    check('userExperience 字段非布尔整段回退默认', stable(resolveConfig({ 'version-7': { configVersion: 7, userExperience: { rememberEfforts: 'yes' } } })) === DEFAULT_STABLE, resolveConfig({ 'version-7': { configVersion: 7, userExperience: { rememberEfforts: 'yes' } } }))
    check('userExperience defaultHigh 非布尔整段回退默认', stable(resolveConfig({ 'version-7': { configVersion: 7, userExperience: { defaultHigh: 'yes' } } })) === DEFAULT_STABLE, resolveConfig({ 'version-7': { configVersion: 7, userExperience: { defaultHigh: 'yes' } } }))
    check('userExperience forgetRemoved 非布尔整段回退默认', stable(resolveConfig({ 'version-7': { configVersion: 7, userExperience: { forgetRemoved: 'yes' } } })) === DEFAULT_STABLE, resolveConfig({ 'version-7': { configVersion: 7, userExperience: { forgetRemoved: 'yes' } } }))
    check('userExperience 缺字段落该字段默认', stable(resolveConfig({ 'version-7': { configVersion: 7, userExperience: {} } })) === DEFAULT_STABLE, resolveConfig({ 'version-7': { configVersion: 7, userExperience: {} } }))
    check('userExperience rememberEfforts false 原样生效', stable((resolveConfig({ 'version-7': { configVersion: 7, userExperience: { rememberEfforts: false } } }) as { userExperience: { rememberEfforts: boolean; defaultHigh: boolean; forgetRemoved: boolean; followParent: boolean } }).userExperience) === stable({ rememberEfforts: false, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: true, showOriginalEfforts: true, looseMatch: false, nameFallback: true }))
    check('userExperience defaultHigh true 原样生效', stable((resolveConfig({ 'version-7': { configVersion: 7, userExperience: { defaultHigh: true } } }) as { userExperience: { rememberEfforts: boolean; defaultHigh: boolean; forgetRemoved: boolean; followParent: boolean } }).userExperience) === stable({ rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: true, showOriginalEfforts: true, looseMatch: false, nameFallback: true }))
    check('userExperience forgetRemoved false 原样生效', stable((resolveConfig({ 'version-7': { configVersion: 7, userExperience: { forgetRemoved: false } } }) as { userExperience: { rememberEfforts: boolean; defaultHigh: boolean; forgetRemoved: boolean; followParent: boolean } }).userExperience) === stable({ rememberEfforts: true, defaultHigh: true, forgetRemoved: false, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: true, showOriginalEfforts: true, looseMatch: false, nameFallback: true }))
    // behavior 与其余组同严格度；缺省落全开（新增顶级组不升版本的兼容语义，见 docs/versioning.md）
    check('behavior 整项缺失落全开默认', stable(resolveConfig({ 'version-8': { configVersion: 8 } }).behavior) === stable(BEHAVIOR_DEFAULT), resolveConfig({ 'version-8': { configVersion: 8 } }))
    check('behavior 整项为空对象落全开默认', stable(resolveConfig({ 'version-8': { configVersion: 8, behavior: {} } }).behavior) === stable(BEHAVIOR_DEFAULT), resolveConfig({ 'version-8': { configVersion: 8, behavior: {} } }))
    check('behavior 非对象整段回退默认', stable(resolveConfig({ 'version-8': { configVersion: 8, behavior: 'x' } })) === DEFAULT_STABLE, resolveConfig({ 'version-8': { configVersion: 8, behavior: 'x' } }))
    check('behavior 字段非布尔整段回退默认', stable(resolveConfig({ 'version-8': { configVersion: 8, behavior: { showInModels: 'yes' } } })) === DEFAULT_STABLE, resolveConfig({ 'version-8': { configVersion: 8, behavior: { showInModels: 'yes' } } }))
    check('behavior 显式 false 原样生效、其余落默认', stable(resolveConfig({ 'version-8': { configVersion: 8, behavior: { showInComposer: false } } }).behavior) === stable({ ...BEHAVIOR_DEFAULT, showInComposer: false }), resolveConfig({ 'version-8': { configVersion: 8, behavior: { showInComposer: false } } }))
    check('低于最低支持版本（MIN_SUPPORTED_VERSION = 7）的快照被忽略回默认', stable(resolveConfig({ 'version-2': { configVersion: 2, autoFill: { reasoning: false, context: false } } })) === DEFAULT_STABLE && stable(resolveConfig({ 'version-0': { allowUpdate: true } })) === DEFAULT_STABLE, resolveConfig({ 'version-2': { configVersion: 2, autoFill: { reasoning: false, context: false } } }))
    check('段内只有 v1–v6 全部被忽略回默认（MIN_SUPPORTED_VERSION = 7）', stable(resolveConfig({ 'version-3': { autoFill: {} }, 'version-5': { allowUpdate: {} }, 'version-6': { excludes: [] } })) === DEFAULT_STABLE, resolveConfig({ 'version-3': { autoFill: {} }, 'version-5': { allowUpdate: {} }, 'version-6': { excludes: [] } }))
    // 段内无当前版本快照但有可用更高版本快照 → 取该快照降级解析（parseSnapshot 只吃已知键）
    check('当前版本键缺席时取更高版本快照降级解析（parseSnapshot 补全 userExperience 缺键默认）', stable(resolveConfig({ 'version-9': v8Entry })) === stable({
        autoFill: v8Entry.autoFill,
        allowUpdate: v8Entry.allowUpdate,
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['x'],
        efforts: {},
        written: {},
        sources: {},
        behavior: BEHAVIOR_DEFAULT,
        userExperience: { rememberEfforts: true, defaultHigh: false, forgetRemoved: true, followParent: true, selfTune: false, hideOfficial: true, localizeEfforts: true, showOriginalEfforts: true, looseMatch: false, nameFallback: true },
    }), resolveConfig({ 'version-9': v8Entry }))
    check('更高版本快照含未知键时 parseSnapshot 剥离未知键', Object.keys(resolveConfig({ 'version-9': { ...v8Entry, unknownTop: 1 } })).sort().join(',') === 'allowUpdate,autoFill,behavior,compat,efforts,excludes,sources,userExperience,written')
    check('更高版本快照含额外组键时 parseSnapshot 剥离', Object.keys(resolveConfig({ 'version-9': { ...v8Entry, extraGroup: { a: 1 } } })).sort().join(',') === 'allowUpdate,autoFill,behavior,compat,efforts,excludes,sources,userExperience,written')
    // 解析错误传播到 resolveConfig：快照整体非法时整段回默认
    check('更高版本快照结构非法整段回退默认', stable(resolveConfig({ 'version-9': { ...v8Entry, autoFill: 'bad' } })) === DEFAULT_STABLE, resolveConfig({ 'version-9': { ...v8Entry, autoFill: 'bad' } }))
    check('快照组内类型非法整段回退默认', stable(resolveConfig({ 'version-8': { ...v8Entry, allowUpdate: 'bad' } })) === DEFAULT_STABLE, resolveConfig({ 'version-8': { ...v8Entry, allowUpdate: 'bad' } }))
    // parseSnapshot 的完整形态校验
    check('parseSnapshot 快照各键完整形态', stable(parseSnapshot({
        configVersion: 8,
        allowUpdate: { reasoning: true, context: true, image: true },
        autoFill: { reasoning: false, context: false, image: false },
        compat: { disableDeveloper: false, disableStore: false },
        excludes: ['foo'],
        efforts: { 'some-provider': { 'some-model': 'high' } },
        written: {},
        sources: {},
        behavior: BEHAVIOR_DEFAULT,
        userExperience: { rememberEfforts: true, defaultHigh: false, forgetRemoved: false, followParent: true, selfTune: true, hideOfficial: false, localizeEfforts: false, showOriginalEfforts: false, looseMatch: false, nameFallback: true },
    })) === stable({
        allowUpdate: { reasoning: true, context: true, image: true },
        autoFill: { reasoning: false, context: false, image: false },
        compat: { disableDeveloper: false, disableStore: false },
        excludes: ['foo'],
        efforts: { 'some-provider': { 'some-model': 'high' } },
        written: {},
        sources: {},
        behavior: BEHAVIOR_DEFAULT,
        userExperience: { rememberEfforts: true, defaultHigh: false, forgetRemoved: false, followParent: true, selfTune: true, hideOfficial: false, localizeEfforts: false, showOriginalEfforts: false, looseMatch: false, nameFallback: true },
    }), parseSnapshot({ configVersion: 8, allowUpdate: { reasoning: true, context: true, image: true }, autoFill: { reasoning: false, context: false, image: false }, compat: { disableDeveloper: false, disableStore: false }, excludes: ['foo'], efforts: { 'some-provider': { 'some-model': 'high' } }, behavior: { showInModels: true, showInBuiltinPlugins: true, showInComposer: true, showFollowStatus: true, backToChat: true, showInFloat: true, classicSetting: true }, userExperience: { rememberEfforts: true, defaultHigh: false, forgetRemoved: false, followParent: true, selfTune: true, hideOfficial: false, localizeEfforts: false, showOriginalEfforts: false } }))
    check('parseSnapshot 允许 v8 快照 userExperience 缺 followParent（整项回默认）', stable(parseSnapshot({ configVersion: 8, userExperience: {} })) === stable({ ...DEFAULT_CONFIG, userExperience: UE_DEFAULT }), parseSnapshot({ configVersion: 8, userExperience: {} }))
    check('parseSnapshot v8 userExperience 非法字段触发整段非法（不是单个键）', parseSnapshot({ configVersion: 8, userExperience: { rememberEfforts: 'bad' } }) === undefined, parseSnapshot({ configVersion: 8, userExperience: { rememberEfforts: 'bad' } }))
    check('v8 快照里的 followParent 经 resolveConfig 原样生效', stable(resolveConfig({ 'version-8': v8Entry }).userExperience) === stable({ rememberEfforts: true, defaultHigh: false, forgetRemoved: true, followParent: true, selfTune: false, hideOfficial: true, localizeEfforts: true, showOriginalEfforts: true, looseMatch: false, nameFallback: true }), resolveConfig({ 'version-8': v8Entry }).userExperience)
    check('parseSnapshot 剥离 configVersion 等运行时不消费的键', Object.keys(parseSnapshot(v7Entry) ?? {}).sort().join(',') === 'allowUpdate,autoFill,behavior,compat,efforts,excludes,sources,userExperience,written', parseSnapshot(v7Entry))
    // 缺省 excludes 落的是新建数组：解析结果被调用方改动不得污染 DEFAULT_CONFIG
    const materialized = parseSnapshot({ configVersion: 7 })
    materialized?.excludes.push('mutated')
    check('parseSnapshot 缺省 excludes 不与默认常量共享引用', DEFAULT_CONFIG.excludes.length === 0, { DEFAULT_CONFIG, materialized })
}
