// src/refresh.ts 用例：cancelRefreshRetry 的卸载清理——重试等待期须复位 refreshing，在途拉取时不复位
import type { Context } from '@deepseek-ai/cordis'
import { cancelRefreshRetry, refreshIfStale } from '@/refresh'
import { isIgnoreAll } from '@/guard'
import { makeStubCtx } from '@test/ctx'
import { check } from '@test/helper'

/** 排空微任务，让 fetchLatest 的续体（.then/.catch）跑完 */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

/** 全局 fetch 桩：记录调用次数，按剧本应答；restore 还原原实现 */
function stubFetch(reply: () => Promise<Response>): { count: () => number; restore: () => void } {
    const original = globalThis.fetch
    let count = 0
    globalThis.fetch = (() => { count++; return reply() }) as unknown as typeof fetch
    return { count: () => count, restore: () => { globalThis.fetch = original } }
}

/** 恒失败的 fetch 剧本：拉取落进 .catch，走「记一次告警 + 设重试定时器」那条分支 */
const failing = () => Promise.reject<Response>(new Error('offline'))

/** 永不自动结算的 fetch 剧本：拉取停在途（此时没有重试定时器，refreshing 归在途路径管） */
function pending(): { reply: () => Promise<Response>; fail: () => void } {
    let reject: ((error: Error) => void) | undefined
    const gate = new Promise<Response>((_resolve, onError) => { reject = onError })
    return { reply: () => gate, fail: () => reject?.(new Error('offline')) }
}

/** 执行本文件的全部用例 */
export async function run(): Promise<void> {
    // 前置：refresh 入口会被事件流守卫短路，守卫开着则测不到目标分支
    check('refresh 用例的前置：事件流守卫处于关闭态', isIgnoreAll() === false)

    // ---------- 在途拉取时卸载：不复位 refreshing（复位会破坏单飞） ----------
    {
        const ctx = makeStubCtx() as unknown as Context
        const gate = pending()
        const fetchStub = stubFetch(gate.reply)
        refreshIfStale(ctx)
        await settle()
        cancelRefreshRetry()
        refreshIfStale(ctx)
        await settle()
        check('拉取在途时 cancelRefreshRetry 不复位 refreshing（无重试定时器可清，单飞不被破坏）',
            fetchStub.count() === 1, fetchStub.count())
        // 收尾：在途请求落进失败分支并设下重试定时器，须再清一次
        gate.fail()
        await settle()
        cancelRefreshRetry()
        fetchStub.restore()
    }

    // ---------- 重试等待期卸载：必须复位 refreshing，否则本进程再也拉不动 models.dev ----------
    {
        const ctx = makeStubCtx() as unknown as Context
        const fetchStub = stubFetch(failing)
        refreshIfStale(ctx)
        await settle()
        refreshIfStale(ctx)
        await settle()
        check('拉取失败进入重试等待后，refreshing 保持置位（单飞未解除）', fetchStub.count() === 1, fetchStub.count())

        cancelRefreshRetry()
        refreshIfStale(ctx)
        await settle()
        check('重试等待期卸载后重新拉取不再被 refreshing 永久早退', fetchStub.count() === 2, fetchStub.count())

        // 收尾：第二次拉取同样落进失败分支，定时器与在途标志一并清掉
        cancelRefreshRetry()
        fetchStub.restore()
    }
}