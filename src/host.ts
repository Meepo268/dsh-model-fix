import { AsyncLocalStorage } from 'node:async_hooks'

/** 把写回 task 摘出宿主 HMR 事务的 AsyncLocalStorage 上下文执行；注入落地前的有界等待与时限见 docs/decisions-config.md「写回端点」 */

let _hmrExecuting: unknown | undefined

/** 注入落地信号：setHmrExecuting 首次调用即 resolve */
let signalHmrInjected: () => void = () => {}
const hmrInjected = new Promise<void>((resolve) => { signalHmrInjected = resolve })

const HMR_WAIT_MS = 2000

/** 单一计时器（模块加载即起算）；unref 防测试进程为它多挂 2s */
const hmrWait = new Promise<void>((resolve) => { setTimeout(resolve, HMR_WAIT_MS).unref() })

/** 等待已结算（注入落地或超时降级）：只等一次，之后写回零等待开销 */
let hmrSettled = false

/** 由 `src/index.ts` 的子 fiber 设置 hmr 执行上下文（缺席为 undefined）；首次调用即解除等待 */
export function setHmrExecuting(value: unknown | undefined): void {
    _hmrExecuting = value
    hmrSettled = true
    signalHmrInjected()
}

export async function queueTask<T>(task: () => Promise<T>): Promise<T> {
    if (!hmrSettled) {
        await Promise.race([hmrInjected, hmrWait])
        hmrSettled = true
    }
    const als = _hmrExecuting
    return als instanceof AsyncLocalStorage ? als.exit(task) : task()
}
