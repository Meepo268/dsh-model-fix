/** src/client/model.ts 纯映射层用例：解码（只读 version-8，非法/缺失回默认）、组总控/单格语义、排除列表增删与命中判定、脏检测、快照规范化、验证候选拍取、目标收敛与分组全选、探测式填充候选（未填充判据 / 忽略排除）与七档展开 */

import { check, stable } from '@test/helper'
import { DEFAULT_CONFIG as DEFAULT_FLAGS, toStored } from '@/shared/parse'
import {
    EXCLUDE_ID_PATTERN,
    VERSION_KEY,
    addExclude,
    applyGroup,
    decodeSection,
    groupAllPicked,
    groupValue,
    isDirty,
    masterValue,
    probeCandidatesOf,
    probeTargetsOf,
    providerIdsOf,
    removeExclude,
    resolveHits,
    toggleCell,
    toggleGroupPicks,
    verifyCandidatesOf,
    verifyKey,
    verifyTargets,
} from '@/client/model'
import type { Flags } from '@/client/model'
import { EFFORT_LEVELS } from '@/shared/constants'

/** 三组全开的配置（总控与整组置位用例的基准，无排除项，无记忆，用户体验各项全开） */
const ALL_ON: Flags = {
    autoFill: { reasoning: true, context: true, image: true },
    allowUpdate: { reasoning: true, context: true, image: true },
    compat: { disableDeveloper: true, disableStore: true },
    excludes: [],
    efforts: {},
    userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: true, selfTune: true },
}

/** 带两个排除项的配置（排除列表用例的基准，其中 acme-gateway 在 providerIds 里命中） */
const WITH_EXCLUDES: Flags = { ...ALL_ON, excludes: ['acme-gateway', 'lab-7'] }

/** 带推理级别记忆的配置（efforts 用例基准） */
const WITH_EFFORTS: Flags = { ...ALL_ON, efforts: { 'z-ai': { 'glm-5.2': 'high' } } }

