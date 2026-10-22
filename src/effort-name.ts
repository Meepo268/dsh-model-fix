/** 本地化推理级别的 Node 半：开关开时把 `resolveModelInfo` 返回里的档位显示名换中文，可选追加原名（`showOriginalEfforts`）。
 * 遮 `resolveModelInfo` 一处即全链覆盖（UI 菜单/触发器标题/subagent list-models 都取这个名字，与 official-filter 同形态）。
 * 语言三路回退：宿主 settings `locale.preference` → 浏览器半 RPC 上报 → `en`。
 * 只换 `efforts[].name`：`id` 与 `defaultEffort` 原样（后者是档位 id，宿主校验它落在 `efforts[].id` 集合内，翻译即破坏校验与线上值，见 docs/decisions.md「宿主与卡片」） */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
// ctx.settings 服务面声明合并（type-only；settings 是宿主基础服务，装载即在）
import type {} from '@deepseek-ai/dsh-settings'
import { EFFORT_NAMES_ZH, EFFORT_NAME_SEP } from '@/shared/constants'
import { isPlainObject } from '@/shared/types'
import { descriptorOf, sectionOf } from '@/section'
import { getConfig } from '@/config'

/** 宿主 locale 插件在 settings 文档里的段名与字段名（与其 `LOCALE_SETTINGS_NAMESPACE` / `LOCALE_PREFERENCE_FIELD` 同字面量） */
const LOCALE_SETTINGS_NAMESPACE = 'locale'
const LOCALE_PREFERENCE_FIELD = 'preference'

/** 判「中文界面」的 locale id：只认 zh 系，其余一律按非中文 */
const ZH_LOCALE_IDS: readonly string[] = ['zh']

/** RPC 上报的最近一次浏览器探测语言；`undefined` = 浏览器尚未上报 */
let reportedLocale: string | undefined

/** 按档位 id 查表的键形式（宿主显示名口径：id 首字母大写） */
function zhKeyOf(id: string): string { return id.charAt(0).toUpperCase() + id.slice(1) }

/** 按档位 id 换掉 `efforts[].name`：命中产出新数组，全未命中则原样返回入参（不造新对象）；`showOriginal` 为 true 时中文名后追加原名（`最大 · Max`） */
export function localizeEffortNames(info: LlmResolvedModelInfo, showOriginal = false): LlmResolvedModelInfo {
    const reasoning = info.reasoning
    if (reasoning === undefined) return info
    let renamed = false
    const efforts = reasoning.efforts.map((effort) => {
        const zh = EFFORT_NAMES_ZH[zhKeyOf(effort.id)]
        if (zh === undefined) return effort
        const localized = showOriginal ? `${zh}${EFFORT_NAME_SEP}${effort.name}` : zh
        if (localized === effort.name) return effort
        renamed = true
        return { ...effort, name: localized }
    })
    if (!renamed) return info
    return { ...info, reasoning: { ...reasoning, efforts } }
}

/** 当前的界面语言：显式偏好 → 浏览器上报 → `en`。每次换名前现算，不缓存、不监听事件 */
function localeNow(ctx: Context): string {
    const section = sectionOf(descriptorOf(ctx, LOCALE_SETTINGS_NAMESPACE))
    const preference = isPlainObject(section) ? section[LOCALE_PREFERENCE_FIELD] : undefined
    if (typeof preference === 'string' && preference.length > 0) return preference
    return reportedLocale ?? 'en'
}

/** 上报的语言是否算中文：zh 精确命中或 `zh-` 前缀（`zh-CN` 等地区变体） */
function isZh(locale: string): boolean {
    return ZH_LOCALE_IDS.some((id) => locale === id || locale.startsWith(`${id}-`))
}

/** 本层遮蔽的品牌标记：`Symbol.for` 全局注册，HMR 重载后同字符串仍是同一 Symbol */
const LOCALIZED_LAYER = Symbol.for('model-fix.effort-localized')

/** 带品牌标记的遮蔽层：`in` 探测与赋值共用这个面 */
interface LocalizedLayer {
    (provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
    [LOCALIZED_LAYER]?: boolean
}

/** 装上档位名本地化：把 `ctx.llm` 的 `resolveModelInfo` 遮成「中文界面下换名、否则直通」的一层。
 * 卸载不动服务上的属性（遮蔽链式，动属性会抹掉别人的遮蔽）；wrapped 闭包捕获的 ctx 在 fiber dispose 后失活，用 `ctx.fiber.store` 作守卫，不通过即直通 original；HMR 重载整函数重跑，靠品牌标记幂等 */
export function installEffortNameLocale(ctx: Context): void {
    const llm = ctx.llm
    const original = llm.resolveModelInfo
    if (LOCALIZED_LAYER in original) return
    const wrapped: LocalizedLayer = async (provider, model, signal) => {
        const info = await original.call(llm, provider, model, signal)
        if (ctx.fiber.store && getConfig().userExperience.localizeEfforts && isZh(localeNow(ctx))) {
            return localizeEffortNames(info, getConfig().userExperience.showOriginalEfforts)
        }
        return info
    }
    wrapped[LOCALIZED_LAYER] = true
    llm.resolveModelInfo = wrapped
}

/** 记下浏览器半上报的探测语言（RPC 端点 `reportLocale` 的落点；进程内易失，重启后由浏览器重新上报） */
export function reportLocale(locale: unknown): void {
    if (typeof locale !== 'string' || locale.length === 0) return
    // 语言包插件开放 id 形态（BCP 47），非 zh 系原样记录：换名判定只关心是不是中文
    reportedLocale = locale
}
