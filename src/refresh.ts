import type { Context } from '@deepseek-ai/cordis'
import { fetchLatest, setCatalog } from '@/catalog'
import { MAX_ATTEMPTS, REFRESH_INTERVAL_MS, RETRY_DELAY_MS } from '@/constants'
import { PLUGIN_NAME } from '@/shared/constants'
import { errorText } from '@/shared/errors'
import { fix } from '@/fix'
import { isIgnoreAll } from '@/guard'

// 拉取生命周期状态：时间戳只在成功时更新（失败路径不封保鲜窗口，下一次用户事件即可重试自愈）；
// 在途守卫防止连续事件叠加拉取
let lastRefreshAt = 0
let refreshing = false
// 重试定时器 id：卸载路径须 clearTimeout——回调闭包持有 ctx，且 refreshing 是模块级单例，
// 旧定时器在新实例拉取在途时触发会把它误清为 false，破坏单飞不变量
let retryTimer: ReturnType<typeof setTimeout> | undefined

/** 距上次成功拉取超过保鲜窗口且无在途拉取时才真正拉取（长期不重启的保鲜路径，由模型配置变更事件驱动） */
export function refreshIfStale(ctx: Context): void {
    const isFresh = Date.now() - lastRefreshAt < REFRESH_INTERVAL_MS
    if (refreshing || isFresh) return
    refresh(ctx)
}

function refresh(ctx: Context, retryCount = MAX_ATTEMPTS): void {
    // 单飞不变量在此兜底：进入时若已有拉取在途就直接返回，保证同一时刻只有一个 refresh 流程——
    // 否则并发在途的响应可能后发先至、把较旧的目录覆盖回去。依赖调用方先判 refreshing 不够（新增调用点极易漏判），此行不可删。
    if (refreshing) return
    // 事件流守卫开启（写回在途）不启动拉取：本判定同时覆盖重试定时器触发路径
    if (isIgnoreAll()) return
    refreshing = true
    fetchLatest(ctx)
        .then((indexed) => {
            if (!ctx.fiber.store) {
                refreshing = false
                return
            }
            // 时间戳仅在成功时落定：失败不封保鲜窗口，网络恢复后的下一次事件即可自愈
            lastRefreshAt = Date.now()
            setCatalog(indexed)
            // 结算是不经过 index.ts 事件入口的异步续体，须在此自查守卫：写回在途期间结算的拉取若照常填充，
            // 会把刚删除的字段重新填回。目录与保鲜窗口照常更新，仅跳过填充
            if (isIgnoreAll()) {
                refreshing = false
                return
            }
            fix(ctx).catch((error) => {
                if (!ctx.fiber.store) return
                ctx.logger.warn(`${PLUGIN_NAME}: 填充失败：${errorText(error)}`)
            })
            refreshing = false
        })
        .catch((error) => {
            if (!ctx.fiber.store) {
                refreshing = false
                return
            }
            // 每次失败都记录，便于判断是一次成功还是重试后才成功
            const attempt = MAX_ATTEMPTS - retryCount + 1
            ctx.logger.warn(
                `${PLUGIN_NAME}: 拉取 models.dev 最新数据失败（第 ${attempt}/${MAX_ATTEMPTS} 次）：${errorText(error)}`,
            )
            // 剩余重试次数不足则放弃，交由后续事件或重启再触发
            if (--retryCount <= 0) {
                refreshing = false
                return
            }
            retryTimer = setTimeout(() => {
                retryTimer = undefined
                if (!ctx.fiber.store) {
                    refreshing = false
                    return
                }
                // 重试前复位在途守卫
                refreshing = false
                refresh(ctx, retryCount)
            }, RETRY_DELAY_MS)
        })
}

/** 卸载清理：取消待触发的重试定时器，并复位在途守卫——定时器存在即无在途拉取；
 * 不复位则 refreshing 永久为真，此后本进程再也不拉 models.dev。定时器不存在而 refreshing 为真是在途拉取，
 * 不复位（在途续体自行复位）。 */
export function cancelRefreshRetry(): void {
    if (retryTimer === undefined) return
    clearTimeout(retryTimer)
    retryTimer = undefined
    refreshing = false
}
