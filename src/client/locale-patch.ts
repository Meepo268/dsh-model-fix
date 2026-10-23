/** 宿主词典运行时 patch：开关开时把宿主 model 命名空间 zh 词典里的 `effort.providerDefault` 词条从 'Default' 改成 '默认'（`showOriginalEfforts` 开着则改成 '默认 · Default'）。
 * Default 是宿主自合成的伪菜单项，取的是浏览器半 locale 词条而非数据层，Node 半遮蔽碰不到；宿主禁止同 ns+locale 重复注册，故只能 mutate 已注册对象再手动 `publish` bump revision（私接面见 docs/host/）。
 * 三态与 Node 半 `localizeEffortNames` 同一形态。卸载时恢复原状、再 publish 一次 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// ctx.locale 服务面（LocaleRuntime）——这里故意不 import 它的类型，避免触发 private 守卫
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Flags } from '@/client/model'
import type { DecodedScope } from '@/client/scope'
import { EFFORT_NAMES_ZH, EFFORT_NAME_SEP } from '@/shared/constants'

/** 宿主内部结构的 hack 接口：只列我们实际要碰的属性，其余假装不存在 */
interface LocaleRuntimeHack {
    /** ns → locale(lower) → 词典对象（plain object） */
    dicts: Map<string, Map<string, Record<string, string>>>
    /** 手动 bump revision 通知 outlets 重渲染 */
    publish(active: string, localeChanged: boolean, locales?: readonly unknown[]): void
    /** 当前快照：publish 需要 active 和 locales */
    snapshot: { active: string; locales: readonly unknown[] }
}

const MODEL_NS = 'model'
const TARGET_KEY = 'effort.providerDefault'
/** LocaleRuntime.localeKey() 是 toLowerCase，直接用小写 'zh' */
const ZH_LOWER = 'zh'

/** 宿主 locales.ts 里 zh 词典的原始值（和 en 一样写的 'Default'）；中文译名取自共享词表 */
const ORIGINAL = 'Default'
const LOCALIZED = EFFORT_NAMES_ZH[ORIGINAL]

/** 算 Default 词条在当前开关组合下该显示的字符串：localizeEfforts=false → 原样 Default；开且 showOriginal=false → 默认；都开 → 默认 · Default */
function valueOf(localized: boolean, showOriginal: boolean): string {
    if (!localized) return ORIGINAL
    return showOriginal ? `${LOCALIZED}${EFFORT_NAME_SEP}${ORIGINAL}` : LOCALIZED
}

/** 设置 zh 词典里目标词条的值；值未变时跳过 publish（值没变，已挂载的 outlet 无需重渲染） */
function patchZhDict(runtime: LocaleRuntimeHack, localized: boolean, showOriginal: boolean): void {
    const zhDict = runtime.dicts.get(MODEL_NS)?.get(ZH_LOWER)
    // model NS 必然已在宿主 boot 期注册；缺席（理论不可能）静默跳过，不抛错、不 publish
    if (zhDict === undefined) return
    const value = valueOf(localized, showOriginal)
    if (zhDict[TARGET_KEY] === value) return
    zhDict[TARGET_KEY] = value
    runtime.publish(runtime.snapshot.active, false, runtime.snapshot.locales)
}

/** 挂上词典 patch 逻辑：启动时按开关状态设置一次，scope 变化（用户切开关）时重新 patch，fiber 卸载时恢复原状 */
export function applyLocalePatch(ctx: ClientContext, scope: DecodedScope<Flags>): void {
    const runtime = ctx.locale as unknown as LocaleRuntimeHack

    const patch = (): void => {
        const flags = scope.getSnapshot().value
        const localized = flags?.userExperience.localizeEfforts ?? false
        const showOriginal = flags?.userExperience.showOriginalEfforts ?? false
        patchZhDict(runtime, localized, showOriginal)
    }

    patch()
    const scopeUnsub = scope.subscribe(patch)

    ctx.effect(() => () => {
        scopeUnsub()
        const zhDict = runtime.dicts.get(MODEL_NS)?.get(ZH_LOWER)
        if (zhDict !== undefined && zhDict[TARGET_KEY] !== ORIGINAL) {
            zhDict[TARGET_KEY] = ORIGINAL
            runtime.publish(runtime.snapshot.active, false, runtime.snapshot.locales)
        }
    })
}
