import type { Context } from '@deepseek-ai/cordis'
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import { PLUGIN_NS } from '@/shared/constants'
import { isPlainObject } from '@/shared/types'

/** settings 节读取收口：`descriptorOf` 取整张描述、`sectionOf` 收窄 user 层、`ownSection` 自有段快捷方式；读不到一律返回 undefined（显式失败还是静默早退由调用方决定） */

/** 取命名空间整张描述（缺失即 undefined） */
export function descriptorOf(ctx: Context, ns: string): SettingsDescriptor | undefined {
    return ctx.settings.describe().find((d) => d.ns === ns)
}

/** 描述的 user 层整段；非纯对象即 undefined */
export function sectionOf(descriptor: SettingsDescriptor | undefined): Record<string, unknown> | undefined {
    const user = descriptor?.user
    return isPlainObject(user) ? user : undefined
}

/** 自有段（`tikaflow-model-fix`）的 user 层整段 */
export function ownSection(ctx: Context): Record<string, unknown> | undefined {
    return sectionOf(descriptorOf(ctx, PLUGIN_NS))
}
