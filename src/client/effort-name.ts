/**
 * 浏览器半的界面语言上报：启动时把当前界面语言经 RPC 告知 Node 半。
 *
 * 换名本体在 Node 半（`src/effort-name.ts` 遮 `resolveModelInfo`，全链覆盖），但 Node 侧没有
 * `locale` 服务、读不到浏览器的自动探测语言。用户显式选择过语言时偏好已落盘（宿主 settings 文档的
 * `locale.preference`），Node 可直读；未显式选择（多数场景）时由本模块在启动时上报探测结果，
 * 补齐 Node 的盲区——不上报即视为 en，Node 侧安全回退、不换名。
 *
 * 单独成文件与 memory-listener 同理：入口管注册，本文件管一项运行时行为。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// ctx.locale 服务面（LocaleRuntime）
import type {} from '@deepseek-ai/dsh-client-locale/client'
// ctx.connection 服务面（ClientConnectionRpc）
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { PLUGIN_NS } from '@/shared/constants'

/** Node 半的 locale 上报端点名（与 `src/effort-name.ts` 的 `ENDPOINT_REPORT_LOCALE` 同字面量） */
const ENDPOINT_REPORT_LOCALE = 'reportLocale'

/**
 * 启动时把界面语言上报给 Node 半：子 fiber 声明 `locale` + `connection`，两者装载即上报一次。
 * 上报失败静默——Node 侧会回退 en（不换名），不因这条诊断链影响会话。
 * @param ctx - 父 fiber 的 ctx
 */
export function applyLocaleReporter(ctx: ClientContext): void {
    ctx.inject(['locale', 'connection'], (child) => {
        const locale = child.locale.getSnapshot().active
        const rpc = (child.get('connection') as unknown as { rpc: ClientConnectionRpc }).rpc
        void rpc.call(`/${PLUGIN_NS}`, ENDPOINT_REPORT_LOCALE, locale).catch(() => {})
    })
}
