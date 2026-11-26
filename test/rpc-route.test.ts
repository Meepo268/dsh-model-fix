// rpc-route.ts 纯逻辑测试：endpoint 切分 / 信封解析与构造 / 自注册路由的围栏、状态码与信封往返
import type { IncomingMessage, ServerResponse } from 'node:http'
import { check, stable } from '@test/helper'
import { createChannelRoute, endpointOf, envelopeRpcId, parseClientRequest, serverResponse } from '@/rpc-route'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'

const CHANNEL = '/tikaflow-model-fix'

/** 最小 node:http 请求桩：构造后由微任务派发 data/end（或 error）；pause 记录到 paused 供超限用例断言 */
function fakeRequest(init: { method?: string; url?: string; contentType?: string | string[]; body?: string; failBody?: boolean }): IncomingMessage & { paused: boolean } {
    const listeners: Record<string, ((arg: never) => void)[]> = {}
    const req = {
        paused: false,
        method: init.method ?? 'POST',
        url: init.url ?? `${CHANNEL}/forceUpdate`,
        headers: { 'content-type': init.contentType ?? 'application/json' },
        on(event: string, listener: (arg: never) => void) {
            ;(listeners[event] ??= []).push(listener)
            return req
        },
        pause() {
            req.paused = true
        },
    }
    queueMicrotask(() => {
        if (init.failBody) {
            for (const listener of listeners.error ?? []) listener(new Error('socket hang up') as never)
            return
        }
        if (init.body !== undefined) for (const listener of listeners.data ?? []) listener(Buffer.from(init.body) as never)
        for (const listener of listeners.end ?? []) listener(undefined as never)
    })
    return req as unknown as IncomingMessage & { paused: boolean }
}

/** 最小 node:http 响应桩：记录状态码与响应体 */
function fakeResponse(): ServerResponse & { status: number; body: string | undefined } {
    const res = {
        status: 0,
        body: undefined as string | undefined,
        writeHead(status: number) {
            res.status = status
            return res
        },
        end(body?: string) {
            res.body = body
        },
    }
    return res as unknown as ServerResponse & { status: number; body: string | undefined }
}

/** 造一个请求信封 JSON 体 */
const envelope = (rpcId: string, method: string, payload: unknown = {}): string => JSON.stringify({ type: 'client-request', rpcId, method, payload })

