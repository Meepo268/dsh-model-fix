/** 隐藏官方 API：开关开启且官方提供方未配置密钥时，让它在 UI 模型列表里不出现。
 * 宿主目录逐 provider 调 `ctx.llm.listModels` 末了滤掉模型数为 0 的组，故只在 `listModels` 上遮一层：命中返回空清单、否则直通，前端零改动。
 * 判定逐次实时现算，不监听事件。契约见 `docs/host-api.md`，取舍见 `docs/decisions.md` */
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { PLUGIN_NAME } from '@/shared/constants'
import { errorText } from '@/shared/errors'
import { isPlainObject } from '@/shared/types'
import { descriptorOf, sectionOf } from '@/section'
import { getConfig } from '@/config'

/** 要按密钥配置情况隐藏的官方提供方名单（后续扩充只改这里） */
const HIDDEN_OFFICIAL_PROVIDERS: readonly string[] = ['deepseek-official']

/** 官方适配器在未显式配置 apiKeyEnv 时实际回退使用的环境变量名（与其 Config 默认值一致） */
const DEFAULT_OFFICIAL_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** 沿 settingsPath 逐级收窄段，任一级不是普通对象即 undefined（走法与宿主模型页的密钥判定一致）。纯函数 */
export function resolveProfile(segment: unknown, settingsPath: readonly string[]): Record<string, unknown> | undefined {
    let profile: unknown = segment
    for (const key of settingsPath) {
        if (!isPlainObject(profile)) return undefined
        profile = profile[key]
    }
    return isPlainObject(profile) ? profile : undefined
}

/** 该提供方的凭据引用名：profile 显式声明的 apiKeyEnv 优先，否则回退官方适配器默认名。纯函数 */
export function apiKeyEnvOf(profile: Record<string, unknown> | undefined): string {
    const ref = profile?.apiKeyEnv
    return typeof ref === 'string' && ref.length > 0 ? ref : DEFAULT_OFFICIAL_API_KEY_ENV
}

/** 该提供方本次是否判为「未配置密钥」：目录取 settingsNs/settingsPath → 段上 apiKeyEnv → 凭据 describe */
async function isUnconfigured(ctx: Context, provider: string): Promise<boolean> {
    const entry = ctx.llm.listConfigurableProviders().find((row) => row.provider === provider)
    if (!entry) return false // 目录里没有该提供方即无从判定，照常显示
    const section = sectionOf(descriptorOf(ctx, entry.settingsNs))
    const ref = apiKeyEnvOf(resolveProfile(section, entry.settingsPath))
    if (!isCredentialRefName(ref)) return false // 引用名不合法时不猜（照常显示），宿主 describe 会抛
    try {
        const info = await ctx.credentials.describe(credentialRef(ref))
        return info.configured === false
    } catch (error) {
        ctx.logger.warn(`${PLUGIN_NAME}: 读取 ${provider} 的凭据状态失败（本次不隐藏）：${errorText(error)}`)
        return false
    }
}

/** 实时判定某提供方本次是否该被隐藏：开关开 + 名单命中 + 未配置密钥，三者缺一即放行（展示层诉求，判不准宁可照常显示）；每次目录生成时现算，不缓存、不监听事件 */
async function isHiddenNow(ctx: Context, provider: string): Promise<boolean> {
    if (!HIDDEN_OFFICIAL_PROVIDERS.includes(provider)) return false
    if (!getConfig().userExperience.hideOfficial) return false
    return isUnconfigured(ctx, provider)
}

/** 本层遮蔽的品牌标记：`Symbol.for` 全局注册，HMR 重载后同字符串仍是同一 Symbol */
const HIDDEN_LAYER = Symbol.for('model-fix.official-hidden')

/** 带品牌标记的遮蔽层：`in` 探测与赋值共用这个面 */
interface HiddenLayer {
    (provider: string): Promise<LlmModelInfo[]>
    [HIDDEN_LAYER]?: boolean
}

/** 装上官方提供方过滤：把 `ctx.llm` 的 `listModels` 遮成「命中隐藏即返回空清单」的一层。
 * 链式遮蔽是特性（卸载不动服务上的属性——后装插件记住的 original 正是我们的 wrapped，动属性会抹掉别人的遮蔽）；
 * wrapped 捕获的 ctx 在 fiber dispose 后失活，用 `ctx.fiber.store` 作守卫；HMR 重载整函数重跑，靠品牌标记幂等。理由见 docs/decisions.md「宿主与卡片」 */
export function installOfficialFilter(ctx: Context): void {
    const llm = ctx.llm
    const original = llm.listModels
    if (HIDDEN_LAYER in original) return
    const wrapped: HiddenLayer = async (provider) => {
        if (ctx.fiber.store && await isHiddenNow(ctx, provider)) return []
        return original.call(llm, provider)
    }
    wrapped[HIDDEN_LAYER] = true
    llm.listModels = wrapped
}
