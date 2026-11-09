import type { Context } from '@deepseek-ai/cordis'
import { logLine } from '@/log'
import { PLUGIN_NAME } from '@/shared/constants'

/** 写回路径的生命周期守卫（原先散在 26 处的裸 `ctx.fiber.store`）。
 *
 * 为什么不再直接看 `ctx.fiber.store`：cordis 4 里它是「依赖实现快照」，装载开始时赋值、`_unload()` 时
 * 置 `undefined`，所以「undefined ⇒ 已卸载」在那一刻成立。但**宿主不保证提供这个字段**——DSH 0.2.1-rc.5
 * 实测 `fiber.store` 一直是 undefined：于是 26 处守卫全部在第一步退出，启动链不读缓存、填充不写、拉取不落盘，
 * 而且一条日志都没有（`ctx.logger.warn` 也落不进任何文件）。故障现象是「插件看起来活着，什么都没做」。
 *
 * 故判据改成：**只有明确的假才算卸载**。字段缺失时按「无法判定、继续执行」处理——真正的写回失败各自有
 * catch 与告警，代价远小于整条链静默死掉。第一次遇到缺失时留一条告警，便于下次定位。 */
export function alive(ctx: Context): boolean {
    const fiber = (ctx as { fiber?: { store?: unknown } }).fiber
    // 连 fiber 都没有：这不是「无法判定」，是调用方拿错了 ctx
    if (fiber === undefined || fiber === null) return false
    if (fiber.store === undefined) {
        noteMissingStore(ctx)
        return true
    }
    return Boolean(fiber.store)
}

/** 缺失告警只打一次：这是每进程一次的环境事实，不是每次写回都该刷屏的事件 */
let warned = false

function noteMissingStore(ctx: Context): void {
    if (warned) return
    warned = true
    const message = `${PLUGIN_NAME}: 宿主未提供 ctx.fiber.store（依赖快照），按“仍在装载”继续执行`
    const logger = (ctx as { logger?: { warn?: (message: string) => void } }).logger
    logger?.warn?.(message)
    logLine(message)
}

/** 仅供测试：复位「已告警」标记，让同一进程内的多条用例都能验证告警路径 */
export function resetLifecycleWarning(): void {
    warned = false
}
