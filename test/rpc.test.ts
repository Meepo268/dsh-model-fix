// rpc.ts 进度流测试：以标准 Request/Response 驱动 progressStreamFetch，覆盖正常发帧、异常发 failed 终帧、中止不发终帧与非法请求体
import { check } from '@test/helper'
import { progressStreamFetch } from '@/rpc'
import { endIgnoreAll, isIgnoreAll, startIgnoreAll } from '@/guard'
import type { ProbeRunOptions } from '@/probe-engine'
import type { VerifyProgressFrame, VerifySummary } from '@/shared/verify-progress'

/** 最小 VerifySummary：只为让 done 帧有形状可发 */
const SUMMARY: VerifySummary = {
    providers: [],
    models: 0,
    tested: 0,
    efforts: 0,
    unsupported: 0,
    plannedEfforts: 0,
    planned: 0,
    probed: 0,
    results: [],
    unsupportedEfforts: [],
    usableEfforts: [],
}

/** 造一个带 JSON 体的 POST 请求 */
function request(body: unknown): Request {
    return new Request('http://localhost/api/tikaflow-model-fix/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
}

/** 读尽响应流并按 SSE 空行分帧取回各帧 */
async function framesOf(response: Response): Promise<VerifyProgressFrame[]> {
    const text = await response.text()
    const frames: VerifyProgressFrame[] = []
    for (const block of text.split('\n\n')) {
        if (!block.startsWith('data: ')) continue
        frames.push(JSON.parse(block.slice('data: '.length)) as VerifyProgressFrame)
    }
    return frames
}

export async function run(): Promise<void> {
    // ---------- 正常路径：执行器发的帧原样转发 ----------
    const okFetch = progressStreamFetch((_payload, options: ProbeRunOptions) => {
        options.onProgress?.({ type: 'opened', total: 2 })
        options.onProgress?.({ type: 'done', summary: SUMMARY })
        return Promise.resolve(SUMMARY)
    })
    const okFrames = await framesOf(await okFetch(request({ models: [] })))
    check('进度流正常路径转发 opened 与 done', okFrames.length === 2
        && okFrames[0].type === 'opened' && okFrames[1].type === 'done', okFrames)

    // ---------- 异常路径：执行器抛错（入参非法 / 超配额）须发 failed 终帧带真实原因，而不是空流 ----------
    const failFetch = progressStreamFetch(() => Promise.reject(new Error('tikaflow-model-fix: 验证请求不合法（超出上限）')))
    const failFrames = await framesOf(await failFetch(request({ models: [] })))
    check('进度流异常终止发 failed 终帧并带出原因', failFrames.length === 1
        && failFrames[0].type === 'failed' && failFrames[0].message === 'tikaflow-model-fix: 验证请求不合法（超出上限）', failFrames)

    // ---------- 中止路径：客户端已断开（signal 已 abort）不发 failed——用户点停止不是失败 ----------
    const controller = new AbortController()
    controller.abort()
    const abortedFetch = progressStreamFetch((_payload, options: ProbeRunOptions) => {
        // 执行器收到的就是 request.signal；已 abort 时不该发终帧
        check('中止时执行器收到的是已 abort 的 signal', options.signal?.aborted === true)
        return Promise.reject(new Error('aborted'))
    })
    const abortedRequest = new Request('http://localhost/api/tikaflow-model-fix/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ models: [] }),
        signal: controller.signal,
    })
    const abortedFrames = await framesOf(await abortedFetch(abortedRequest))
    check('中止不发 failed 终帧（消费方据无终帧判中止）', abortedFrames.length === 0, abortedFrames)

    // ---------- 入参非法：请求体不是 JSON 即 400，不进执行器 ----------
    let ran = false
    const badBody = progressStreamFetch(() => {
        ran = true
        return Promise.resolve(SUMMARY)
    })
    const badResponse = await badBody(new Request('http://localhost/api/tikaflow-model-fix/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
    }))
    check('非法请求体回 400 且不执行', badResponse.status === 400 && !ran, badResponse.status)

    // ---------- 探测流（needsIdleGuard）的守卫互斥：守卫已开即 409，不进执行器 ----------
    let probeRan = false
    const probeFetch = progressStreamFetch(() => {
        probeRan = true
        return Promise.resolve(SUMMARY)
    }, true)
    startIgnoreAll()
    const busy = await probeFetch(request({ models: [] }))
    endIgnoreAll()
    check('探测流在守卫已开时回 409 且不执行', busy.status === 409 && !probeRan, busy.status)
    check('守卫互斥判定不遗留守卫状态', isIgnoreAll() === false)
}
