/**
 * provider 路由 compat 的写入计划：把配置的 `compat` 规则组映射为一次路由级写入。
 * 纯函数（不依赖 ctx 与设置服务），故可进 test/；写回的编排与幂等判定由 fix 负责。
 */

import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { DEVELOPER_COMPAT_FIELD, STORE_COMPAT_FIELD } from '@/constants'
import type { CompatRules } from '@/shared/types'
import { isPlainObject } from '@/shared/types'

/** 一条兼容性规则在路由 compat 中的落点 */
interface CompatRule {
    /** 配置键（compat.<key>） */
    key: keyof CompatRules
    /** 受该键管辖的路由 compat 字段名 */
    field: string
    /** 该键为 true 时写入字段的值 */
    value: boolean
}

/**
 * 规则表：新增兼容性配置在此追加一条。只写路由级、不写模型级；协议 gate（COMPAT_APIS）由 fix.ts 判。
 */
const RULES: readonly CompatRule[] = [
    { key: 'disableDeveloper', field: DEVELOPER_COMPAT_FIELD, value: false },
    { key: 'disableStore', field: STORE_COMPAT_FIELD, value: false },
]

/** 路由 compat 的目标形态：set 覆盖整段（保留用户其余字段）/ unset 删除整段（已无字段） */
type CompatPlan = { op: 'set'; value: Record<string, unknown> } | { op: 'unset' }

/**
 * 依据当前兼容性规则计算某路由 compat 应写入的形态；与现值一致（或本就无需 compat 段）时返回 undefined。
 * 与模型参数填充的关键差异：**关闭的规则是「移除该字段」而非「保留不管」**，故移除后不留空对象——
 * 目标形态无任何字段时整段 unset（宿主语义上空对象等同未声明）。
 * @param compat - 生效的兼容性规则组。
 * @param current - 用户段 `providers.<id>.compat` 原值（非纯对象按无处理，但不清理非本组管辖的脏值）。
 */
export function planProviderCompat(compat: CompatRules, current: unknown): CompatPlan | undefined {
    const base = isPlainObject(current) ? current : undefined
    const target: Record<string, unknown> = { ...base }
    for (const rule of RULES) {
        if (compat[rule.key]) target[rule.field] = rule.value
        else delete target[rule.field]
    }
    // 目标为空 → 不留空壳：本就没有 compat 段则无需动作，残留空壳（含被清空的 {}）整段 unset
    if (Object.keys(target).length === 0) return base === undefined ? undefined : { op: 'unset' }
    // 目标非空且与现值一致 → 跳过（幂等）
    if (base !== undefined && deepEqualJson(base, target)) return
    return { op: 'set', value: target }
}
