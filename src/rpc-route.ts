/** 浏览器↔宿主 channel 路由：自注册前缀路由而非宿主 `connection.rpc.handle`（后者在 connection 服务 ctx 上求值 `owner.webServer`，而 connection 不再注入它必抛）；
 * 信任围栏与信封字段、错误文案与宿主通道对齐，类型面全取宿主 devDep（type-only，构建期擦除） */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
    ConnectionRequestRejection,
    ConnectionRpcResult,
    HostConnectionService,
} from '@deepseek-ai/dsh-client-connection'

/** endpoint 段名允许的字符（宿主 ENDPOINT_SEGMENT_PATTERN 的字面复制） */
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/
/** 信封不合法且回显不出 rpcId 时的占位（宿主 INVALID_REQUEST_RPC_ID 的字面复制） */
const INVALID_RPC_ID = 'invalid-request'
/** 请求体上限：各端点的 payload 都是小对象，设上限防无界缓冲 */
const MAX_BODY_BYTES = 64 * 1024

/** 端点处理函数（与宿主 ConnectionRpcHandler 同形：省略只用于信任判定、浏览器侧用不到的 peer 参，返回值不带 attachments） */
export type EndpointHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ConnectionRpcResult<unknown>>

/** 从 channel 前缀路由的 pathname 切出 endpoint；前缀不符、空段、`.`/`..` 点段或非法字符返回 undefined */
export function endpointOf(pathname: string, channel: string): string | undefined {
    if (!pathname.startsWith(`${channel}/`)) return undefined
    const endpoint = pathname.slice(channel.length + 1)
    if (endpoint.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT.test(segment))) return undefined
    return endpoint
}

/** 解析客户端请求信封；形状不符返回 undefined */
export function parseClientRequest(value: unknown): { rpcId: string; method: string; payload: unknown } | undefined {
    if (typeof value !== 'object' || value === null) return undefined
    const { type, rpcId, method, payload } = value as Record<string, unknown>
    if (type !== 'client-request' || typeof rpcId !== 'string' || typeof method !== 'string') return undefined
    return { rpcId, method, payload }
}

export function serverResponse(rpcId: string, result: ConnectionRpcResult<unknown>): Record<string, unknown> {
    return { type: 'server-response', rpcId, result }
}

/** 信封不合法时的回执 id：能回显字符串 rpcId 就回显，否则用占位 */
export function envelopeRpcId(value: unknown): string {
    const rpcId = (value as { rpcId?: unknown } | null)?.rpcId
    return typeof rpcId === 'string' ? rpcId : INVALID_RPC_ID
}

/** 构造本 channel 的前缀路由处理器（围栏 → 方法/类型校验 → 读体 → 切端点 → 解信封与校验 method → 调 handler → 回信封） */
export function createChannelRoute(
    connection: Pick<HostConnectionService, 'requestRejection'>,
    channel: string,
    handler: EndpointHandler,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
    const respond = (res: ServerResponse, status: number, body: string): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(body)
    }
    const badRequest = (res: ServerResponse, rpcId: string, message: string): void => {
        respond(res, 200, JSON.stringify(serverResponse(rpcId, { ok: false, error: { code: 'gateway/bad-request', message, details: {} } })))
    }
    return async (req, res) => {
        // 与宿主 /api 路由同一把围栏：非受信来源 403、浏览器会话未认证 401
        const rejection: ConnectionRequestRejection = connection.requestRejection(req)
        if (rejection !== undefined) {
            res.writeHead(rejection)
            res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
            return
        }
        if (req.method !== 'POST') {
            res.writeHead(404)
            res.end()
            return
        }
        const rawContentType = req.headers['content-type']
        const contentType = (Array.isArray(rawContentType) ? rawContentType[0] : rawContentType) ?? ''
        if (contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
            res.writeHead(415)
            res.end()
            return
        }
        let raw: string
        try {
            raw = await readBody(req)
        } catch {
            res.writeHead(413)
            res.end()
            return
        }
        let body: unknown
        try {
            body = JSON.parse(raw)
        } catch {
            res.writeHead(400)
            res.end()
            return
        }
        const endpoint = endpointOf(new URL(req.url ?? '/', 'http://dsh.internal').pathname, channel)
        if (endpoint === undefined) {
            res.writeHead(404)
            res.end()
            return
        }
        const request = parseClientRequest(body)
        if (request === undefined) {
            badRequest(res, envelopeRpcId(body), 'invalid client-request message')
            return
        }
        if (request.method !== endpoint) {
            badRequest(res, request.rpcId, `method ${JSON.stringify(request.method)} does not match endpoint ${JSON.stringify(endpoint)}`)
            return
        }
        try {
            // signal 为占位：node:http 侧无处传播客户端中断，端点 handler 当前亦不消费
            respond(res, 200, JSON.stringify(serverResponse(request.rpcId, await handler(endpoint, request.payload, new AbortController().signal))))
        } catch (error) {
            res.writeHead(500)
            res.end(`handler failure: ${String(error)}`)
        }
    }
}

/** 读完请求体；超上限即暂停请求流并拒绝（连接由响应结束路径断开） */
function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        req.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_BODY_BYTES) {
                // 停止读入剩余数据，连接由响应结束路径收尾（Node 对未完整请求在响应 finish 时断开）。
                // 不用 req.destroy()——会截断尚未写出的 413 响应，客户端只能看到连接重置
                req.pause()
                reject(new Error('request body too large'))
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
    })
}
