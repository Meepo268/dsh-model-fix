/** src/compat.ts 纯函数用例：planProviderCompat 的添加 / 移除 / 幂等 / 保留用户其他字段 / 空段 unset */

import { planProviderCompat } from '@/compat'
import type { CompatRules } from '@/shared/types'
import { check, stable } from '@test/helper'

const ON: CompatRules = { disableDeveloper: true, disableStore: true }
const OFF: CompatRules = { disableDeveloper: false, disableStore: false }

/** 两项全开时应写入的整段（顺序无关，比对口径见 stable） */
const ON_VALUE = { supportsDeveloperRole: false, supportsStore: false }

/** 执行本文件的全部用例 */
export function run(): void {
    // ---------- 开启：缺失即添加（与模型参数填充的「关闭即忽略」相反，这里是「关闭即移除」） ----------
    check(
        '开启且原无 compat -> 新建整段',
        stable(planProviderCompat(ON, undefined)) === stable({ op: 'set', value: ON_VALUE }),
        planProviderCompat(ON, undefined),
    )
    check(
        '开启且为空对象 -> 补字段',
        stable(planProviderCompat(ON, {})) === stable({ op: 'set', value: ON_VALUE }),
        planProviderCompat(ON, {}),
    )
    // ---------- 幂等：已是目标值不再写入（否则 fix 会自激 settings/updated 循环） ----------
    check('开启且值已正确 -> 不写', planProviderCompat(ON, { ...ON_VALUE }) === undefined)
    // ---------- 接管：开启期间该字段归本插件所有，覆盖用户手写的 true ----------
    check(
        '开启且用户写 true -> 覆盖为 false',
        stable(planProviderCompat(ON, { supportsDeveloperRole: true, supportsStore: true })) === stable({ op: 'set', value: ON_VALUE }),
        planProviderCompat(ON, { supportsDeveloperRole: true, supportsStore: true }),
    )
    // ---------- 只改自己管辖的键：用户其他 compat 字段原样保留 ----------
    check(
        '开启保留其他 compat 字段',
        stable(planProviderCompat(ON, { thinkingFormat: 'qwen' })) === stable({ op: 'set', value: { thinkingFormat: 'qwen', ...ON_VALUE } }),
        planProviderCompat(ON, { thinkingFormat: 'qwen' }),
    )
    // ---------- 两项各自独立接管：开的一项写 false、关的一项移除，互不牵连 ----------
    check(
        '仅 disableDeveloper 开 -> 写 developer 并移除 store',
        stable(planProviderCompat({ disableDeveloper: true, disableStore: false }, { supportsDeveloperRole: true, supportsStore: false })) === stable({
            op: 'set', value: { supportsDeveloperRole: false },
        }),
        planProviderCompat({ disableDeveloper: true, disableStore: false }, { supportsDeveloperRole: true, supportsStore: false }),
    )
    check(
        '仅 disableStore 开 -> 写 store 并移除 developer',
        stable(planProviderCompat({ disableDeveloper: false, disableStore: true }, { supportsDeveloperRole: false, supportsStore: true })) === stable({
            op: 'set', value: { supportsStore: false },
        }),
        planProviderCompat({ disableDeveloper: false, disableStore: true }, { supportsDeveloperRole: false, supportsStore: true }),
    )
    // ---------- 关闭：移除本组管辖的字段，其余保留 ----------
    check(
        '关闭一项仅删该项',
        stable(planProviderCompat({ disableDeveloper: false, disableStore: true }, { supportsDeveloperRole: false, supportsStore: true })) === stable({
            op: 'set', value: { supportsStore: false },
        }),
        planProviderCompat({ disableDeveloper: false, disableStore: true }, { supportsDeveloperRole: false, supportsStore: true }),
    )
    // ---------- 关闭且删空：整段 unset（空对象在宿主语义等同未声明，不留 debris） ----------
    check(
        '关闭删空 -> unset 整段',
        stable(planProviderCompat(OFF, { supportsDeveloperRole: false, supportsStore: false })) === stable({ op: 'unset' }),
        planProviderCompat(OFF, { supportsDeveloperRole: false, supportsStore: false }),
    )
    check(
        '关闭删空（含用户其他键被删净）-> unset 整段',
        stable(planProviderCompat(OFF, { supportsDeveloperRole: true })) === stable({ op: 'unset' }),
    )
    // ---------- 关闭且本就无本组键 / 无 compat -> 不动（不为删除不存在的键发写） ----------
    check(
        '关闭且无本组键 -> 不写',
        planProviderCompat(OFF, { thinkingFormat: 'qwen' }) === undefined && planProviderCompat(OFF, undefined) === undefined,
    )
    // 残留的空壳 compat 段随「不留空壳」口径整段清理（宿主等同未声明）
    check('关闭且 compat 为空对象 -> unset 整段', stable(planProviderCompat(OFF, {})) === stable({ op: 'unset' }), planProviderCompat(OFF, {}))
    // ---------- 脏值：开启时替换为合法段；关闭时不清理非本组管辖的脏值 ----------
    for (const junk of [undefined, null, 'x', 42, []]) {
        check(
            `开启时脏值 compat -> 规范 set ${stable(junk)}`,
            stable(planProviderCompat(ON, junk)) === stable({ op: 'set', value: ON_VALUE }),
            planProviderCompat(ON, junk),
        )
    }
    check('关闭时脏值 compat 不动', planProviderCompat(OFF, 'x') === undefined && planProviderCompat(OFF, []) === undefined)
}
