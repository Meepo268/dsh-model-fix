// effort.ts 纯逻辑测试：lookupEffort / applyEffort / advertisesEffort / classifyTransition / sameSelection
// （记忆的失效清理不在浏览器半，见 test/memory.test.ts）
import { check, stable } from '@test/helper'
import {
    advertisesEffort,
    applyEffort,
    classifyTransition,
    lookupEffort,
    sameSelection,
} from '@/client/effort'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import type { EffortMemory } from '@/shared/types'

export function run(): void {
    // ---------- lookupEffort ----------
    check('lookupEffort 命中', lookupEffort({ a: { m: 'high' } }, 'a', 'm') === 'high')
    check('lookupEffort 未命中返回 undefined', lookupEffort({ a: { m: 'high' } }, 'a', 'x') === undefined)
    check('lookupEffort provider 未命中', lookupEffort({ a: { m: 'high' } }, 'b', 'm') === undefined)
    check('lookupEffort 空记忆', lookupEffort({}, 'a', 'm') === undefined)

    // ---------- applyEffort ----------
    check('applyEffort 新增模型记忆', stable(applyEffort({}, 'a', 'm', 'high')) === stable({ a: { m: 'high' } }))
    check('applyEffort 覆盖同模型', stable(applyEffort({ a: { m: 'low' } }, 'a', 'm', 'high')) === stable({ a: { m: 'high' } }))
    check('applyEffort 保留其他模型与提供方', stable(applyEffort({ a: { m1: 'low' }, b: { m2: 'max' } }, 'a', 'm3', 'high')) === stable({ a: { m1: 'low', m3: 'high' }, b: { m2: 'max' } }))
    check('applyEffort 清除仅剩的模型则折叠整个提供方', stable(applyEffort({ a: { m: 'high' } }, 'a', 'm', null)) === stable({}))
    check('applyEffort 清除多模型之一保留其余', stable(applyEffort({ a: { m1: 'low', m2: 'high' } }, 'a', 'm1', null)) === stable({ a: { m2: 'high' } }))
    check('applyEffort 清除不存在的记忆为空操作', stable(applyEffort({ a: { m: 'high' } }, 'a', 'ghost', null)) === stable({ a: { m: 'high' } }))
    check('applyEffort 清除不存在的提供方为空操作', stable(applyEffort({ a: { m: 'high' } }, 'z', 'm', null)) === stable({ a: { m: 'high' } }))
    // 不改入参：写入结果与入参不共享嵌套对象（否则 scope 快照会被就地改写）
    const before = { a: { m: 'low' } }
    const after = applyEffort(before, 'a', 'm', 'high')
    check('applyEffort 不改入参', stable(before) === stable({ a: { m: 'low' } }) && after.a !== before.a)

    // ---------- advertisesEffort ----------
    const groups: ModelProviderGroup[] = [
        { id: 'a', name: 'a', models: [{ id: 'm1', name: 'm1', reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }] } }] },
        { id: 'b', name: 'b', models: [{ id: 'm2', name: 'm2' }] },
    ]
    check('advertisesEffort 命中', advertisesEffort(groups, 'a', 'm1', 'high') === true)
    check('advertisesEffort 不公告', advertisesEffort(groups, 'a', 'm1', 'xhigh') === false)
    check('advertisesEffort provider 不存在', advertisesEffort(groups, 'z', 'm', 'high') === false)
    check('advertisesEffort model 不存在', advertisesEffort(groups, 'a', 'zz', 'high') === false)
    check('advertisesEffort 模型无 reasoning', advertisesEffort(groups, 'b', 'm2', 'high') === false)

    // ---------- sameSelection ----------
    check('sameSelection 相同', sameSelection({ provider: 'a', model: 'm' }, { provider: 'a', model: 'm' }) === true)
    check('sameSelection 级别不同', sameSelection({ provider: 'a', model: 'm', reasoningEffort: 'low' }, { provider: 'a', model: 'm', reasoningEffort: 'high' }) === false)
    check('sameSelection 级别缺失 vs 存在', sameSelection({ provider: 'a', model: 'm' }, { provider: 'a', model: 'm', reasoningEffort: 'low' }) === false)
    check('sameSelection provider 不同', sameSelection({ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }) === false)
    check('sameSelection model 不同', sameSelection({ provider: 'a', model: 'm1' }, { provider: 'a', model: 'm2' }) === false)

    // ---------- classifyTransition ----------
    const memory: EffortMemory = { a: { m1: 'high', m2: 'low' } }
    const groupsWithM1: ModelProviderGroup[] = [
        { id: 'a', name: 'a', models: [
            { id: 'm1', name: 'm1', reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }] } },
            { id: 'm2', name: 'm2', reasoning: { efforts: [{ id: 'low', name: 'low' }] } },
        ] },
    ]
    // defaultHigh 关闭的用例段（defaultHigh 专段另用 DH_ON）
    const DH_OFF = false

    check('classify 模型变化改写记忆', stable(classifyTransition(
        { provider: 'b', model: 'x' },
        { provider: 'a', model: 'm1', reasoningEffort: 'low' },
        memory,
        groupsWithM1,
        DH_OFF,
    )) === stable({ kind: 'model-change', resolved: { provider: 'a', model: 'm1', reasoningEffort: 'high' } }))

    // 模型变化：有记忆但与当前相同 → 不改写（resolved 即 next 本身）
    check('classify 模型变化记忆相同不改写', stable(classifyTransition(
        { provider: 'b', model: 'x' },
        { provider: 'a', model: 'm1', reasoningEffort: 'high' },
        memory,
        groupsWithM1,
        DH_OFF,
    )) === stable({ kind: 'model-change', resolved: { provider: 'a', model: 'm1', reasoningEffort: 'high' } }))

    check('classify 模型变化无记忆不改写', stable(classifyTransition(
        { provider: 'b', model: 'x' },
        { provider: 'a', model: 'm3', reasoningEffort: 'low' },
        memory,
        groupsWithM1,
        DH_OFF,
    )) === stable({ kind: 'model-change', resolved: { provider: 'a', model: 'm3', reasoningEffort: 'low' } }))

    // 模型变化：记忆不受支持（m2 只公告 low，记忆是 high）→ 不改写
    check('classify 模型变化记忆不受支持不改写', stable(classifyTransition(
        { provider: 'b', model: 'x' },
        { provider: 'a', model: 'm2', reasoningEffort: 'low' },
        { a: { m2: 'high' } },
        groupsWithM1,
        DH_OFF,
    )) === stable({ kind: 'model-change', resolved: { provider: 'a', model: 'm2', reasoningEffort: 'low' } }))

    check('classify 模型变化 provider 存在但 model 不在 groups 不改写', stable(classifyTransition(
        { provider: 'b', model: 'x' },
        { provider: 'a', model: 'm9', reasoningEffort: 'low' },
        { a: { m9: 'xhigh' } },
        groupsWithM1,
        DH_OFF,
    )) === stable({ kind: 'model-change', resolved: { provider: 'a', model: 'm9', reasoningEffort: 'low' } }))

    // 首帧（prev === null）→ 模型变化（若记忆存在且受支持则改写）
    check('classify 首帧为模型变化（有记忆则改写）', stable(classifyTransition(
        null,
        { provider: 'a', model: 'm1' },
        memory,
        groupsWithM1,
        DH_OFF,
    )) === stable({ kind: 'model-change', resolved: { provider: 'a', model: 'm1', reasoningEffort: 'high' } }))

    // 同模型级别变化 → effort-change
    check('classify 级别变化', stable(classifyTransition(
        { provider: 'a', model: 'm1', reasoningEffort: 'low' },
        { provider: 'a', model: 'm1', reasoningEffort: 'high' },
        memory,
        groupsWithM1,
        DH_OFF,
    )) === stable({ kind: 'effort-change' }))

    // 同模型级别变 undefined → effort-change
    check('classify 级别变 default', stable(classifyTransition(
        { provider: 'a', model: 'm1', reasoningEffort: 'low' },
        { provider: 'a', model: 'm1' },
        memory,
        groupsWithM1,
        DH_OFF,
    )) === stable({ kind: 'effort-change' }))

    // 同模型同级别 → none
    check('classify 无变化', stable(classifyTransition(
        { provider: 'a', model: 'm1', reasoningEffort: 'low' },
        { provider: 'a', model: 'm1', reasoningEffort: 'low' },
        memory,
        groupsWithM1,
        DH_OFF,
    )) === stable({ kind: 'none' }))

    // 同模型 undefined === undefined → none
    check('classify 同模型 undefined 无变化', stable(classifyTransition(
        { provider: 'a', model: 'm1' },
        { provider: 'a', model: 'm1' },
        memory,
        groupsWithM1,
        DH_OFF,
    )) === stable({ kind: 'none' }))

    // ---------- defaultHigh：无记忆分支下，未设置级别且模型公告 high → 设为 high ----------
    const DH_ON = true
    check('defaultHigh 无记忆未设置级别且模型有 high → 设为 high', stable(classifyTransition(
        { provider: 'b', model: 'x' },
        { provider: 'a', model: 'm1' },
        {},
        groupsWithM1,
        DH_ON,
    )) === stable({ kind: 'model-change', resolved: { provider: 'a', model: 'm1', reasoningEffort: 'high' } }))

    // defaultHigh 开关关闭时不生效（resolved 即 next，无 high 改写）
    check('defaultHigh 关闭时不改写', stable(classifyTransition(
        { provider: 'b', model: 'x' },
        { provider: 'a', model: 'm1' },
        {},
        groupsWithM1,
        DH_OFF,
    )) === stable({ kind: 'model-change', resolved: { provider: 'a', model: 'm1' } }))

    // 模型不公告 high（m2 只有 low）→ 不改写
    check('defaultHigh 模型无 high 不改写', stable(classifyTransition(
        { provider: 'b', model: 'x' },
        { provider: 'a', model: 'm2' },
        {},
        groupsWithM1,
        DH_ON,
    )) === stable({ kind: 'model-change', resolved: { provider: 'a', model: 'm2' } }))

    // 模型无 reasoning（groups 的 provider b 的 m2 无 reasoning）→ 不改写
    check('defaultHigh 模型无推理级别不改写', stable(classifyTransition(
        { provider: 'a', model: 'm1' },
        { provider: 'b', model: 'm2' },
        {},
        groups,
        DH_ON,
    )) === stable({ kind: 'model-change', resolved: { provider: 'b', model: 'm2' } }))

    // 已设置推理级别（next.reasoningEffort 非 undefined）→ 不改写（不覆盖既有级别）
    check('defaultHigh 已设置级别不改写', stable(classifyTransition(
        { provider: 'b', model: 'x' },
        { provider: 'a', model: 'm1', reasoningEffort: 'low' },
        {},
        groupsWithM1,
        DH_ON,
    )) === stable({ kind: 'model-change', resolved: { provider: 'a', model: 'm1', reasoningEffort: 'low' } }))

    // 有记忆（即便记忆未恢复，如不受支持）→ defaultHigh 不生效（"无记忆"分支才生效）
    check('defaultHigh 有记忆（不受支持）不改写', stable(classifyTransition(
        { provider: 'b', model: 'x' },
        { provider: 'a', model: 'm2', reasoningEffort: 'low' },
        { a: { m2: 'high' } },
        groupsWithM1,
        DH_ON,
    )) === stable({ kind: 'model-change', resolved: { provider: 'a', model: 'm2', reasoningEffort: 'low' } }))

    // 有记忆且可恢复 → 恢复优先于 defaultHigh（不因 defaultHigh 而改写为 high）
    check('defaultHigh 记忆恢复优先于默认 high', stable(classifyTransition(
        { provider: 'b', model: 'x' },
        { provider: 'a', model: 'm1', reasoningEffort: 'low' },
        { a: { m1: 'high' } },
        groupsWithM1,
        DH_ON,
    )) === stable({ kind: 'model-change', resolved: { provider: 'a', model: 'm1', reasoningEffort: 'high' } }))

    check('defaultHigh 首帧无记忆模型有 high → 设为 high', stable(classifyTransition(
        null,
        { provider: 'a', model: 'm1' },
        {},
        groupsWithM1,
        DH_ON,
    )) === stable({ kind: 'model-change', resolved: { provider: 'a', model: 'm1', reasoningEffort: 'high' } }))

    // 失效清理不在本文件：见 test/memory.test.ts（Node 半按全量模型列表剪枝）
}
