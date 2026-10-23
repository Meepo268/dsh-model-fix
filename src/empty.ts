/** 空壳字段统一清理（判据只此一处，凡重建模型条目的写回路径都过它；只列三个键、用户自定义字段原样保留，口径见 docs/decisions-config.md「填充与写回」） */
import { isPlainObject } from '@/shared/types'

/** 空对象判据 */
function isEmptyRecord(value: unknown): boolean {
    return isPlainObject(value) && Object.keys(value).length === 0
}

/** `reasoningEfforts` 空壳判据：空对象或只剩 off 键（宿主拒绝只声明 off 的档位表，仅有 off 无实义） */
function isReasoningEffortsAbsent(value: unknown): boolean {
    if (!isPlainObject(value)) return false
    const keys = Object.keys(value)
    return keys.length === 0 || (keys.length === 1 && keys[0] === 'off')
}

/** 「空即未声明」字段表：`reasoningEfforts`（空对象或只剩 off 键）/ `input`（空数组 = 纯文本）/ `compat`（空对象） */
const EMPTY_IS_ABSENT: readonly (readonly [string, (value: unknown) => boolean])[] = [
    ['reasoningEfforts', isReasoningEffortsAbsent],
    ['input', (value) => Array.isArray(value) && value.length === 0],
    ['compat', isEmptyRecord],
]

/** 剔除空壳字段；无变化时返回原引用（调用方以引用相等判「无需重建」，不能无条件拷贝） */
export function stripEmptyFields(model: Record<string, unknown>): Record<string, unknown> {
    let next: Record<string, unknown> | undefined
    for (const [key, isEmpty] of EMPTY_IS_ABSENT) {
        if (!isEmpty(model[key])) continue
        next ??= { ...model }
        delete next[key]
    }
    return next ?? model
}
