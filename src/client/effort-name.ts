/** 浏览器半的界面语言上报：启动时把当前界面语言经 RPC 告知 Node 半。
 * 换名本体在 Node 半（遮 `resolveModelInfo`，全链覆盖），但 Node 侧读不到浏览器的自动探测语言，故由本模块在启动时上报补齐（见 docs/decisions.md「宿主与卡片」）。不上报即视为 en，Node 侧安全回退、不换名 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// ctx.locale 服务面（LocaleRuntime）
import type {} from '@deepseek-ai/dsh-client-locale/client'
// ctx.connection 服务面（ClientConnectionRpc）
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { makeRpcCarrier } from '@/client/rpc-carrier'
import { MAX_ATTEMPTS } from '@/shared/constants'

/** 上报失败后的重报间隔（毫秒）：与宿主「等落定」的既有取值同量级（`HMR_WAIT_MS`、`MIGRATE_WAIT_MS`） */
const REPORT_RETRY_MS = 2_000

/** 启动时把界面语言上报给 Node 半：`locale` + `connection` 装载即上报，失败隔 `REPORT_RETRY_MS` 重报，至多 `MAX_ATTEMPTS` 次 */
export function applyLocaleReporter(ctx: ClientContext): void {
    ctx.inject(['locale', 'connection'], (child) => {
        const locale = child.locale.getSnapshot().active
        const rpc = (child.get('connection') as unknown as { rpc: ClientConnectionRpc }).rpc
        const { reportLocale } = makeRpcCarrier(rpc)
        void (async (): Promise<void> => {
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                try {
                    if ((await reportLocale(locale)).ok) return
                } catch {
                    // 抛错与 `ok: false` 同等：都算没送达
                }
                await new Promise((resolve) => setTimeout(resolve, REPORT_RETRY_MS))
            }
            console.warn(`report-locale: failed after ${MAX_ATTEMPTS} attempts`)
        })()
    })
}
