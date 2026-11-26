// rpc.ts 进度流测试：以标准 Request/Response 驱动 progressStreamFetch，覆盖正常发帧、异常发 failed 终帧、中止不发终帧与非法请求体；另测 fenceOf 对两代宿主围栏 API 的适配
import type { IncomingMessage } from 'node:http'
import { check, stable } from '@test/helper'
import { fenceOf, progressStreamFetch, registerHostChannel } from '@/rpc'
import type { EndpointHandler } from '@/rpc-route'
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

    // ---------- fenceOf：两代宿主围栏 API 的适配 ----------
    const req = { headers: { host: '127.0.0.1:2718' }, method: 'POST', url: '/tikaflow-model-fix/sources', socket: { destroyed: false } } as unknown as IncomingMessage
    // 0.2.3-alpha 起：admit 返回 { rejection } 即拒、返回 { peer } 即放行，请求字段原样转交
    let seen: unknown
    const admitted = fenceOf({ admit: (request: unknown) => { seen = request; return { peer: { id: 'owner' } } } })
    check('fenceOf 用 admit 放行时返回 undefined', admitted?.(req) === undefined)
    check('fenceOf 把 headers/method/url/socket 转给 admit', stable(seen) === stable({ headers: { host: '127.0.0.1:2718' }, method: 'POST', url: '/tikaflow-model-fix/sources', socket: { destroyed: false } }), stable(seen))
    check('fenceOf 用 admit 的 rejection 拒答', fenceOf({ admit: () => ({ rejection: 401 }) })?.(req) === 401)
    check('fenceOf 用 admit 的 503 拒答', fenceOf({ admit: () => ({ rejection: 503 }) })?.(req) === 503)
    check('fenceOf 在 admit 抛错时 fail closed 回 403', fenceOf({ admit: () => { throw new Error('boom') } })?.(req) === 403)
    // 旧宿主：requestRejection
    check('fenceOf 用 requestRejection 拒答', fenceOf({ requestRejection: () => 403 })?.(req) === 403)
    check('fenceOf 用 requestRejection 放行时返回 undefined', fenceOf({ requestRejection: () => undefined })?.(req) === undefined)
    // 同时存在时优先 admit（新宿主的判定口径）
    check('fenceOf 同时存在时优先 admit', fenceOf({ admit: () => ({ rejection: 401 }), requestRejection: () => 403 })?.(req) === 401)
    // 两样都没有：留给路由按 auth 传进来的 peer 判定
    check('fenceOf 两代 API 都没有时返回 undefined', fenceOf({ fetch: {} }) === undefined)

    // ---------- registerHostChannel：优先挂宿主的 channel 注册表 ----------
    const plainHandler: EndpointHandler = async () => ({ ok: true, value: {} })
    let handled: { channel: string; endpoint?: string } = { channel: '' }
    const disposeHost = registerHostChannel(
        { rpc: { handle: (channel: string, handler: (endpoint: string, payload: unknown) => Promise<unknown>) => { handled = { channel }; void handler; return async () => {} } } },
        '/tikaflow-model-fix',
        plainHandler,
    )
    check('registerHostChannel 优先用 connection.rpc.handle 并回 disposer', handled.channel === '/tikaflow-model-fix' && typeof disposeHost === 'function')
    disposeHost?.()
    // 旧宿主：get rpc 抛错或没有 handle → undefined，交给自建路由兜底
    check('registerHostChannel 在取 rpc 抛错时回 undefined', registerHostChannel({ get rpc(): never { throw new Error('no webServer') } }, '/tikaflow-model-fix', plainHandler) === undefined)
    check('registerHostChannel 在没有 handle 时回 undefined', registerHostChannel({ rpc: {} }, '/tikaflow-model-fix', plainHandler) === undefined)
    check('registerHostChannel 在 handle 抛错时回 undefined', registerHostChannel({ rpc: { handle: () => { throw new Error('boom') } } }, '/tikaflow-model-fix', plainHandler) === undefined)
}
