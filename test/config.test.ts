// config.ts 纯函数测试：resolveConfig / parseSnapshot / versionKey / parseVersion
import { resolveConfig } from '@/config'
import { DEFAULT_CONFIG, parseSnapshot, parseVersion, versionKey } from '@/shared/parse'
import { check, stable } from '@test/helper'

/** 执行本文件的全部用例 */
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
        userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
    })
    // userExperience 组的出厂默认（parseSnapshot 省略整项时物化的那份）
    const UE_DEFAULT = { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false }
    // v7 快照（段内无 v8 时的最高可解析版本）：缺 efforts / userExperience 整项，经当前 schema 解析后落各项默认
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
        userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
    }), resolveConfig({ 'version-7': v7Entry }))
    // 兼容语义：v6 无 forgetRemoved，经当前 schema 解析后落该项默认（等价于「忘记已删除模型」，即维持既有行为）
    const v6Entry = {
        configVersion: 6,
        autoFill: { reasoning: true, context: false, image: false },
        allowUpdate: { reasoning: false, context: false, image: true },
        compat: { disableDeveloper: false },
        excludes: ['acme-gateway', 'lab-7'],
        userExperience: { rememberEfforts: false, defaultHigh: true },
    }
    check('取低版本（v6）快照并补 forgetRemoved 默认', stable(resolveConfig({ 'version-6': v6Entry })) === stable({
        autoFill: { reasoning: true, context: false, image: false },
        allowUpdate: { reasoning: false, context: false, image: true },
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['acme-gateway', 'lab-7'],
        efforts: {},
        userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
    }), resolveConfig({ 'version-6': v6Entry }))
    // 兼容语义：v5 无 defaultHigh / forgetRemoved，经当前 schema 解析后落该项默认（等价于「默认使用 high」）
    const v5Entry = {
        configVersion: 5,
        autoFill: { reasoning: true, context: false, image: false },
        allowUpdate: { reasoning: false, context: false, image: true },
        compat: { disableDeveloper: false },
        excludes: ['acme-gateway', 'lab-7'],
    }
    check('取低版本（v5）快照并补 defaultHigh 默认', stable(resolveConfig({ 'version-5': v5Entry })) === stable({
        autoFill: { reasoning: true, context: false, image: false },
        allowUpdate: { reasoning: false, context: false, image: true },
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['acme-gateway', 'lab-7'],
        efforts: {},
        userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
    }), resolveConfig({ 'version-5': v5Entry }))
    // 兼容语义：v4 无 efforts / userExperience，经当前 schema 解析后落该项默认
    check('取低版本（v4）快照并补 efforts / userExperience 默认', stable(resolveConfig({ 'version-4': v5Entry })) === stable({
        autoFill: { reasoning: true, context: false, image: false },
        allowUpdate: { reasoning: false, context: false, image: true },
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['acme-gateway', 'lab-7'],
        efforts: {},
        userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
    }), resolveConfig({ 'version-4': v5Entry }))
    // 兼容语义：v3 无 excludes 数组，经当前 schema 解析后落该项默认（等价于「不排除任何提供方」）
    const v3Entry = {
        configVersion: 3,
        autoFill: { reasoning: true, context: false, image: false },
        allowUpdate: { reasoning: false, context: false, image: true },
        compat: { disableDeveloper: false },
    }
    check('取低版本（v3）快照并补 excludes / efforts / userExperience 默认', stable(resolveConfig({ 'version-3': v3Entry })) === stable({
        autoFill: { reasoning: true, context: false, image: false },
        allowUpdate: { reasoning: false, context: false, image: true },
        compat: { disableDeveloper: false, disableStore: true },
        excludes: [],
        efforts: {},
        userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
    }), resolveConfig({ 'version-3': v3Entry }))
    check('布尔写法在 v4 快照中非法，回退默认', stable(resolveConfig({ 'version-4': { configVersion: 4, allowUpdate: true, autoFill: false } })) === DEFAULT_STABLE, resolveConfig({ 'version-4': { configVersion: 4, allowUpdate: true, autoFill: false } }))
    check('缺字段按整项默认补齐（含 image）', stable(resolveConfig({ 'version-4': { configVersion: 4, autoFill: { context: false } } })) === stable({
        allowUpdate: { reasoning: false, context: false, image: false },
        autoFill: { reasoning: true, context: false, image: true },
        compat: { disableDeveloper: true, disableStore: true },
        excludes: [],
        efforts: {},
        userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
    }), resolveConfig({ 'version-4': { configVersion: 4, autoFill: { context: false } } }))
    check('image 非法值整项回退默认', stable(resolveConfig({ 'version-4': { configVersion: 4, autoFill: { image: 'x' } } })) === DEFAULT_STABLE, resolveConfig({ 'version-4': { configVersion: 4, autoFill: { image: 'x' } } }))
    // compat 组与 fieldRules 同严格度：整项非对象、字段非布尔都判整段快照非法
    check('compat 非对象整段回退默认', stable(resolveConfig({ 'version-4': { configVersion: 4, compat: 'x' } })) === DEFAULT_STABLE, resolveConfig({ 'version-4': { configVersion: 4, compat: 'x' } }))
    check('compat 字段非布尔整段回退默认', stable(resolveConfig({ 'version-4': { configVersion: 4, compat: { disableDeveloper: 'yes' } } })) === DEFAULT_STABLE, resolveConfig({ 'version-4': { configVersion: 4, compat: { disableDeveloper: 'yes' } } }))
    // compat 省略字段落该字段默认（disableDeveloper / disableStore 均为 true），而非判非法——与「新增键向后兼容」一致
    check('compat 缺字段落该字段默认', stable(resolveConfig({ 'version-4': { configVersion: 4, compat: {} } })) === stable({
        allowUpdate: { reasoning: false, context: false, image: false },
        autoFill: { reasoning: true, context: true, image: true },
        compat: { disableDeveloper: true, disableStore: true },
        excludes: [],
        efforts: {},
        userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
    }), resolveConfig({ 'version-4': { configVersion: 4, compat: {} } }))
    // excludes 与其余组同严格度：非数组、元素非字符串都判整段非法（宁可整段回默认，也不带着坏值继续写回）
    check('excludes 非数组整段回退默认', stable(resolveConfig({ 'version-4': { configVersion: 4, excludes: 'acme' } })) === DEFAULT_STABLE, resolveConfig({ 'version-4': { configVersion: 4, excludes: 'acme' } }))
    check('excludes 元素非字符串整段回退默认', stable(resolveConfig({ 'version-4': { configVersion: 4, excludes: ['ok', 42] } })) === DEFAULT_STABLE, resolveConfig({ 'version-4': { configVersion: 4, excludes: ['ok', 42] } }))
    check('excludes 空数组合法', stable(resolveConfig({ 'version-4': { configVersion: 4, excludes: [] } })) === DEFAULT_STABLE, resolveConfig({ 'version-4': { configVersion: 4, excludes: [] } }))
    // 唯一性由录入端保证（重复即提示并拒绝写入），故解析端只原样保留、不去重也不排序（顺序是用户意图）
    check('excludes 解析端原样保留（不去重、不排序）', stable((resolveConfig({ 'version-4': { configVersion: 4, excludes: ['b', 'a', 'b'] } }) as { excludes: string[] }).excludes) === stable(['b', 'a', 'b']), resolveConfig({ 'version-4': { configVersion: 4, excludes: ['b', 'a', 'b'] } }))
    // userExperience 与 compat 同严格度：整项非对象、字段非布尔判整段非法；省略字段落默认
    check('userExperience 非对象整段回退默认', stable(resolveConfig({ 'version-4': { configVersion: 4, userExperience: 'x' } })) === DEFAULT_STABLE, resolveConfig({ 'version-4': { configVersion: 4, userExperience: 'x' } }))
    check('userExperience 字段非布尔整段回退默认', stable(resolveConfig({ 'version-4': { configVersion: 4, userExperience: { rememberEfforts: 'yes' } } })) === DEFAULT_STABLE, resolveConfig({ 'version-4': { configVersion: 4, userExperience: { rememberEfforts: 'yes' } } }))
    check('userExperience defaultHigh 非布尔整段回退默认', stable(resolveConfig({ 'version-7': { configVersion: 7, userExperience: { defaultHigh: 'yes' } } })) === DEFAULT_STABLE, resolveConfig({ 'version-7': { configVersion: 7, userExperience: { defaultHigh: 'yes' } } }))
    check('userExperience forgetRemoved 非布尔整段回退默认', stable(resolveConfig({ 'version-7': { configVersion: 7, userExperience: { forgetRemoved: 'yes' } } })) === DEFAULT_STABLE, resolveConfig({ 'version-7': { configVersion: 7, userExperience: { forgetRemoved: 'yes' } } }))
    check('userExperience 缺字段落该字段默认', stable(resolveConfig({ 'version-4': { configVersion: 4, userExperience: {} } })) === DEFAULT_STABLE, resolveConfig({ 'version-4': { configVersion: 4, userExperience: {} } }))
    check('userExperience rememberEfforts false 原样生效', stable((resolveConfig({ 'version-4': { configVersion: 4, userExperience: { rememberEfforts: false } } }) as { userExperience: { rememberEfforts: boolean; defaultHigh: boolean; forgetRemoved: boolean; followParent: boolean } }).userExperience) === stable({ rememberEfforts: false, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false }))
    check('userExperience defaultHigh true 原样生效', stable((resolveConfig({ 'version-7': { configVersion: 7, userExperience: { defaultHigh: true } } }) as { userExperience: { rememberEfforts: boolean; defaultHigh: boolean; forgetRemoved: boolean; followParent: boolean } }).userExperience) === stable({ rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false }))
    check('userExperience forgetRemoved false 原样生效', stable((resolveConfig({ 'version-7': { configVersion: 7, userExperience: { forgetRemoved: false } } }) as { userExperience: { rememberEfforts: boolean; defaultHigh: boolean; forgetRemoved: boolean; followParent: boolean } }).userExperience) === stable({ rememberEfforts: true, defaultHigh: true, forgetRemoved: false, followParent: false, selfTune: false }))
    check('低于最低支持版本（MIN_SUPPORTED_VERSION = 3）的快照被忽略回默认', stable(resolveConfig({ 'version-2': { configVersion: 2, autoFill: { reasoning: false, context: false } } })) === DEFAULT_STABLE && stable(resolveConfig({ 'version-0': { allowUpdate: true } })) === DEFAULT_STABLE, resolveConfig({ 'version-2': { configVersion: 2, autoFill: { reasoning: false, context: false } } }))
    // 降级兼容语义：无当前版本时，取段内最高版本快照按当前 schema 解析（多余键忽略、缺失字段落默认）
    check('仅更高版本降级解析保留配置', stable(resolveConfig({ 'version-9': { autoFill: { reasoning: false, context: true, image: false }, compat: { disableDeveloper: false }, excludes: ['x'] } })) === stable({
        autoFill: { reasoning: false, context: true, image: false },
        allowUpdate: { reasoning: false, context: false, image: false },
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['x'],
        efforts: {},
        userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
    }), resolveConfig({ 'version-9': { autoFill: { reasoning: false, context: true, image: false }, compat: { disableDeveloper: false }, excludes: ['x'] } }))
    check('仅更高版本降级解析保留 efforts 记忆', stable(resolveConfig({ 'version-9': { efforts: { 'z-ai': { 'glm-5.2': 'high' } } } }).efforts) === stable({ 'z-ai': { 'glm-5.2': 'high' } }), resolveConfig({ 'version-9': { efforts: { 'z-ai': { 'glm-5.2': 'high' } } } }).efforts)
    check('仅更高版本降级解析保留 userExperience（含 defaultHigh 与 forgetRemoved）', stable((resolveConfig({ 'version-9': { userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: false, followParent: false } } }) as { userExperience: { rememberEfforts: boolean; defaultHigh: boolean; forgetRemoved: boolean; followParent: boolean } }).userExperience) === stable({ rememberEfforts: false, defaultHigh: true, forgetRemoved: false, followParent: false, selfTune: false }), resolveConfig({ 'version-9': { userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: false, followParent: false } } }))
    check('仅更高版本且全缺省降级得默认', stable(resolveConfig({ 'version-9': { whatever: true } })) === DEFAULT_STABLE, resolveConfig({ 'version-9': { whatever: true } }))
    // 当前版本优先于更高版本：即使更高版本先被遍历成为候选，命中当前版本即提前返回
    check('当前版本（v8）与更高版本并存仍取 v8', stable(resolveConfig({ 'version-9': { autoFill: { reasoning: false, context: false, image: false } }, 'version-8': v8Entry })) === stable({
        autoFill: { reasoning: false, context: true, image: false },
        allowUpdate: { reasoning: false, context: false, image: false },
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['x'],
        efforts: {},
        userExperience: { rememberEfforts: true, defaultHigh: false, forgetRemoved: true, followParent: true, selfTune: false },
    }), resolveConfig({ 'version-9': { autoFill: { reasoning: false, context: false, image: false } }, 'version-8': v8Entry }))
    // 无当前版本快照时取段内最高可解析版本（含更高版本）
    check('无 v8 快照时取段内最高的可解析版本（v9 胜过 v7）',
        stable(resolveConfig({ 'version-7': v7Entry, 'version-9': { autoFill: { reasoning: false, context: true, image: false }, compat: { disableDeveloper: false }, excludes: ['x'] } })) === stable({
            autoFill: { reasoning: false, context: true, image: false },
            allowUpdate: { reasoning: false, context: false, image: false },
            compat: { disableDeveloper: false, disableStore: true },
            excludes: ['x'],
            efforts: {},
            userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
        }), resolveConfig({ 'version-7': v7Entry, 'version-9': { autoFill: { reasoning: false, context: true, image: false }, compat: { disableDeveloper: false }, excludes: ['x'] } }))
    check('非法快照回默认', stable(resolveConfig({ 'version-4': 'garbage' })) === DEFAULT_STABLE, resolveConfig({ 'version-4': 'garbage' }))
    check('段为数组/非对象回默认', stable(resolveConfig([])) === DEFAULT_STABLE, resolveConfig([]))

    // parseSnapshot：迁移侧据此判定当前版本快照是否仍可解析（决定要不要自愈重写）
    check('parseSnapshot 合法快照物化为三组布尔 + 排除列表 + 记忆 + 用户体验', stable(parseSnapshot(v7Entry)) === stable({
        autoFill: { reasoning: true, context: false, image: false },
        allowUpdate: { reasoning: false, context: false, image: true },
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['acme-gateway', 'lab-7'],
        efforts: {},
        userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
    }), parseSnapshot(v7Entry))
    check('parseSnapshot 省略字段落该项默认', stable(parseSnapshot({ configVersion: 4, autoFill: { context: false } })) === stable({
        allowUpdate: { reasoning: false, context: false, image: false },
        autoFill: { reasoning: true, context: false, image: true },
        compat: { disableDeveloper: true, disableStore: true },
        excludes: [],
        efforts: {},
        userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
    }), parseSnapshot({ configVersion: 4, autoFill: { context: false } }))
    check('parseSnapshot 拒绝垃圾/布尔写法/非对象', parseSnapshot('garbage') === undefined
        && parseSnapshot({ autoFill: true, allowUpdate: false }) === undefined
        && parseSnapshot(undefined) === undefined
        && parseSnapshot([]) === undefined)
    // userExperience 的 followParent 行：与该组其余行同严格度——非布尔判整段快照非法
    check('userExperience 缺 followParent 落默认（不跟随）', stable(parseSnapshot({ configVersion: 8 })?.userExperience) === stable(UE_DEFAULT), parseSnapshot({ configVersion: 8 }))
    check('userExperience followParent true 原样沿用', stable(parseSnapshot({ configVersion: 8, userExperience: { followParent: true } })?.userExperience) === stable({ ...UE_DEFAULT, followParent: true }), parseSnapshot({ configVersion: 8, userExperience: { followParent: true } }))
    for (const bad of ['yes', 1, null]) {
        check(`userExperience followParent 非布尔整段快照判非法（${stable(bad)}）`, parseSnapshot({ configVersion: 8, userExperience: { followParent: bad } }) === undefined, parseSnapshot({ configVersion: 8, userExperience: { followParent: bad } }))
    }
    // 组内未知键按忽略处理（与 compat 同口径），故旧的 effort 键不影响解析
    check('userExperience 组内未知键按忽略处理', stable(parseSnapshot({ configVersion: 8, userExperience: { effort: 'turbo' } })?.userExperience) === stable(UE_DEFAULT), parseSnapshot({ configVersion: 8, userExperience: { effort: 'turbo' } }))
    check('v8 快照里的 followParent 经 resolveConfig 原样生效', stable(resolveConfig({ 'version-8': v8Entry }).userExperience) === stable({ rememberEfforts: true, defaultHigh: false, forgetRemoved: true, followParent: true, selfTune: false }), resolveConfig({ 'version-8': v8Entry }).userExperience)
    check('parseSnapshot 剥离 configVersion 等运行时不消费的键', Object.keys(parseSnapshot(v7Entry) ?? {}).sort().join(',') === 'allowUpdate,autoFill,compat,efforts,excludes,userExperience', parseSnapshot(v7Entry))
    // 缺省 excludes 落的是新建数组：解析结果被调用方改动不得污染 DEFAULT_CONFIG
    const materialized = parseSnapshot({ configVersion: 4 })
    materialized?.excludes.push('mutated')
    check('parseSnapshot 缺省 excludes 不与默认常量共享引用', DEFAULT_CONFIG.excludes.length === 0, { DEFAULT_CONFIG, materialized })
}
