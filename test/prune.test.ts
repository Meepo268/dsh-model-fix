// src/prune.ts 纯函数测试：剔除计划（只剔指定档位、剔空不留空壳、幂等、excludes 跳过）与 RPC 载荷校验
import { parsePruneTargets, planPruneEfforts } from '@/prune'
import type { PluginConfig } from '@/shared/types'
import type { UnsupportedEffort } from '@/shared/verify-progress'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { check, stable } from '@test/helper'

const base: PluginConfig = {
    autoFill: { reasoning: true, context: false, image: true },
    allowUpdate: { reasoning: false, context: true, image: false },
    compat: { disableDeveloper: true, disableStore: true },
    excludes: ['lab'],
    efforts: {},
    userExperience: { rememberEfforts: true, defaultHigh: false, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: false },
}

const providers = {
    acme: {
        models: [
            { id: 'm1', reasoningEfforts: { off: 1, high: 2, max: 3 }, contextWindow: 128000, temperature: 0.7 },
            { id: 'm2', reasoningEfforts: { low: 7 } },
            { id: 'plain' },
        ],
    },
    lab: { models: [{ id: 'n1', reasoningEfforts: { off: 1, high: 2 } }] },
}

/** 取 modelOps 中 path 匹配的第一条 set op 的 value（provider 级 models 数组） */
function modelsValueOf(modelOps: SettingsPathOp[], providerPath: string): Record<string, unknown>[] | undefined {
    const op = modelOps.find((o) => o.path.join('.') === providerPath)
    return op !== undefined && op.op === 'set' ? (op.value as Record<string, unknown>[]) : undefined
}

const prune = (targets: readonly UnsupportedEffort[]) => planPruneEfforts(base, providers, targets)
const acmeModels = (modelOps: SettingsPathOp[]) => modelsValueOf(modelOps, 'providers.acme.models')

/** 执行本文件的全部用例 */
export function run(): void {
    // ---------- planPruneEfforts：只剔指定的那些档位 ----------
    const one = prune([{ provider: 'acme', model: 'm1', effort: 'high' }])
    check(
        '部分剔除：只动指定档位，模型其余字段与同 provider 的其他模型原样保留',
        stable(acmeModels(one.modelOps)) === stable([
            { id: 'm1', reasoningEfforts: { off: 1, max: 3 }, contextWindow: 128000, temperature: 0.7 },
            { id: 'm2', reasoningEfforts: { low: 7 } },
            { id: 'plain' },
        ]),
        acmeModels(one.modelOps),
    )
    check('部分剔除：pruned 只计真正剔掉的条数', one.pruned === 1, one.pruned)

    // 剔空在**写入前**判定：整个 reasoningEfforts 键不出现在新值里，不做先写空再删的两次写入
    const emptied = prune([{ provider: 'acme', model: 'm2', effort: 'low' }])
    check(
        '剔空档位：整个 reasoningEfforts 键不写出（不留空壳）',
        stable(acmeModels(emptied.modelOps)?.[1]) === stable({ id: 'm2' }),
        acmeModels(emptied.modelOps),
    )
    check('剔空档位：pruned 仍为 1', emptied.pruned === 1, emptied.pruned)

    // 空壳清理不再各写一份：被剔除的模型上其余空壳字段按统一判据一并清掉
    const shells = planPruneEfforts(
        base,
        { acme: { models: [{ id: 'm1', reasoningEfforts: { high: 2, low: 3 }, input: [], compat: {} }] } },
        [{ provider: 'acme', model: 'm1', effort: 'high' }],
    )
    check(
        '空壳字段按统一判据连带清理（非空字段与用户自定义键保留）',
        stable(modelsValueOf(shells.modelOps, 'providers.acme.models')?.[0]) === stable({ id: 'm1', reasoningEfforts: { low: 3 } }),
        modelsValueOf(shells.modelOps, 'providers.acme.models'),
    )

    // 幂等：验明确认之后用户自己改掉的档位不再命中——零写入，也不虚报条数
    check(
        '档位已不存在：零写入零计数',
        (() => {
            const p = prune([{ provider: 'acme', model: 'm1', effort: 'low' }])
            return p.modelOps.length === 0 && p.pruned === 0
        })(),
    )
    check(
        '模型不存在：零写入零计数',
        (() => {
            const p = prune([{ provider: 'acme', model: 'ghost', effort: 'high' }])
            return p.modelOps.length === 0 && p.pruned === 0
        })(),
    )
    check(
        '无档位模型：零写入零计数',
        (() => {
            const p = prune([{ provider: 'acme', model: 'plain', effort: 'high' }])
            return p.modelOps.length === 0 && p.pruned === 0
        })(),
    )
    check('空目标：零写入零计数', (() => {
        const p = prune([])
        return p.modelOps.length === 0 && p.pruned === 0
    })())

    // 排除语义对本插件的写入处处生效，不因这次由用户发起而破例
    check('excludes 命中的提供方整组跳过', (() => {
        const p = prune([{ provider: 'lab', model: 'n1', effort: 'high' }])
        return p.modelOps.length === 0 && p.pruned === 0
    })())

    // 逐 provider 整段 set（路径 op 不支持数组下标中间段），同 provider 的多个目标合并成一个 op
    const both = prune([
        { provider: 'acme', model: 'm1', effort: 'max' },
        { provider: 'acme', model: 'm1', effort: 'high' },
    ])
    check('同 provider 多目标合并为一个 op', both.modelOps.length === 1 && both.pruned === 2, both)
    check(
        '同 provider 多目标一次剔干净（仅剩 off 即空壳，一并移除）',
        stable(acmeModels(both.modelOps)?.[0]) === stable({ id: 'm1', contextWindow: 128000, temperature: 0.7 }),
        acmeModels(both.modelOps),
    )

    // ---------- parsePruneTargets：RPC 入参按不可信输入校验 ----------
    check(
        '载荷合法则原样通过',
        stable(parsePruneTargets({ targets: [{ provider: 'a', model: 'm', effort: 'high' }] }))
        === stable([{ provider: 'a', model: 'm', effort: 'high' }]),
    )
    check('非对象拒绝', parsePruneTargets(undefined) === undefined)
    check('targets 非数组拒绝', parsePruneTargets({ targets: {} }) === undefined)
    check('targets 空数组拒绝', parsePruneTargets({ targets: [] }) === undefined)
    check('条目非对象拒绝', parsePruneTargets({ targets: ['x'] }) === undefined)
    check('provider 缺失拒绝', parsePruneTargets({ targets: [{ model: 'm', effort: 'high' }] }) === undefined)
    check('provider 空串拒绝', parsePruneTargets({ targets: [{ provider: '', model: 'm', effort: 'high' }] }) === undefined)
    check('model 缺失拒绝', parsePruneTargets({ targets: [{ provider: 'a', effort: 'high' }] }) === undefined)
    check('effort 越界拒绝', parsePruneTargets({ targets: [{ provider: 'a', model: 'm', effort: 'turbo' }] }) === undefined)
    check('effort 目录拼写 none 拒绝', parsePruneTargets({ targets: [{ provider: 'a', model: 'm', effort: 'none' }] }) === undefined)
    // 半剔比不剔更难向用户解释：任一条不合法即整体拒绝，不做部分剔除
    check(
        '任一条不合法则整体拒绝',
        parsePruneTargets({
            targets: [
                { provider: 'a', model: 'm', effort: 'high' },
                { provider: 'a', model: 'm', effort: 'turbo' },
            ],
        }) === undefined,
    )
}
