import type { Context } from '@deepseek-ai/cordis'
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import { PLUGIN_NS } from '@/shared/constants'
import { isPlainObject } from '@/shared/types'

/**
 * settings 节读取的收口：把「按命名空间取段」收成通用读取，各处不再各自 `describe().find(...)`。
 *
 * 三层取用按调用方真正需要的粒度分开：`descriptorOf` 取整张描述（写回的 `revision` 围栏与 `user`
 * 原始字段都从这一张来）、`sectionOf` 从描述里收窄 `user` 层整段、`ownSection` 是只读自有段的快捷方式。
 *
 * 读不到一律返回 `undefined` 而不抛错：「段不可读」该由调用方决定显式失败还是静默早退，不在读取层替他决定。
 */

/** 取命名空间的整张描述（缺失即 undefined）：写回围栏的 revision 与 user 层原始字段都从这里取 */
export function descriptorOf(ctx: Context, ns: string): SettingsDescriptor | undefined {
    return ctx.settings.describe().find((d) => d.ns === ns)
}

/** 描述的 user 层整段；非纯对象即 undefined（与 `src/migrate.ts` 的收窄口径一致） */
export function sectionOf(descriptor: SettingsDescriptor | undefined): Record<string, unknown> | undefined {
    const user = descriptor?.user
    return isPlainObject(user) ? user : undefined
}

/** 自有段（`tikaflow-model-fix`）的 user 层整段 */
export function ownSection(ctx: Context): Record<string, unknown> | undefined {
    return sectionOf(descriptorOf(ctx, PLUGIN_NS))
}
