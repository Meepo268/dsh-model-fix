// restore.ts 纯函数测试：providersOf 收窄、恢复计划（共有 provider 的共有 model 回退 + 该 provider 下被删 model 复活）
import { planRestore } from '@/restore'
import { providersOf } from '@/shared/types'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { check, stable } from '@test/helper'

/** 取 modelOps 中 path 匹配的第一条 set op 的 value（provider 级 models 数组） */
function modelsValueOf(modelOps: SettingsPathOp[], providerPath: string): Record<string, unknown>[] | undefined {
    const op = modelOps.find((o) => o.path.join('.') === providerPath)
    return op !== undefined && op.op === 'set' ? (op.value as Record<string, unknown>[]) : undefined
}

export function run(): void {
    // 备份：provider a 有两个模型（a1 被插件填了字段、a2 干净）；provider gone 在启动后被删除
    const backup = {
        providers: {
            a: { models: [
                { id: 'a1', name: 'A1', contextWindow: 1000 },
                { id: 'a2', name: 'A2' },
            ] },
            gone: { models: [{ id: 'g1' }] },
        },
    }
    // 当前：a1 被填了字段且 name 被插件覆盖；a2 未动；a3 是启动后新增；b 是启动后新增的 provider
    const current = {
        a: { models: [
            { id: 'a1', name: 'A1-filled', contextWindow: 2000, reasoningEfforts: { off: null } },
            { id: 'a2', name: 'A2' },
            { id: 'a3', newModel: true },
        ] },
        b: { models: [{ id: 'b1' }] },
    }
    const plan = planRestore(backup.providers, current)
    const restoredA = modelsValueOf(plan.modelOps, 'providers.a.models')

    check('共有 provider 产出整段 set op', restoredA !== undefined)
    check('共有 model 回退为备份值', restoredA !== undefined
        && restoredA[0] !== undefined
        && restoredA[0]!.name === 'A1'
        && restoredA[0]!.contextWindow === 1000
        && restoredA[0]!.reasoningEfforts === undefined)
    check('当前独有的新增 model 原样保留', restoredA !== undefined
        && restoredA.length === 3
        && restoredA[2] !== undefined
        && restoredA[2]!.newModel === true)
    check('共有 model 中值未变者内容保持不变', restoredA !== undefined
        && restoredA[1] !== undefined
        && restoredA[1]!.id === 'a2'
        && restoredA[1]!.name === 'A2')
    check('备份中被删除的 provider 不产出 op（其下 model 不复活）',
        plan.modelOps.every((op) => op.path.join('.') !== 'providers.gone.models'))
    check('启动后新增的 provider 不产出 op', plan.modelOps.every((op) => op.path.join('.') !== 'providers.b.models'))
    check('changed 计数 = 被恢复（值被改写）的模型数', plan.changed === 1)

    // 复活：备份有、当前没有的 model，provider 仍在即按备份原序追加到末尾
    const reviveBackup = { p: { models: [
        { id: 'm1', name: 'M1' },
        { id: 'm2', name: 'M2', compat: {}, input: [] },
    ] } }
    const reviveCurrent = { p: { models: [
        { id: 'm1', name: 'M1-filled', contextWindow: 2000 },
        { id: 'm3', newModel: true },
    ] } }
    const revivePlan = planRestore(reviveBackup, reviveCurrent)
    const revivedModels = modelsValueOf(revivePlan.modelOps, 'providers.p.models')
    check(
        '共有 model 回退、当前独有保留、被删 model 复活追加到末尾（复活同样清空壳）',
        stable(revivedModels) === stable([
            { id: 'm1', name: 'M1' },
            { id: 'm3', newModel: true },
            { id: 'm2', name: 'M2' },
        ]),
        revivedModels,
    )
    check('changed 计数含被复活的模型', revivePlan.changed === 2)

    // models 键被整体删掉（模型删光）：视为删光而非「无 models 声明」，备份里的模型全部复活
    const emptiedPlan = planRestore(
        { p: { models: [{ id: 'm1' }, { id: 'm2' }] } },
        { p: { api: 'openai-completions' } },
    )
    check(
        'models 键缺失时全部复活',
        stable(modelsValueOf(emptiedPlan.modelOps, 'providers.p.models')) === stable([{ id: 'm1' }, { id: 'm2' }]),
    )
    check('models 键缺失时 changed 计全部复活数', emptiedPlan.changed === 2)

    // 当前侧 models 损坏成非数组（非 null）：跳过，不按删光处理
    check('当前侧 models 非数组（非 null）跳过', (() => {
        const p = planRestore({ p: { models: [{ id: 'm1' }] } }, { p: { models: { x: 1 } } })
        return p.modelOps.length === 0 && p.changed === 0
    })())

    // 备份与当前完全一致：零变更零 op
    const sameCurrent = structuredClone(backup.providers)
    const samePlan = planRestore(backup.providers, sameCurrent)
    check('无差异时零 op、changed 为 0', samePlan.modelOps.length === 0 && samePlan.changed === 0)

    // 恢复值同样过空壳清理：备份是插件动手前的原样快照，空壳带回来只是把脏值复刻一遍
    const shellBackup = { p: { models: [{ id: 'm1', name: 'M', input: [], compat: {} }] } }
    const shellPlan = planRestore(shellBackup, { p: { models: [{ id: 'm1', name: 'M-filled' }] } })
    check(
        '恢复值里的空壳字段按统一判据清掉',
        stable(modelsValueOf(shellPlan.modelOps, 'providers.p.models')) === stable([{ id: 'm1', name: 'M' }]),
        modelsValueOf(shellPlan.modelOps, 'providers.p.models'),
    )
    check('清理后与当前无差异时零 op（无可恢复）', (() => {
        const p = planRestore(shellBackup, { p: { models: [{ id: 'm1', name: 'M' }] } })
        return p.modelOps.length === 0 && p.changed === 0
    })())

    // 备份缺失（捕获失败）：零 op
    check('备份缺失时零 op', (() => {
        const p = planRestore(undefined, current)
        return p.modelOps.length === 0 && p.changed === 0
    })())

    // 备份非纯对象（损坏）：零 op
    check('备份非纯对象时零 op', (() => {
        const p = planRestore([] as unknown as Record<string, unknown>, current)
        return p.modelOps.length === 0 && p.changed === 0
    })())

    // 空 providers 当前：无共有 provider ⇒ 零 op
    const emptyPlan = planRestore(backup.providers, {})
    check('当前 providers 为空时零 op', emptyPlan.modelOps.length === 0 && emptyPlan.changed === 0)

    // 非纯对象 provider（当前侧损坏）：跳过不抛
    check('当前侧非纯对象 provider 跳过', (() => {
        const p = planRestore({ x: { models: [{ id: 'm1' }] } }, { x: 'bad' as unknown as Record<string, unknown> })
        return p.modelOps.length === 0 && p.changed === 0
    })())

    // 备份侧 provider 无 models / models 非数组：跳过
    check('备份侧无 models 或 models 非数组的 provider 跳过', (() => {
        const p = planRestore(
            { p1: { api: 'openai-completions' }, p2: { models: { x: 1 } } },
            { p1: { models: [] }, p2: { models: [] } },
        )
        return p.modelOps.length === 0 && p.changed === 0
    })())

    // ---------- providersOf：捕获与恢复共用的收窄口径 ----------
    check('providersOf 取 user 层的 providers 段', (() => {
        const got = providersOf({ providers: { a: { models: [] } }, other: 1 })
        return got !== undefined && Object.keys(got).join() === 'a'
    })())
    check('providersOf：user 非纯对象 / 无 providers / providers 非纯对象一律 undefined',
        providersOf(undefined) === undefined
        && providersOf('x') === undefined
        && providersOf({}) === undefined
        && providersOf({ providers: 'bad' }) === undefined
        && providersOf({ providers: [] }) === undefined)

    // ---------- 捕获→恢复整条接线（回归守护）----------
    // 真实踩过的坑：捕获侧存整层 user、恢复侧按 providers 段消费，planRestore 把键名 "providers"
    // 当 provider id ⇒ 永不相交 ⇒ changed 恒 0（纯函数用例各自传已收窄的值，测不出来）。
    // 故此处按生产同构走完整链路：两侧一律经 providersOf 从整层 user 收窄。
    check('捕获→恢复整链路（两侧均从整层 user 收窄）可回退被填字段', (() => {
        const userStart = { providers: { a: { models: [{ id: 'm1', name: 'A' }, { id: 'm2' }] } } }
        // 插件在 m1 上填了字段，并给 m2 补了 name
        const userNow = { providers: { a: { models: [
            { id: 'm1', name: 'A', contextWindow: 200_000, reasoningEfforts: { off: null } },
            { id: 'm2', name: 'filled' },
        ] } } }
        const captured = structuredClone(providersOf(userStart))
        const p = planRestore(captured, providersOf(userNow)!)
        const models = modelsValueOf(p.modelOps, 'providers.a.models')
        return p.changed === 2 && models !== undefined
            && models[0] !== undefined && models[0]!.contextWindow === undefined
            && models[0]!.reasoningEfforts === undefined
            && models[1] !== undefined && models[1]!.name === undefined
    })())
}
