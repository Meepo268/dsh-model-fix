// migrate.ts 纯函数测试：DEFAULT_STORED / toStored / 规范化重写的语义不变性 / pruneOps 清理规则 / canonicalizeCurrentOp 规范化 / excludes 去重 op
import { DEFAULT_STORED, canonicalizeCurrentOp, dedupeExcludesOp, pruneOps } from '@/migrate'
import { resolveConfig } from '@/config'
import { parseEfforts, toStored, versionKey } from '@/shared/parse'
import { CONFIG_VERSION } from '@/shared/constants'
import { check, stable } from '@test/helper'

/** 执行本文件的全部用例 */
export function run(): void {
    // 当前版本默认值（台阶侧的逐级升级语义见 test/upgrade.test.ts）
    const COMPAT = { disableDeveloper: true, disableStore: true }
    const EXCLUDES: string[] = []
    const EFFORTS: Record<string, Record<string, string>> = {}
    const USER_EXPERIENCE = { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false }

    // toStored：运行时配置 -> 当前版本快照（自愈重写与全新用户直写的唯一构造口）
    check('toStored 补 configVersion 且含三组布尔与排除列表与 efforts 与 userExperience（含 defaultHigh 与 forgetRemoved 与 followParent 与 selfTune）', stable(toStored({
        autoFill: { reasoning: false, context: true, image: false },
        allowUpdate: { reasoning: true, context: false, image: true },
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['acme-gateway'],
        efforts: { 'z-ai': { 'glm-5.2': 'high' } },
        userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: false, followParent: true, selfTune: false },
    })) === stable({
        configVersion: 8,
        autoFill: { reasoning: false, context: true, image: false },
        allowUpdate: { reasoning: true, context: false, image: true },
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['acme-gateway'],
        efforts: { 'z-ai': { 'glm-5.2': 'high' } },
        userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: false, followParent: true, selfTune: false },
    }), toStored({ autoFill: { reasoning: false, context: true, image: false }, allowUpdate: { reasoning: true, context: false, image: true }, compat: { disableDeveloper: false, disableStore: true }, excludes: ['acme-gateway'], efforts: { 'z-ai': { 'glm-5.2': 'high' } }, userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: false, followParent: true, selfTune: false } }))
    check('DEFAULT_STORED 即 toStored(默认配置)', stable(DEFAULT_STORED) === stable(toStored({
        autoFill: { reasoning: true, context: true, image: true },
        allowUpdate: { reasoning: false, context: false, image: false },
        compat: { disableDeveloper: true, disableStore: true },
        excludes: [],
        efforts: {},
        userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
    })), DEFAULT_STORED)
    check('DEFAULT_STORED 的 configVersion 为当前版本', DEFAULT_STORED.configVersion === CONFIG_VERSION, DEFAULT_STORED)

    // 自愈重写（migrateConfig 中当前版本快照非法时的动作）：重写目标取「当前生效值」，故重写前后
    // 行为必须一致；有可用旧快照时沿用其语义，绝不把段内仍可用的快照静默抹成默认
    const brokenV7WithV5 = {
        'version-7': { autoFill: 'garbage' },
        'version-5': { configVersion: 5, autoFill: { reasoning: false, context: false, image: true }, allowUpdate: { reasoning: true, context: true, image: false }, compat: { disableDeveloper: false }, excludes: ['x'], efforts: { 'z-ai': { 'glm-5.2': 'high' } }, userExperience: { rememberEfforts: false } },
    }
    const healed = { 'version-7': toStored(resolveConfig(brokenV7WithV5)) }
    check('自愈后生效配置不变', stable(resolveConfig(healed)) === stable(resolveConfig(brokenV7WithV5)), { healed, before: resolveConfig(brokenV7WithV5) })
    check('自愈沿用可用旧快照语义（未落默认，保留 efforts 记忆与 userExperience 现值并补 defaultHigh / forgetRemoved）', stable(resolveConfig(healed)) === stable({
        autoFill: { reasoning: false, context: false, image: true },
        allowUpdate: { reasoning: true, context: true, image: false },
        compat: { disableDeveloper: false, disableStore: true },
        excludes: ['x'],
        efforts: { 'z-ai': { 'glm-5.2': 'high' } },
        userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false },
    }), resolveConfig(healed))
    // 无任何可用快照时自愈为默认（回退语义：不静默保留坏值；更高版本垃圾快照同样不计）
    const allBroken = { 'version-7': 42, 'version-9': 42 }
    check('无任何可用快照时自愈为默认', stable(resolveConfig({ 'version-7': toStored(resolveConfig(allBroken)) })) === stable(resolveConfig(allBroken)), resolveConfig(allBroken))
    // 当前版本键非法但段内有可用更高版本快照：自愈沿用高版本降级解析的当前生效值（而非落默认）
    const v9Valid = { 'version-7': 42, 'version-9': { autoFill: { reasoning: false, context: false, image: false } } }
    check('版本键非法时自愈用更高版本降级值', stable(resolveConfig({ 'version-7': toStored(resolveConfig(v9Valid)) })) === stable({
        autoFill: { reasoning: false, context: false, image: false },
        allowUpdate: { reasoning: false, context: false, image: false },
        compat: COMPAT,
        excludes: EXCLUDES,
        efforts: EFFORTS,
        userExperience: USER_EXPERIENCE,
    }), resolveConfig({ 'version-7': toStored(resolveConfig(v9Valid)) }))

    // parseEfforts：宽松解析（结构不符回落 {}，不判整段快照非法）
    check('parseEfforts 正常嵌套', stable(parseEfforts({ 'z-ai': { 'glm-5.2': 'high' } })) === stable({ 'z-ai': { 'glm-5.2': 'high' } }))
    check('parseEfforts 非对象回落空', stable(parseEfforts('bad')) === stable({}) && stable(parseEfforts(null)) === stable({}) && stable(parseEfforts(undefined)) === stable({}))
    check('parseEfforts 内层非对象跳过', stable(parseEfforts({ a: 'bad' })) === stable({}))
    check('parseEfforts 非字符串级别跳过', stable(parseEfforts({ a: { m: 42 } })) === stable({}))
    check('parseEfforts 混合保留合法', stable(parseEfforts({ a: { m: 'high', bad: 42 } })) === stable({ a: { m: 'high' } }))

    // pruneOps：两阶段清理——先淘汰低于最低支持版本（Phase A），再淘汰低于当前版本且超出保留上限的 excess（Phase B）；
    // 等于/高于当前版本永不清理
    check('当前与高版本不参与清理', pruneOps([7, 8, 9, 10]).length === 0, pruneOps([7, 8, 9, 10]))
    check('低于最低支持版本的快照由 Phase A 清理', stable(pruneOps([1, 2, 3, 4, 5, 6])) === stable([
        { op: 'unset', path: ['version-1'] }, { op: 'unset', path: ['version-2'] }, { op: 'unset', path: ['version-3'] }, { op: 'unset', path: ['version-4'] }, { op: 'unset', path: ['version-5'] },
    ]), pruneOps([1, 2, 3, 4, 5, 6]))
    check('olds 超限淘汰最低（<=当前版本共保留 2 个）', stable(pruneOps([3, 4, 5, 6])) === stable([
        { op: 'unset', path: ['version-3'] }, { op: 'unset', path: ['version-4'] }, { op: 'unset', path: ['version-5'] },
    ]), pruneOps([3, 4, 5, 6]))
    check('olds 未超限不清理', pruneOps([3]).length === 0, pruneOps([3]))
    check('Phase A 清理低于最低支持版本', stable(pruneOps([1, 2, 3, 4], 6, 4, 3)) === stable([
        { op: 'unset', path: ['version-1'] }, { op: 'unset', path: ['version-2'] }, { op: 'unset', path: ['version-3'] },
    ]), pruneOps([1, 2, 3, 4], 6, 4, 3))
    check('Phase B 超限淘汰最低', stable(pruneOps([1, 2, 3, 4], 5, 0, 3)) === stable([
        { op: 'unset', path: ['version-1'] },
    ]), pruneOps([1, 2, 3, 4], 5, 0, 3))
    check('两阶段叠加（A 先于 B）', stable(pruneOps([1, 2, 3, 4, 5, 6], 8, 4, 3)) === stable([
        { op: 'unset', path: ['version-1'] }, { op: 'unset', path: ['version-2'] }, { op: 'unset', path: ['version-3'] },
    ]), pruneOps([1, 2, 3, 4, 5, 6], 8, 4, 3))

    // canonicalizeCurrentOp：当前版本快照规范化——以当前生效值物化规范完整快照（resolveConfig → toStored），与盘上当前版本键不一致才产出 op
    const CURRENT = versionKey(CONFIG_VERSION)
    // 残缺当前版本键（只有 efforts）→ parseSnapshot 补默认判为合法，但与规范完整快照不一致 → 重写（补四组默认 + configVersion，保留 efforts 记忆）
    check('残缺当前版本键（只有 efforts）被规范化重写且保留记忆', stable(canonicalizeCurrentOp({ [CURRENT]: { efforts: { 'z-ai': { 'glm-5.2': 'high' } } } })) === stable([{ op: 'set', path: [CURRENT], value: { ...DEFAULT_STORED, efforts: { 'z-ai': { 'glm-5.2': 'high' } } } }]), canonicalizeCurrentOp({ [CURRENT]: { efforts: { 'z-ai': { 'glm-5.2': 'high' } } } }))
    // 残缺当前版本键（只有 excludes）→ 同理重写，保留 excludes 现值
    check('残缺当前版本键（只有 excludes）被规范化重写且保留 excludes', stable(canonicalizeCurrentOp({ [CURRENT]: { excludes: ['acme-gateway'] } })) === stable([{ op: 'set', path: [CURRENT], value: { ...DEFAULT_STORED, excludes: ['acme-gateway'] } }]), canonicalizeCurrentOp({ [CURRENT]: { excludes: ['acme-gateway'] } }))
    // 残缺当前版本键同时保留 efforts 与 excludes，并补齐四组默认
    check('残缺当前版本键同时保留 efforts 与 excludes 并补四组默认', stable(canonicalizeCurrentOp({ [CURRENT]: { efforts: { 'z-ai': { 'glm-5.2': 'high' } }, excludes: ['acme-gateway'] } })) === stable([{ op: 'set', path: [CURRENT], value: { ...DEFAULT_STORED, efforts: { 'z-ai': { 'glm-5.2': 'high' } }, excludes: ['acme-gateway'] } }]), canonicalizeCurrentOp({ [CURRENT]: { efforts: { 'z-ai': { 'glm-5.2': 'high' } }, excludes: ['acme-gateway'] } }))
    // 非法当前版本键（非对象）→ resolveConfig 无其他可用快照时回落默认，重写为 DEFAULT_STORED
    check('非法当前版本键（非对象）按默认重写', stable(canonicalizeCurrentOp({ [CURRENT]: 42 })) === stable([{ op: 'set', path: [CURRENT], value: DEFAULT_STORED }]), canonicalizeCurrentOp({ [CURRENT]: 42 }))
    // 非法当前版本键但段内有可用更高版本 → 沿用高版本降级值重写（不落默认，保留语义）
    check('非法当前版本键段内有高版本则沿用降级值重写', stable(canonicalizeCurrentOp({ [CURRENT]: 42, 'version-9': { autoFill: { reasoning: false, context: false, image: false } } })) === stable([{ op: 'set', path: [CURRENT], value: toStored(resolveConfig({ [CURRENT]: 42, 'version-9': { autoFill: { reasoning: false, context: false, image: false } } })) }]), canonicalizeCurrentOp({ [CURRENT]: 42, 'version-9': { autoFill: { reasoning: false, context: false, image: false } } }))
    // 规范完整当前版本键 → 零 op（幂等：重写后第二轮同值不产出）
    check('规范完整当前版本键零 op', canonicalizeCurrentOp({ [CURRENT]: DEFAULT_STORED }).length === 0, canonicalizeCurrentOp({ [CURRENT]: DEFAULT_STORED }))
    // 规范完整但含多余键 → 物化时 toStored 剥离未知键，比对不一致即重写
    check('当前版本键含多余键被规范化剥离', stable(canonicalizeCurrentOp({ [CURRENT]: { ...DEFAULT_STORED, extra: 'x', unknown: 1 } })) === stable([{ op: 'set', path: [CURRENT], value: DEFAULT_STORED }]), canonicalizeCurrentOp({ [CURRENT]: { ...DEFAULT_STORED, extra: 'x', unknown: 1 } }))
    // 用户改过四组布尔且完整 → 与规范物化结果一致（同值不同键序/引用），零 op（不误伤合法自定义配置）
    const customFull = { ...DEFAULT_STORED, autoFill: { reasoning: false, context: false, image: false }, allowUpdate: { reasoning: true, context: true, image: true }, compat: { disableDeveloper: false, disableStore: false }, userExperience: { rememberEfforts: false, defaultHigh: true, forgetRemoved: false, followParent: false, selfTune: false } }
    check('合法自定义完整当前版本键零 op（不误伤）', canonicalizeCurrentOp({ [CURRENT]: customFull }).length === 0, canonicalizeCurrentOp({ [CURRENT]: customFull }))
    // 当前版本键不存在 → 零 op（交给迁移分支）
    check('无当前版本键零 op', canonicalizeCurrentOp({ 'version-5': { ...DEFAULT_STORED, configVersion: 5 } }).length === 0, canonicalizeCurrentOp({ 'version-5': { ...DEFAULT_STORED, configVersion: 5 } }))
    // 空段 / undefined → 零 op
    check('空段零 op', canonicalizeCurrentOp({}).length === 0 && canonicalizeCurrentOp(undefined).length === 0)

    // dedupeExcludesOp：excludes 的手写重复自愈——只有经 Set 收窄后变短（有重复）才产出定向写回 op，
    // 保留首次出现；无重复/垃圾输入一律零 op（这是 onChange 自愈的终止条件，防反馈循环）
    check('dedupe 有重复才产出 op 且保留首次出现', stable(dedupeExcludesOp({ excludes: ['a', 'b', 'a'] })) === stable([
        { op: 'set', path: [versionKey(CONFIG_VERSION), 'excludes'], value: ['a', 'b'] },
    ]), dedupeExcludesOp({ excludes: ['a', 'b', 'a'] }))
    check('dedupe 无重复返回空（收敛保证）', dedupeExcludesOp({ excludes: ['a', 'b'] }).length === 0)
    check('dedupe 空列表返回空', dedupeExcludesOp({ excludes: [] }).length === 0)
    check('dedupe 缺 excludes 返回空', dedupeExcludesOp({ autoFill: {} }).length === 0)
    check('dedupe 非数组返回空', dedupeExcludesOp({ excludes: 'a' }).length === 0)
    check('dedupe 含非字符串元素整段非法返回空（parseSnapshot 整段回退口径，不洗半合法段）', dedupeExcludesOp({ excludes: ['a', 1, 'a'] }).length === 0 && dedupeExcludesOp({ excludes: [null] }).length === 0)
    check('dedupe 非纯对象返回空', dedupeExcludesOp('garbage').length === 0 && dedupeExcludesOp(undefined).length === 0)
}
