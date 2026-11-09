// lifecycle.ts 测试：写回守卫的「只有明确的假才算卸载」语义
// 背景：DSH 0.2.1-rc.5 的 ctx.fiber.store 一直是 undefined，旧守卫（直接读 fiber.store）在第一步就退出，
// 导致启动链不读缓存、填充不写、拉取不落盘，且一条日志都没有。这里锁住三条判据。
import type { Context } from '@deepseek-ai/cordis'
import { alive, resetLifecycleWarning } from '@/lifecycle'
import { check } from '@test/helper'

/** 造一个只带守卫所需字段的 ctx：logging 由插件自己在 noteMissingStore 里做，这里只提供 warn 计数 */
function ctxWith(fiber: unknown, warnings: string[] = []): Context {
    const ctx = {
        fiber,
        logger: { warn: (message: string) => { warnings.push(message) } },
    }
    return ctx as unknown as Context
}

export function run(): void {
    // ① store 缺失（宿主不提供该字段）：无法判定，按「仍在装载」继续执行，并只告警一次
    resetLifecycleWarning()
    const warnings: string[] = []
    check('store 缺失时继续执行', alive(ctxWith({}, warnings)) === true)
    check('store 缺失时留一条告警', warnings.length === 1)
    check('告警提到 fiber.store', (warnings[0] ?? '').includes('fiber.store'))
    check('同一进程内不重复告警', alive(ctxWith({}, warnings)) === true && warnings.length === 1)

    // ② store 有值：正常放行
    resetLifecycleWarning()
    check('store 为对象时继续执行', alive(ctxWith({ store: {} })) === true)
    check('store 为真值时继续执行', alive(ctxWith({ store: true })) === true)

    // ③ store 明确的假：认定已卸载，不写回（fiber 存在但 store 为 null 也算卸载语义）
    resetLifecycleWarning()
    check('store 为 null 时视为卸载', alive(ctxWith({ store: null })) === false)

    // ④ 连 fiber 都没有：调用方拿错了 ctx，不是「无法判定」
    resetLifecycleWarning()
    check('fiber 缺失时视为卸载', alive(ctxWith(undefined)) === false)
    check('fiber 为 null 时视为卸载', alive(ctxWith(null)) === false)

    // ⑤ 复位开关只影响告警次数，不影响判定
    resetLifecycleWarning()
    const again: string[] = []
    alive(ctxWith({}, again))
    alive(ctxWith({}, again))
    check('复位后仍只告警一次', again.length === 1)
}