/** 执行本文件的全部用例 */
export function run(): void {
    // ---------- decodeSection：v8 正常解析 ----------
    check(
        'decode 完整 v8 快照',
        stable(decodeSection({
            'version-8': { configVersion: 8, autoFill: { reasoning: false, context: true, image: false }, allowUpdate: { reasoning: true, context: false, image: false }, compat: { disableDeveloper: false, disableStore: false }, excludes: ['acme-gateway'] },
        })) === stable({
            autoFill: { reasoning: false, context: true, image: false },
            allowUpdate: { reasoning: true, context: false, image: false },
            compat: { disableDeveloper: false, disableStore: false },
            excludes: ['acme-gateway'],
            efforts: {},
            userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
        }),
    )
    // ---------- v8 缺 excludes 整项落默认（向后兼容语义） ----------
    check(
        'decode 缺 excludes 落空数组',
        stable(decodeSection({ 'version-8': { autoFill: { reasoning: false }, allowUpdate: { reasoning: true } } })) === stable({
            autoFill: { reasoning: false, context: true, image: true },
            allowUpdate: { reasoning: true, context: false, image: false },
            compat: { disableDeveloper: true, disableStore: true },
            excludes: [],
            efforts: {},
            userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
        }),
    )
    // ---------- v8 缺 compat 整项落默认（v3 时代就有的兼容语义，升级后不变） ----------
    check(
        'decode 缺 compat 落默认 true',
        stable(decodeSection({ 'version-8': { excludes: ['acme-gateway'] } })) === stable({
            autoFill: { reasoning: true, context: true, image: true },
            allowUpdate: { reasoning: false, context: false, image: false },
            compat: { disableDeveloper: true, disableStore: true },
            excludes: ['acme-gateway'],
            efforts: {},
            userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
        }),
    )
    // ---------- v8 带 efforts 正常解析 ----------
    check(
        'decode 含 efforts 快照',
        stable(decodeSection({
            'version-8': { autoFill: { reasoning: true }, efforts: { 'z-ai': { 'glm-5.2': 'high' } } },
        })) === stable({
            autoFill: { reasoning: true, context: true, image: true },
            allowUpdate: { reasoning: false, context: false, image: false },
            compat: { disableDeveloper: true, disableStore: true },
            excludes: [],
            efforts: { 'z-ai': { 'glm-5.2': 'high' } },
            userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
        }),
    )
    // ---------- userExperience：缺整项落默认、字段原样生效、字段缺省落默认 ----------
    check('decode 缺 userExperience 落默认', stable(decodeSection({ 'version-8': {} })) === stable(DEFAULT_FLAGS))
    check('decode userExperience rememberEfforts false 原样生效', stable(decodeSection({ 'version-8': { userExperience: { rememberEfforts: false } } })) === stable({ ...DEFAULT_FLAGS, userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false } }))
    check('decode userExperience defaultHigh true 原样生效', stable(decodeSection({ 'version-8': { userExperience: { defaultHigh: true } } })) === stable({ ...DEFAULT_FLAGS, userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false } }))
    check('decode userExperience forgetRemoved false 原样生效', stable(decodeSection({ 'version-8': { userExperience: { forgetRemoved: false, followParent: false } } })) === stable({ ...DEFAULT_FLAGS, userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: false, followParent: false, selfTune: false } }))
    check('decode userExperience 缺字段落默认', stable(decodeSection({ 'version-8': { userExperience: {} } })) === stable(DEFAULT_FLAGS))
    // ---------- userExperience 非对象 / 字段非布尔 => 整段快照非法（镜像 Node 侧 schema） ----------
    check('decode userExperience 非对象回退默认', stable(decodeSection({ 'version-8': { userExperience: 'x' } })) === stable(DEFAULT_FLAGS))
    check('decode userExperience 字段非布尔回退默认', stable(decodeSection({ 'version-8': { userExperience: { rememberEfforts: 'yes' } } })) === stable(DEFAULT_FLAGS))
    check('decode userExperience defaultHigh 非布尔回退默认', stable(decodeSection({ 'version-8': { userExperience: { defaultHigh: 'yes' } } })) === stable(DEFAULT_FLAGS))
    check('decode userExperience forgetRemoved 非布尔回退默认', stable(decodeSection({ 'version-8': { userExperience: { forgetRemoved: 'yes' } } })) === stable(DEFAULT_FLAGS))
    // ---------- efforts 宽松解析：结构不符回落 {}，不判整段快照非法 ----------
    check('decode efforts 非对象回落空（快照仍合法）', stable(decodeSection({ 'version-8': { efforts: 'bad' } })) === stable(DEFAULT_FLAGS))
    check('decode efforts 内层非对象回落空', stable(decodeSection({ 'version-8': { efforts: { a: 'bad' } } })) === stable(DEFAULT_FLAGS))
    check('decode efforts 混合保留合法项', stable(decodeSection({ 'version-8': { efforts: { a: { m: 'high', bad: 42 } } } })) === stable({ ...DEFAULT_FLAGS, efforts: { a: { m: 'high' } } }))
    // ---------- 组非对象 / 字段类型非法 => 整段快照非法，回退默认（镜像 Node 侧 schema 抛错语义） ----------
    check('decode compat 非对象回退默认', stable(decodeSection({ 'version-8': { compat: 'x' } })) === stable(DEFAULT_FLAGS))
    check('decode compat 字段非布尔回退默认', stable(decodeSection({ 'version-8': { compat: { disableDeveloper: 'yes' } } })) === stable(DEFAULT_FLAGS))
    check('decode excludes 非数组回退默认', stable(decodeSection({ 'version-8': { excludes: 'acme-gateway' } })) === stable(DEFAULT_FLAGS))
    check('decode excludes 元素非字符串回退默认', stable(decodeSection({ 'version-8': { excludes: ['ok', 42] } })) === stable(DEFAULT_FLAGS))
    check('decode excludes 空数组合法且区别于缺失', stable(decodeSection({ 'version-8': { excludes: [] } })) === stable(DEFAULT_FLAGS))
    check(
        'decode 字段非布尔非法回退默认',
        stable(decodeSection({
            'version-3': { configVersion: 3, autoFill: { reasoning: false, context: false }, allowUpdate: { reasoning: true, context: true } },
            'version-8': { autoFill: { reasoning: 'yes' } },
        })) === stable(DEFAULT_FLAGS),
    )
    // ---------- 只读 version-8：段内仅有低版本快照（迁移未完成/失败）不读取，回默认 ----------
    check(
        'decode 段内仅有 v5 回默认',
        stable(decodeSection({
            'version-5': { configVersion: 5, autoFill: { reasoning: true, context: false }, allowUpdate: { reasoning: false, context: true }, compat: { disableDeveloper: false }, excludes: [] },
        })) === stable(DEFAULT_FLAGS),
    )
    check(
        'decode 段内仅有 v2 回默认',
        stable(decodeSection({
            'version-2': { configVersion: 2, autoFill: { reasoning: true, context: false }, allowUpdate: { reasoning: false, context: true } },
        })) === stable(DEFAULT_FLAGS),
    )
    // ---------- 更高版本快照不读取（由写入它的版本负责） ----------
    check(
        'decode 段内仅有更高版本回默认',
        stable(decodeSection({ 'version-9': { autoFill: { reasoning: true, context: true, image: true } } })) === stable(DEFAULT_FLAGS),
    )
    // ---------- 非对象段与垃圾输入一律兜默认，永不 undefined ----------
    check('decode 段为布尔回退默认', stable(decodeSection({ 'version-8': true })) === stable(DEFAULT_FLAGS))
    for (const junk of [undefined, null, 42, 'x', [], { foo: 1 }, { 'version-8': null }, { 'version-x': {} }]) {
        check(`decode 垃圾输入兜默认 ${stable(junk)}`, stable(decodeSection(junk)) === stable(DEFAULT_FLAGS), junk)
    }
    // ---------- toStored：规范形态（configVersion + 三组布尔 + 排除列表 + efforts + userExperience 全显式，无多余键） ----------
    check(
        'snapshot 规范化为 v8 存储形态',
        stable(toStored(DEFAULT_FLAGS)) === stable({
            configVersion: 8,
            autoFill: { reasoning: true, context: true, image: true },
            allowUpdate: { reasoning: false, context: false, image: false },
            compat: { disableDeveloper: true, disableStore: true },
            excludes: [],
            efforts: {},
            userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
        }),
        toStored(DEFAULT_FLAGS),
    )
    check('snapshot 含 efforts', stable(toStored(WITH_EFFORTS).efforts) === stable({ 'z-ai': { 'glm-5.2': 'high' } }))
    check('snapshot 键名为 version-8', VERSION_KEY === 'version-8', VERSION_KEY)
    // 序列化产物与自身解码必须互逆（保存后立即读回不得变化）
    check('snapshot -> decode 往返一致', stable(decodeSection({ [VERSION_KEY]: toStored(WITH_EXCLUDES) })) === stable(WITH_EXCLUDES), toStored(WITH_EXCLUDES))
    // 带 efforts 的往返一致
    check('snapshot -> decode 往返含 efforts', stable(decodeSection({ [VERSION_KEY]: toStored(WITH_EFFORTS) })) === stable(WITH_EFFORTS))
    // 带 userExperience false 的往返一致（关掉记住推理级别的存取回路）
    const WITHOUT_REMEMBER: Flags = { ...ALL_ON, userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false } }
    check('snapshot -> decode 往返含 userExperience false', stable(decodeSection({ [VERSION_KEY]: toStored(WITHOUT_REMEMBER) })) === stable(WITHOUT_REMEMBER))
    // 带 defaultHigh false 的往返一致（默认已是 true，往返用例改守护显式关闭）
    const WITHOUT_DEFAULT_HIGH: Flags = { ...ALL_ON, userExperience: { rememberEfforts: true, defaultHigh: false, forgetRemoved: true, followParent: false, selfTune: false } }
    check('snapshot -> decode 往返含 defaultHigh false', stable(decodeSection({ [VERSION_KEY]: toStored(WITHOUT_DEFAULT_HIGH) })) === stable(WITHOUT_DEFAULT_HIGH))
    // 带 forgetRemoved false 的往返一致（关掉「忘记已删除模型」的存取回路）
    const WITHOUT_FORGET: Flags = { ...ALL_ON, userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: false, followParent: false, selfTune: false } }
    check('snapshot -> decode 往返含 forgetRemoved false', stable(decodeSection({ [VERSION_KEY]: toStored(WITHOUT_FORGET) })) === stable(WITHOUT_FORGET))
    // ---------- 组总控显示：全开才开，部分选中显示关（判据 every，与验证弹层分组「全选」同口径） ----------
    check('master 全开为开', masterValue(ALL_ON, 'autoFill') === true)
    check('master 全关为关', masterValue(DEFAULT_FLAGS, 'allowUpdate') === false)
    check('master 部分选中显示为关', masterValue(toggleCell(DEFAULT_FLAGS, 'autoFill', 'image'), 'autoFill') === false)
    // 部分选中点总控应「补全为开」而非抹掉已勾的行：点击值取 masterValue 的取反
    const mixedAutoFill = toggleCell(DEFAULT_FLAGS, 'autoFill', 'image')
    check(
        'master 部分选中点击后整组补全为开',
        stable(applyGroup(mixedAutoFill, 'autoFill', !masterValue(mixedAutoFill, 'autoFill')).autoFill)
            === stable({ reasoning: true, context: true, image: true }),
    )
    // compat 组多行：部分选中显示关，全开才显示开（与 userExperience 同一「全开」判据）
    check('master compat 行为开则为开', masterValue(ALL_ON, 'compat') === true)
    check('master compat 行为关则为关', masterValue({ ...ALL_ON, compat: { disableDeveloper: false, disableStore: false } }, 'compat') === false)
    // userExperience 组多行：部分选中显示关，三项全开才显示开
    check('master userExperience 部分选中显示为关', masterValue({ ...ALL_ON, userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: false, followParent: false, selfTune: false } }, 'userExperience') === false)
    check('master userExperience 仅两项为开仍为关', masterValue({ ...ALL_ON, userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false } }, 'userExperience') === false)
    check('master userExperience 全关则关', masterValue({ ...ALL_ON, userExperience: { rememberEfforts: false, defaultHigh: false, forgetRemoved: false, followParent: false, selfTune: false } }, 'userExperience') === false)
    check('master userExperience 全开则开', masterValue(ALL_ON, 'userExperience') === true)
    // ---------- 总控点击：整组同置取反值（只作用于布尔组，排除列表不得被牵连） ----------
    check(
        'applyGroup 整列置反（开->全关）',
        stable(applyGroup(ALL_ON, 'allowUpdate', false)) === stable({ ...ALL_ON, allowUpdate: { reasoning: false, context: false, image: false } }),
        applyGroup(ALL_ON, 'allowUpdate', false),
    )
    check(
        'applyGroup 混合列点击->全开（仅本组）',
        stable(applyGroup(toggleCell(DEFAULT_FLAGS, 'autoFill', 'context'), 'autoFill', true)) === stable({
            autoFill: { reasoning: true, context: true, image: true },
            allowUpdate: DEFAULT_FLAGS.allowUpdate,
            compat: DEFAULT_FLAGS.compat,
            excludes: DEFAULT_FLAGS.excludes,
            efforts: DEFAULT_FLAGS.efforts,
            userExperience: DEFAULT_FLAGS.userExperience,
        }),
    )
    check(
        'applyGroup compat 整组置关且不动其他组',
        stable(applyGroup(DEFAULT_FLAGS, 'compat', false)) === stable({ ...DEFAULT_FLAGS, compat: { disableDeveloper: false, disableStore: false } }),
        applyGroup(DEFAULT_FLAGS, 'compat', false),
    )
    // userExperience 组同样走总控/单格派生路径（多行组：总控整组同置）
    check(
        'applyGroup userExperience 整组置关',
        stable(applyGroup(DEFAULT_FLAGS, 'userExperience', false)) === stable({ ...DEFAULT_FLAGS, userExperience: { rememberEfforts: false, defaultHigh: false, forgetRemoved: false, followParent: false, selfTune: false } }),
    )
    check(
        'applyGroup userExperience 整组置开',
        stable(applyGroup({ ...ALL_ON, userExperience: { rememberEfforts: false, defaultHigh: false, forgetRemoved: false, followParent: false, selfTune: false } }, 'userExperience', true)) === stable(ALL_ON),
    )
    check('applyGroup 不改入参', DEFAULT_FLAGS.autoFill.reasoning === true && DEFAULT_FLAGS.compat.disableDeveloper === true)
    // ---------- 单格翻转不改其他格、不改入参 ----------
    const flipped = toggleCell(DEFAULT_FLAGS, 'allowUpdate', 'context')
    check('toggleCell 仅翻转目标格', flipped.allowUpdate.context === true && flipped.allowUpdate.reasoning === false && flipped.autoFill === DEFAULT_FLAGS.autoFill)
    check('toggleCell 不改入参', DEFAULT_FLAGS.allowUpdate.context === false)
    check('toggleCell compat 仅翻转该行', stable(toggleCell(DEFAULT_FLAGS, 'compat', 'disableDeveloper').compat) === stable({ disableDeveloper: false, disableStore: true }))
    check('toggleCell userExperience 仅翻转 defaultHigh 不动其余行', stable(toggleCell(DEFAULT_FLAGS, 'userExperience', 'defaultHigh').userExperience) === stable({ rememberEfforts: true, defaultHigh: false, forgetRemoved: true, followParent: false, selfTune: false }))
    check('toggleCell userExperience 仅翻转 forgetRemoved 不动其余行', stable(toggleCell(DEFAULT_FLAGS, 'userExperience', 'forgetRemoved').userExperience) === stable({ rememberEfforts: true, defaultHigh: true, forgetRemoved: false, followParent: false, selfTune: false }))
    check('groupValue 按组取行值', groupValue(DEFAULT_FLAGS, 'compat', 'disableDeveloper') === true && groupValue(DEFAULT_FLAGS, 'allowUpdate', 'image') === false)
    // ---------- 排除项 id 合法性（与宿主 provider route id 同一规则） ----------
    for (const ok of ['acme-gateway', 'a', 'a1', 'openai-compatible', 'lab-7']) {
        check(`排除项 id 合法 ${ok}`, EXCLUDE_ID_PATTERN.test(ok) === true, ok)
    }
    for (const bad of ['Acme', 'acme_gateway', '-acme', 'acme-', 'acme--b', '1acme', '', 'acme gateway', 'acme/', 'acme-gateway ']) {
        check(`排除项 id 非法 ${JSON.stringify(bad)}`, EXCLUDE_ID_PATTERN.test(bad) === false, bad)
    }
    // ---------- providerIdsOf：与 Node 半 fix 同源的 user 层取键 ----------
    check('providerIdsOf 取 user.providers 键', stable(providerIdsOf({ providers: { 'acme-gateway': {}, 'lab-7': {} } })) === stable(['acme-gateway', 'lab-7']), providerIdsOf({ providers: { 'acme-gateway': {}, 'lab-7': {} } }))
    for (const junk of [undefined, null, 42, 'x', [], {}, { providers: 'x' }, { providers: [] }, { providers: null }]) {
        check(`providerIdsOf 垃圾输入返回空 ${stable(junk)}`, providerIdsOf(junk).length === 0, junk)
    }
    // ---------- 命中判定：只看交集，顺序沿用排除列表本身的顺序 ----------
    check('resolveHits 只收命中的排除项', stable([...resolveHits(WITH_EXCLUDES.excludes, ['acme-gateway', 'other'])]) === stable(['acme-gateway']))
    check('resolveHits 全不命中为空集', resolveHits(WITH_EXCLUDES.excludes, ['nothing']).size === 0)
    check('resolveHits 提供方多于排除项时不计入提供方', resolveHits(['a'], ['a', 'b', 'c']).size === 1)
    check('resolveHits 空排除列表恒空', resolveHits([], ['a']).size === 0)
    // ---------- 增删：只追加/原位删除，不改入参，重复与不存在均为幂等空操作 ----------
    const added = addExclude(DEFAULT_FLAGS, 'acme-gateway')
    check('addExclude 追加到末尾', stable(added.excludes) === stable(['acme-gateway']), added)
    check('addExclude 不改入参与其他组', DEFAULT_FLAGS.excludes.length === 0 && added.autoFill === DEFAULT_FLAGS.autoFill)
    check('addExclude 重复 id 返回同一对象', addExclude(added, 'acme-gateway') === added)
    const withTwo = addExclude(added, 'lab-7')
    check('removeExclude 仅删目标项', stable(removeExclude(withTwo, 'acme-gateway').excludes) === stable(['lab-7']), removeExclude(withTwo, 'acme-gateway'))
    check('removeExclude 不改入参', stable(withTwo.excludes) === stable(['acme-gateway', 'lab-7']))
    check('removeExclude 不存在的 id 返回同一对象', removeExclude(withTwo, 'ghost') === withTwo)
    // ---------- 脏检测 ----------
    check('isDirty 相同值不为脏', isDirty(DEFAULT_FLAGS, DEFAULT_FLAGS) === false)
    check('isDirty 单格不同即为脏', isDirty(toggleCell(DEFAULT_FLAGS, 'autoFill', 'image'), DEFAULT_FLAGS) === true)
    // compat 行的改动同样要标脏，否则「关闭即移除」的写回没有 UI 入口
    check('isDirty compat 不同即为脏', isDirty({ ...DEFAULT_FLAGS, compat: { disableDeveloper: false, disableStore: false } }, DEFAULT_FLAGS) === true)
    check('isDirty compat 相同不为脏', isDirty({ ...DEFAULT_FLAGS, compat: { ...DEFAULT_FLAGS.compat } }, DEFAULT_FLAGS) === false)
    // 排除列表的增删都必须标脏（否则排除没有保存入口），内容相同则不脏
    check('isDirty 新增排除项为脏', isDirty(added, DEFAULT_FLAGS) === true)
    check('isDirty 删除排除项为脏', isDirty(DEFAULT_FLAGS, withTwo) === true)
    check('isDirty 排除列表等值不为脏', isDirty(withTwo, { ...withTwo, excludes: ['acme-gateway', 'lab-7'] }) === false)
    // 顺序敏感是有意取舍：草稿只由已存值经增删派生，故不存在"换顺序即脏"的误报路径
    check('isDirty 排除列表换序视为脏', isDirty({ ...withTwo, excludes: ['lab-7', 'acme-gateway'] }, withTwo) === true)
    // userExperience 是用户配置（区别于 efforts 记忆）：改动要标脏，等值不脏
    check('isDirty userExperience rememberEfforts 不同即为脏', isDirty({ ...DEFAULT_FLAGS, userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false } }, DEFAULT_FLAGS) === true)
    check('isDirty userExperience forgetRemoved 不同即为脏', isDirty({ ...DEFAULT_FLAGS, userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: false, followParent: false, selfTune: false } }, DEFAULT_FLAGS) === true)
    check('isDirty userExperience defaultHigh 不同即为脏', isDirty({ ...DEFAULT_FLAGS, userExperience: { rememberEfforts: true, defaultHigh: false, forgetRemoved: true, followParent: false, selfTune: false } }, DEFAULT_FLAGS) === true)
    check('isDirty userExperience 等值不为脏', isDirty({ ...DEFAULT_FLAGS, userExperience: { ...DEFAULT_FLAGS.userExperience } }, DEFAULT_FLAGS) === false)
    // efforts 的变化不标脏（运行时记忆，非用户配置，不应触发"未保存更改"）
    check('isDirty efforts 变化不标脏', isDirty({ ...DEFAULT_FLAGS, efforts: { a: { m: 'high' } } }, DEFAULT_FLAGS) === false)
    // followParent 是「用户体验」组的一行，随 GROUPS 遍历一并比较
    check('isDirty userExperience.followParent 不同即为脏', isDirty({ ...DEFAULT_FLAGS, userExperience: { ...DEFAULT_FLAGS.userExperience, followParent: true } }, DEFAULT_FLAGS) === true)
    // ---------- 验证候选：与 providerIdsOf 同源，档位取 reasoningEfforts 的键并按 EFFORT_LEVELS 归一 ----------
    const verifyUser = {
        providers: {
            'acme-gateway': { models: [
                // 配置里的键序是 high → off → low，归一后应按规范次序 off → low → high
                { id: 'z-ai/glm-5', reasoningEfforts: { high: 'high', off: null, low: 'low' }, contextWindow: 200_000 },
                { id: 'no-efforts' },
                // 无 id 的行跳过
                { reasoningEfforts: { low: 'low' } },
            ] },
            'lab-7': { models: [{ id: 'only-one', reasoningEfforts: { medium: 'medium' } }] },
            // 无 models 数组的提供方不产出候选
            'empty-provider': { api: 'openai-completions' },
        },
    }
    check(
        'verifyCandidatesOf 逐提供方逐模型拍出候选并归一档位序',
        stable(verifyCandidatesOf(verifyUser)) === stable([
            { provider: 'acme-gateway', model: 'z-ai/glm-5', efforts: ['off', 'low', 'high'] },
            { provider: 'acme-gateway', model: 'no-efforts', efforts: [] },
            { provider: 'lab-7', model: 'only-one', efforts: ['medium'] },
        ]),
        verifyCandidatesOf(verifyUser),
    )
    check('verifyCandidatesOf 丢弃未知档位键', stable(verifyCandidatesOf({ providers: { p: { models: [{ id: 'm', reasoningEfforts: { low: 'low', turbo: 'turbo' } }] } } })) === stable([{ provider: 'p', model: 'm', efforts: ['low'] }]))
    check('verifyCandidatesOf reasoningEfforts 非对象视作无档位', stable(verifyCandidatesOf({ providers: { p: { models: [{ id: 'm', reasoningEfforts: ['low'] }] } } })) === stable([{ provider: 'p', model: 'm', efforts: [] }]))
    for (const junk of [undefined, null, 42, 'x', [], {}, { providers: 'x' }, { providers: [] }, { providers: { p: 'x' } }, { providers: { p: { models: {} } } }]) {
        check(`verifyCandidatesOf 垃圾输入返回空 ${stable(junk)}`, verifyCandidatesOf(junk).length === 0, junk)
    }
    // ---------- 选择键：模型 id 含 '/' 也不能与拼接方案撞车 ----------
    check('verifyKey 二元组序列化', verifyKey('a', 'x/y') === '["a","x/y"]')
    check('verifyKey 不同提供方的同名模型互不相同', verifyKey('a', 'm') !== verifyKey('b', 'm'))
    // ---------- 校验目标：只取勾选项；开档位逐个验全部声明档位，关档位一律不发档位参数；
    // needTest 只在「确实有档位要验」时为真——那时那一次不带档位的请求才是探测对照，否则它自己就是被验对象 ----------
    const candidates = verifyCandidatesOf(verifyUser)
    const keys = new Set([verifyKey('acme-gateway', 'z-ai/glm-5'), verifyKey('acme-gateway', 'no-efforts')])
    check(
        'verifyTargets 关档位时一律不带档位（不是挑最低档），且无须探测',
        stable(verifyTargets(candidates, keys, false)) === stable([
            { provider: 'acme-gateway', model: 'z-ai/glm-5', efforts: [], needTest: false },
            { provider: 'acme-gateway', model: 'no-efforts', efforts: [], needTest: false },
        ]),
        verifyTargets(candidates, keys, false),
    )
    check(
        'verifyTargets 开档位时取全部声明档位；无档位模型与关档位同形（那一次请求即被验对象）',
        stable(verifyTargets(candidates, keys, true)) === stable([
            { provider: 'acme-gateway', model: 'z-ai/glm-5', efforts: ['off', 'low', 'high'], needTest: true },
            { provider: 'acme-gateway', model: 'no-efforts', efforts: [], needTest: false },
        ]),
        verifyTargets(candidates, keys, true),
    )
    check('verifyTargets 未勾选得空', verifyTargets(candidates, new Set(), true).length === 0)
    check('verifyTargets 不改入参候选', stable(candidates[0].efforts) === stable(['off', 'low', 'high']))
    // ---------- 分组全选：文案判据与点击方向同走 groupAllPicked（every 而非 any） ----------
    const acmeGroup = candidates.slice(0, 2)
    const acmeKeyA = verifyKey('acme-gateway', 'z-ai/glm-5')
    const acmeKeyB = verifyKey('acme-gateway', 'no-efforts')
    const labKey = verifyKey('lab-7', 'only-one')
    check('groupAllPicked 全不选为否', groupAllPicked(new Set<string>(), acmeGroup) === false)
    check('groupAllPicked 全选为真', groupAllPicked(new Set([acmeKeyA, acmeKeyB]), acmeGroup) === true)
    // 部分选中仍为否：若取 any 这里会误判为真，点击方向就会与文案（此时显示「全选」）相反
    check('groupAllPicked 部分选中为否', groupAllPicked(new Set([acmeKeyA]), acmeGroup) === false)
    check('groupAllPicked 他组已选不影响本组', groupAllPicked(new Set([labKey]), acmeGroup) === false)
    check(
        'toggleGroupPicks 全不选 -> 整组选上',
        stable([...toggleGroupPicks(new Set<string>(), acmeGroup)]) === stable([acmeKeyA, acmeKeyB]),
        [...toggleGroupPicks(new Set<string>(), acmeGroup)],
    )
    check('toggleGroupPicks 全选 -> 整组取消', toggleGroupPicks(new Set([acmeKeyA, acmeKeyB]), acmeGroup).size === 0)
    // 部分选中应「补全为全选」而非抹掉已勾的，且不得牵连他组
    const partial = new Set([acmeKeyA, labKey])
    const completed = toggleGroupPicks(partial, acmeGroup)
    check(
        'toggleGroupPicks 部分选中 -> 补全为全选且保留他组',
        stable([...completed]) === stable([acmeKeyA, labKey, acmeKeyB]),
        [...completed],
    )
    check('toggleGroupPicks 不改入参', partial.size === 2 && !partial.has(acmeKeyB))
    // ---------- 探测式填充候选：与验证候选同源同形，只按两个开关收窄 ----------
    const probeUser = {
        providers: {
            // 三种档位形态：无声明（未填充）、只有 off（同样算未填充）、有其它档位（已填充）
            acme: { models: [{ id: 'none' }, { id: 'off-only', reasoningEfforts: { off: null } }, { id: 'full', reasoningEfforts: { low: 'low' } }] },
            lab: { models: [{ id: 'lab-none' }] },
        },
    }
    const pick = (excludes: readonly string[], ignoreExcludes: boolean, unfilledOnly: boolean) =>
        probeCandidatesOf(probeUser, { excludes, ignoreExcludes, unfilledOnly })
    check(
        'probeCandidatesOf 探测所有：收全部模型（两个开关关）',
        stable(pick([], false, false)) === stable([
            { provider: 'acme', model: 'none', efforts: [] },
            { provider: 'acme', model: 'off-only', efforts: ['off'] },
            { provider: 'acme', model: 'full', efforts: ['low'] },
            { provider: 'lab', model: 'lab-none', efforts: [] },
        ]),
        pick([], false, false),
    )
    check(
        'probeCandidatesOf 探测未填充：无档位声明与只有 off 都算未填充，有其它档位的不算',
        stable(pick([], false, true)) === stable([
            { provider: 'acme', model: 'none', efforts: [] },
            { provider: 'acme', model: 'off-only', efforts: ['off'] },
            { provider: 'lab', model: 'lab-none', efforts: [] },
        ]),
        pick([], false, true),
    )
    check(
        'probeCandidatesOf 默认跳过排除命中的提供方',
        stable(pick(['lab'], false, false).map((c) => `${c.provider}/${c.model}`)) === stable(['acme/none', 'acme/off-only', 'acme/full']),
        pick(['lab'], false, false),
    )
    check(
        'probeCandidatesOf 忽略排除：被排除的提供方也收进来（同一开关同时管 Node 半的两次写回）',
        stable(pick(['lab'], true, true).map((c) => `${c.provider}/${c.model}`)) === stable(['acme/none', 'acme/off-only', 'lab/lab-none']),
        pick(['lab'], true, true),
    )
    check('probeCandidatesOf 垃圾输入返回空', probeCandidatesOf(undefined, { excludes: [], ignoreExcludes: false, unfilledOnly: false }).length === 0)
    check(
        'probeTargetsOf 逐模型展开全部七档且 needTest 恒假（预声明本身就是那次对照）',
        stable(probeTargetsOf(pick([], false, true)).map((t) => t.efforts)) === stable([
            [...EFFORT_LEVELS],
            [...EFFORT_LEVELS],
            [...EFFORT_LEVELS],
        ]) && probeTargetsOf(pick([], false, true)).every((t) => t.needTest === false),
        probeTargetsOf(pick([], false, true)).map((t) => t.efforts),
    )
    check('probeTargetsOf 空候选得空', probeTargetsOf([]).length === 0)
}
