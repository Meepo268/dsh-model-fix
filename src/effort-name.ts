/**
 * 「本地化推理级别」的 Node 半实现：开关开启时把 `resolveModelInfo` 返回里的档位显示名换成中文。
 *
 * 落点依据：宿主目录的唯一生成链路是 `modelCatalog` 远程 → `buildModelCatalog` → 逐 provider
 * `ctx.llm.listModels` + `ctx.llm.resolveModelInfo`——档位显示名只在 `resolveModelInfo` 的返回里
 * 出现（`listModels` 只给模型 id/name），且 UI 菜单、触发器标题与宿主 subagent 的 list-models 工具
 * 全部取这个名字。遮这一处即全链覆盖，且与 `official-filter` 遮 `listModels` 同一对象、同一形态
 * （`LlmRuntime` 的公开实例方法，赋值遮蔽已验证可行）。
 *
 * 语言判定（Node 侧没有 `locale` 服务，读不到浏览器探测结果），三路取值、逐级回退：
 * 1. 宿主 settings 文档的 `locale.preference`（用户显式选择，落盘持久）；
 * 2. 浏览器半启动时经 RPC 上报的探测语言（补「未显式选择」的多数场景）；
 * 3. 回退 `en`（不换名）。
 *
 * 只换 `efforts[].name`：`id` 与 `defaultEffort` 一律原样——`defaultEffort` 是档位 id 且宿主校验
 * 它必须落在 `efforts[].id` 集合内（`LlmRuntime` 的 INVALID_MODEL_REASONING），翻译即破坏校验与线上值；
 * UI 显示默认档位走「id → 对应档位 name」，那个 name 已被换掉，显示链路自然覆盖。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
// ctx.settings 服务面声明合并（type-only；settings 是宿主基础服务，装载即在）
import type {} from '@deepseek-ai/dsh-settings'
import { EFFORT_NAMES_ZH } from '@/shared/constants'
import { isPlainObject } from '@/shared/types'
import { descriptorOf, sectionOf } from '@/section'
import { getConfig } from '@/config'

/** 宿主 locale 插件在 settings 文档里的段名与字段名（与其 `LOCALE_SETTINGS_NAMESPACE` / `LOCALE_PREFERENCE_FIELD` 同字面量） */
const LOCALE_SETTINGS_NAMESPACE = 'locale'
const LOCALE_PREFERENCE_FIELD = 'preference'

/** 判「中文界面」的 locale id 集合：只认 zh 系（`zh` / `zh-CN` 等），其余语言一律按非中文处理 */
const ZH_LOCALE_IDS: readonly string[] = ['zh']

/** RPC 上报的最近一次浏览器探测语言；`undefined` 表示浏览器侧尚未上报过 */
let reportedLocale: string | undefined

/**
 * 按档位 id 换掉 `efforts[].name`：命中换名产出新数组，一档未命中则原样返回入参（不造新对象）。
 * @param info - `resolveModelInfo` 的返回
 * @returns 换名后的信息（其余字段与入参同一引用）
 */
export function localizeEffortNames(info: LlmResolvedModelInfo): LlmResolvedModelInfo {
    const reasoning = info.reasoning
    if (reasoning === undefined) return info
    let renamed = false
    const efforts = reasoning.efforts.map((effort) => {
        const name = EFFORT_NAMES_ZH[effort.id.charAt(0).toUpperCase() + effort.id.slice(1) as keyof typeof EFFORT_NAMES_ZH]
        if (name === undefined || name === effort.name) return effort
        renamed = true
        return { ...effort, name }
    })
    if (!renamed) return info
    return { ...info, reasoning: { ...reasoning, efforts } }
}

/**
 * 当前的界面语言：显式偏好 → 浏览器上报 → `en`。每次换名前现算，不缓存、不监听事件。
 * @param ctx - 插件 ctx（读宿主 settings 文档的 locale 段）
 */
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

/** 装上档位名本地化：把 `ctx.llm` 的 `resolveModelInfo` 遮成「中文界面下换名、否则直通」的一层
 *
 * 卸载不动服务上的属性（遮蔽是链式的，后装插件记住的 original 正是我们的 wrapped，动属性会抹掉
 * 别人的遮蔽）。wrapped 闭包捕获的 ctx 在 fiber dispose 后失活，用 `ctx.fiber.store`（cordis 原生
 * 活性信号，dispose 即 undefined）作守卫——不通过即直通 original，完全不碰 ctx。
 */
export function installEffortNameLocale(ctx: Context): void {
    const llm = ctx.llm
    const original = llm.resolveModelInfo
    const wrapped = async (provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> => {
        const info = await original.call(llm, provider, model, signal)
        if (ctx.fiber.store && getConfig().userExperience.localizeEfforts && isZh(localeNow(ctx))) {
            return localizeEffortNames(info)
        }
        return info
    }
    llm.resolveModelInfo = wrapped
}

/** 记下浏览器半上报的探测语言（RPC 端点 `reportLocale` 的落点；进程内易失，重启后由浏览器重新上报） */
export function reportLocale(locale: unknown): void {
    if (typeof locale !== 'string' || locale.length === 0) return
    // 语言包插件开放 id 形态（BCP 47），非 zh 系原样记录：换名判定只关心是不是中文
    reportedLocale = locale
}

