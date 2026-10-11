import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 宿主 HMR 事务感知的通用执行原语：把 task 从宿主事务的 AsyncLocalStorage 上下文中摘出执行，
 * 无论从哪条链调用（事件响应、RPC、启动链）都不会因事务嵌套失败。
 * hmr 服务经 `src/index.ts` 的子 fiber 注入，而其装载是异步的——注入落地前的写回若直接降级，
 * 就会裸跑进宿主事务的上下文（写入判定抖动窗口）。故首个写回在收口处**有界等待**注入落地：
 * 落地（值缺席也算落地，降级判定在等待之后）即放行；等待有单一上限，超时（hmr 被禁用等）才降级
 * 为裸 task()，且只等这一次、绝不挂死——hmr 不进组件级 inject（PENDING 无超时），依赖面与
 * 超时后的降级行为均与历史一致。裁决见 docs/decisions.md「写回端点」。
 */

let _hmrExecuting: unknown | undefined

/** 注入落地信号：setHmrExecuting 首次调用即 resolve */
let signalHmrInjected: () => void = () => {}
const hmrInjected = new Promise<void>((resolve) => { signalHmrInjected = resolve })

/** 有界等待上限：与 migrate 的 NS 注册轮询同量级（同为宿主 boot 期的异步装载） */
const HMR_WAIT_MS = 2000

/** 单一计时器（模块加载即起算，早于一切写回）；unref 防测试进程为它多挂 2s */
const hmrWait = new Promise<void>((resolve) => { setTimeout(resolve, HMR_WAIT_MS).unref() })

/** 等待已结算（注入落地或超时降级）：只等一次，之后的写回零等待开销 */
let hmrSettled = false

/** 由 `src/index.ts` 的子 fiber 设置 hmr 执行上下文（缺席时为 undefined）；首次调用即解除等待 */
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
