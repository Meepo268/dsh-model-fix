// reset.ts 纯函数测试：重置计划（仅剔除推理级别、排除跳过、零变更零 op）
import { planResetModels } from '@/reset'
import type { PluginConfig } from '@/shared/types'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { check, stable } from '@test/helper'

const base: PluginConfig = {
    autoFill: { reasoning: true, context: false, image: true },
    allowUpdate: { reasoning: false, context: true, image: false },
    compat: { disableDeveloper: true, disableStore: true },
    excludes: ['acme-gateway'],
    efforts: {},
    written: {},
    sources: {},
        behavior: { showInModels: true, showInBuiltinPlugins: true, showInComposer: true, showFollowStatus: true, backToChat: true, showInFloat: true, classicSetting: true },
    userExperience: { rememberEfforts: true, defaultHigh: false, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: false, localizeEfforts: true, showOriginalEfforts: true, looseMatch: false },
}

/** 取 modelOps 中 path 匹配的第一条 set op 的 value（provider 级 models 数组） */
function modelsValueOf(modelOps: SettingsPathOp[], providerPath: string): Record<string, unknown>[] | undefined {
    const op = modelOps.find((o) => o.path.join('.') === providerPath)
    return op !== undefined && op.op === 'set' ? (op.value as Record<string, unknown>[]) : undefined
}

export function run(): void {
    // ---------- planResetModels：推理级别剔除 ----------
    const providers = {
        // 有推理级别，应剔除；contextWindow / maxTokens / input 不在清除范围、原样保留
        normal: { models: [
            { id: 'a', reasoningEfforts: { off: null, high: 'high' }, contextWindow: 200_000, maxTokens: 8_000, input: ['text', 'image'], temperature: 0.7, customField: 42 },
            { id: 'b', description: 'no reasoning efforts' },
        ] },
        // 命中排除，整体跳过
        'acme-gateway': { models: [{ id: 'c', reasoningEfforts: { off: null }, contextWindow: 100 }] },
        // 无 models 键
        noModels: { api: 'openai-completions' },
        // models 非数组
        badModels: { models: { x: 1 } },
        // 只有其他模型字段、无推理级别：不剔除、不产出 op
        contextOnly: { models: [{ id: 'd', contextWindow: 100, maxTokens: 50, input: ['text'] }] },
    }
    const plan = planResetModels(base, providers)
    const next = modelsValueOf(plan.modelOps, 'providers.normal.models')

    check('排除的 provider 不产出模型 op', plan.modelOps.every((op) => op.path.join('.') !== 'providers.acme-gateway.models'))
    check('无 models 的 provider 不产出模型 op', plan.modelOps.every((op) => op.path.join('.') !== 'providers.noModels.models'))
    check('models 非数组的 provider 不产出模型 op', plan.modelOps.every((op) => op.path.join('.') !== 'providers.badModels.models'))
    check('无推理级别的 provider 不产出模型 op', plan.modelOps.every((op) => op.path.join('.') !== 'providers.contextOnly.models'))
    check('非排除且有推理级别的 provider 产出整段 set op', next !== undefined)
    check('模型数组中无推理级别的元素原样保留', next !== undefined
        && next.length === 2
        && next[1] !== undefined
        && next[1]!.description === 'no reasoning efforts')
    check('有推理级别的模型：仅剔除 reasoningEfforts', next !== undefined
        && next[0] !== undefined
        && next[0]!.reasoningEfforts === undefined)
    check('最大上下文 / 输出上限 / 图片模态保留（模型页可自行设置）', next !== undefined
        && next[0] !== undefined
        && next[0]!.contextWindow === 200_000
        && next[0]!.maxTokens === 8_000
        && next[0]!.input !== undefined)
    check('用户自定义字段保留', next !== undefined
        && next[0] !== undefined
        && next[0]!.id === 'a'
        && next[0]!.temperature === 0.7
        && next[0]!.customField === 42)
    check('changed 计数 = 受影响模型数（normal 仅模型 a 剔除字段）', plan.changed === 1)

    // 重建值里的空壳字段按统一判据一并清掉，不在本模块另写一份空值判据
    const shellPlan = planResetModels(base, { p: { models: [{ id: 'a', reasoningEfforts: { high: 'high' }, input: [], compat: {} }] } })
    check(
        '被重置的模型：其余空壳字段连带清理',
        stable(modelsValueOf(shellPlan.modelOps, 'providers.p.models')) === stable([{ id: 'a' }]),
        modelsValueOf(shellPlan.modelOps, 'providers.p.models'),
    )

    // 写回触发只看「带没带推理级别」：只有空壳的模型不算被重置，否则卡片上的「重置 N 个模型」会虚高
    const shellOnly = planResetModels(base, { p: { models: [{ id: 'a', input: [], compat: {} }] } })
    check(
        '只有空壳字段的模型不计入重置、不产出 op',
        shellOnly.modelOps.length === 0 && shellOnly.changed === 0,
        shellOnly,
    )

    // 无推理级别的 provider 不产出 op（零变更零 op，与 fix 写回纪律一致）
    check('无推理级别的 provider 不产出 op（零变更零 op）',
        (() => {
            const p = planResetModels(base, { solo: { models: [{ id: 'x', description: 'd' }] } })
            return p.modelOps.length === 0 && p.changed === 0
        })())

    // 空 providers：无模型 op
    const emptyPlan = planResetModels(base, {})
    check('空 providers 无模型 op、changed 为 0', emptyPlan.modelOps.length === 0 && emptyPlan.changed === 0)
}