/** 路由处理器是异步的，故本模块为 async */
export async function run(): Promise<void> {
    // ---------- endpointOf ----------
    check('endpointOf 命中单段端点', endpointOf(`${CHANNEL}/forceUpdate`, CHANNEL) === 'forceUpdate')
    check('endpointOf 命中多段端点', endpointOf(`${CHANNEL}/a/b`, CHANNEL) === 'a/b')
    check('endpointOf 前缀不符返回 undefined', endpointOf('/other/forceUpdate', CHANNEL) === undefined)
    check('endpointOf 只有前缀无端点返回 undefined', endpointOf(CHANNEL, CHANNEL) === undefined && endpointOf(`${CHANNEL}/`, CHANNEL) === undefined)
    check('endpointOf 空段返回 undefined', endpointOf(`${CHANNEL}/a//b`, CHANNEL) === undefined)
    check('endpointOf 点段返回 undefined', endpointOf(`${CHANNEL}/.`, CHANNEL) === undefined && endpointOf(`${CHANNEL}/..`, CHANNEL) === undefined)
    // 与宿主 ENDPOINT_SEGMENT_PATTERN 同严格度：空格、斜杠编码、非 ASCII 一律拒绝
    check('endpointOf 非法字符返回 undefined', endpointOf(`${CHANNEL}/a b`, CHANNEL) === undefined && endpointOf(`${CHANNEL}/中`, CHANNEL) === undefined)

    // ---------- parseClientRequest ----------
    check('parseClientRequest 正常解析', stable(parseClientRequest({ type: 'client-request', rpcId: 'r1', method: 'forceUpdate', payload: { a: 1 } })) === stable({ rpcId: 'r1', method: 'forceUpdate', payload: { a: 1 } }))
    check('parseClientRequest payload 缺失也为 undefined 值', parseClientRequest({ type: 'client-request', rpcId: 'r1', method: 'm' })?.payload === undefined)
    for (const junk of [undefined, null, 42, 'x', [], {}, { type: 'server-response', rpcId: 'r', method: 'm' }, { type: 'client-request', rpcId: 1, method: 'm' }, { type: 'client-request', rpcId: 'r', method: 2 }]) {
        check(`parseClientRequest 垃圾输入返回 undefined ${stable(junk)}`, parseClientRequest(junk) === undefined, junk)
    }

    // ---------- serverResponse / envelopeRpcId ----------
    check('serverResponse 构造信封', stable(serverResponse('r1', { ok: true, value: { changed: 2 } })) === stable({ type: 'server-response', rpcId: 'r1', result: { ok: true, value: { changed: 2 } } }))
    check('envelopeRpcId 回显字符串 rpcId', envelopeRpcId({ rpcId: 'r9' }) === 'r9')
    check('envelopeRpcId 非字符串回落占位', envelopeRpcId({ rpcId: 9 }) === 'invalid-request' && envelopeRpcId(null) === 'invalid-request' && envelopeRpcId('x') === 'invalid-request')

    // ---------- createChannelRoute ----------
    const okHandler = async (endpoint: string, payload: unknown): Promise<ConnectionRpcResult<unknown>> => ({ ok: true, value: { endpoint, payload } })
    /** 围栏桩：`undefined` 表示这一版宿主连程序化围栏都没有（只能靠路由 auth 的 peer） */
    const denying = (status: number) => () => status

    const runRoute = async (
        fence: Parameters<typeof createChannelRoute>[0],
        init: Parameters<typeof fakeRequest>[0],
        handler?: typeof okHandler,
        peer?: unknown,
    ) => {
        const res = fakeResponse()
        await createChannelRoute(fence, CHANNEL, handler ?? okHandler)(fakeRequest(init), res, peer)
        return res
    }

    // 围栏：与宿主 /api 同源——非受信 403、未认证 401、认证源不可用 503，且都不触碰端点
    const forbidden = await runRoute(denying(403), {})
    check('围栏 403 时拒答且不派发端点', forbidden.status === 403 && forbidden.body === 'forbidden')
    const unauthorized = await runRoute(denying(401), {})
    check('围栏 401 时回 unauthorized', unauthorized.status === 401 && unauthorized.body === 'unauthorized')
    const unavailable = await runRoute(denying(503), {})
    check('围栏 503 时回 unavailable', unavailable.status === 503 && unavailable.body === 'unavailable')
    const admitted = await runRoute(() => undefined, { body: envelope('r1', 'forceUpdate') })
    check('围栏放行时正常往返', admitted.status === 200)

    // 宿主不提供程序化围栏：认证结果只体现为路由 auth 传进来的 peer 是否存在
    const noPeer = await runRoute(undefined, {})
    check('无围栏且缺 peer 回 401 且不派发端点', noPeer.status === 401 && noPeer.body === 'unauthorized')
    check('无围栏但带 peer 正常往返', (await runRoute(undefined, { body: envelope('r1', 'forceUpdate') }, undefined, { id: 'owner' })).status === 200)

    // 传输层前置校验（镜像宿主 rpcFetchHandler 的状态码）
    const authed = { id: 'owner' }
    check('非 POST 回 404', (await runRoute(undefined, { method: 'GET' }, undefined, authed)).status === 404)
    check('content-type 非 json 回 415', (await runRoute(undefined, { contentType: 'text/plain' }, undefined, authed)).status === 415)
    check('content-type 带 charset 参数仍接受', (await runRoute(undefined, { contentType: 'application/json; charset=utf-8', body: envelope('r1', 'forceUpdate') }, undefined, authed)).status === 200)
    check('content-type 数组取首项', (await runRoute(undefined, { contentType: ['application/json'], body: envelope('r1', 'forceUpdate') }, undefined, authed)).status === 200)
    check('请求体非 JSON 回 400', (await runRoute(undefined, { body: 'not json' }, undefined, authed)).status === 400)
    check('读体失败回 413', (await runRoute(undefined, { failBody: true }, undefined, authed)).status === 413)
    // 超限（对齐 rpc-route 的 64KB 上限）：回 413 且请求流被暂停停读
    const oversizeReq = fakeRequest({ body: 'x'.repeat(64 * 1024 + 1) })
    const oversizeRes = fakeResponse()
    await createChannelRoute(undefined, CHANNEL, okHandler)(oversizeReq, oversizeRes, authed)
    check('读体超限回 413 且暂停请求流', oversizeRes.status === 413 && oversizeReq.paused)
    check('路径越界回 404', (await runRoute(undefined, { url: '/other/x', body: envelope('r1', 'x') }, undefined, authed)).status === 404)

    // 信封不合法：回 200 + gateway/bad-request，并尽量回显 rpcId
    const badEnvelope = await runRoute(undefined, { body: JSON.stringify({ rpcId: 'r7', nope: true }) }, undefined, authed)
    check('信封不合法回 bad-request 且回显 rpcId', badEnvelope.status === 200 && stable(JSON.parse(badEnvelope.body ?? '')) === stable(serverResponse('r7', { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} } })), badEnvelope.body)
    const badEnvelopeNoId = await runRoute(undefined, { body: JSON.stringify({ nope: true }) }, undefined, authed)
    check('信封不合法且无 rpcId 用占位', JSON.parse(badEnvelopeNoId.body ?? '').rpcId === 'invalid-request', badEnvelopeNoId.body)

    // method 与路径不一致：回 bad-request
    const mismatch = await runRoute(undefined, { body: envelope('r1', 'resetModels') }, undefined, authed)
    check('method 与端点不一致回 bad-request', mismatch.status === 200 && JSON.parse(mismatch.body ?? '').result.error.code === 'gateway/bad-request', mismatch.body)

    // 正常往返：端点与 payload 原样送达，rpcId 原样回显
    const ok = await runRoute(undefined, { body: envelope('r42', 'forceUpdate', { ignored: true }) }, undefined, authed)
    check('正常往返回 server-response 且回显 rpcId', ok.status === 200 && stable(JSON.parse(ok.body ?? '')) === stable(serverResponse('r42', { ok: true, value: { endpoint: 'forceUpdate', payload: { ignored: true } } })), ok.body)

    // 端点抛错：宿主同款 500
    const throwing = await runRoute(undefined, { body: envelope('r1', 'forceUpdate') }, async () => { throw new Error('boom') }, authed)
    check('端点抛错回 500', throwing.status === 500 && (throwing.body ?? '').includes('boom'), throwing.body)
}
