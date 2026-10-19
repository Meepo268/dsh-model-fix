/** 每模型推理级别记忆的纯逻辑层：从会话模型选择投影的变化序列中区分「模型变化」（应自动恢复记忆）与「级别变化」（应保存记忆），并计算写入后的记忆、校验目标模型是否公告该级别。只管存取，不管整理——失效清理由 Node 半按全量模型列表执行（`src/memory.ts`） */

import type { ModelProviderGroup, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { EffortMemory } from '@/shared/types'

/** 嵌套查记忆：provider → model → 级别；无记录返回 undefined */
export function lookupEffort(memory: EffortMemory, provider: string, model: string): string | undefined {
    return memory[provider]?.[model]
}

/** 计算写入后的整段记忆（不改入参）：`effort` 为字符串则记录该模型，`null` 则清除该模型记忆；provider 下已无模型时整条折叠掉；全空时返回空对象（调用方照写 `{}`，不删键） */
export function applyEffort(memory: EffortMemory, provider: string, model: string, effort: string | null): EffortMemory {
    const next: EffortMemory = {}
    for (const [id, models] of Object.entries(memory)) next[id] = { ...models }
    if (effort === null) {
        const entry = { ...next[provider] }
        delete entry[model]
        if (Object.keys(entry).length === 0) delete next[provider]
        else next[provider] = entry
    } else {
        next[provider] = { ...next[provider], [model]: effort }
    }
    return next
}

/** 目标模型的 `reasoning.efforts` 是否含该级别 */
export function advertisesEffort(groups: readonly ModelProviderGroup[], provider: string, model: string, effort: string): boolean {
    const group = groups.find((g) => g.id === provider)
    if (!group) return false
    const entry = group.models.find((m) => m.id === model)
    if (!entry?.reasoning) return false
    return entry.reasoning.efforts.some((e) => e.id === effort)
}

/** 根据上一选择与当前选择，判定本次是否为「模型变化」（应自动恢复记忆或按 defaultHigh 设为 high）或「级别变化」（应保存记忆）。`prev === null` 视为模型变化（首帧，只应用不记忆）。
 * `defaultHigh` 为 true 且「未设置级别 + 未记住该模型 + 目标模型公告 high」时，把级别改写为 `high`；仅在「model-change」分支生效。
 * 返回 `{ kind: 'model-change', resolved }` / `{ kind: 'effort-change' }` / `{ kind: 'none' }` */
type Transition =
    | { kind: 'model-change', resolved: ModelSelection }
    | { kind: 'effort-change' }
    | { kind: 'none' }

export function classifyTransition(
    prev: ModelSelection | null,
    next: ModelSelection,
    memory: EffortMemory,
    groups: readonly ModelProviderGroup[],
    defaultHigh: boolean,
): Transition {
    if (prev !== null && prev.provider === next.provider && prev.model === next.model) {
        if (next.reasoningEffort !== prev.reasoningEffort) return { kind: 'effort-change' }
        return { kind: 'none' }
    }
    const remembered = lookupEffort(memory, next.provider, next.model)
    if (remembered !== undefined && remembered !== next.reasoningEffort && advertisesEffort(groups, next.provider, next.model, remembered)) {
        return { kind: 'model-change', resolved: { ...next, reasoningEffort: remembered } }
    }
    if (defaultHigh && remembered === undefined && next.reasoningEffort === undefined && advertisesEffort(groups, next.provider, next.model, 'high')) {
        return { kind: 'model-change', resolved: { ...next, reasoningEffort: 'high' } }
    }
    return { kind: 'model-change', resolved: next }
}

/** 两个选择是否完全相同 */
export function sameSelection(a: ModelSelection, b: ModelSelection): boolean {
    return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}
