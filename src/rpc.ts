/**
 * Connection RPC 端点（前后端通信通道）：forceUpdate / resetModels / restoreModels / pruneEfforts 四个写回端点
 * 与 reportLocale 语言上报端点，写回共用同一守卫做互斥；验证与探测式填充的进度各开一条 `connection.fetch` 的 exact 路由。
 *
 * 设计裁决（守卫互斥、两条进度流、各写回端点语义）见 docs/decisions.md「写回端点」与「验证」。
 * 路由由本插件自注册而不走宿主 `connection.rpc.handle`：后者在**服务自己的 ctx** 上求值 `owner.webServer`，
 * 而 connection 插件自 0.1.5 起不再注入 webServer，故它必然抛错（详见 rpc-route.ts）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcResult, HostConnectionService } from '@deepseek-ai/dsh-client-connection'
// ctx.llm 服务面声明合并（仅 type-only，不引运行期依赖；LLM 服务是插件 inject 依赖，装载即在）
import type {} from '@deepseek-ai/dsh-llm'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import {
    ENDPOINT_FORCE_UPDATE, ENDPOINT_PRUNE_EFFORTS, ENDPOINT_REPORT_LOCALE,
    ENDPOINT_RESET_MODELS, ENDPOINT_RESTORE_MODELS,
    PLUGIN_NAME, PLUGIN_NS, PROBE_STREAM_ROUTE, VERIFY_STREAM_ROUTE,
} from '@/shared/constants'
import { errorText } from '@/shared/errors'
import { encodeProgressFrame } from '@/shared/verify-progress'
import type { VerifySummary } from '@/shared/verify-progress'
import type { ProbeRunOptions } from '@/probe-engine'
import { fix } from '@/fix'
import { reportLocale } from '@/effort-name'
import { endIgnoreAll, isIgnoreAll, startIgnoreAll } from '@/guard'
import { parsePruneTargets, pruneUnsupportedEfforts } from '@/prune'
import { probeAndFill } from '@/probe'
import { resetModels } from '@/reset'
import { restoreModels } from '@/restore'
import { verifyModels } from '@/verify'
import { createChannelRoute } from '@/rpc-route'
import type { EndpointHandler } from '@/rpc-route'

/** 一轮执行的入口：载荷 → 进度帧 → 终帧。验证与探测式填充同型，只有执行器与措辞不同 */
type ProgressRunner = (payload: unknown, options: ProbeRunOptions) => Promise<VerifySummary>

/** 守卫已开（另一写回在途）时的统一拒绝结果 */
const writeInProgress = (): ConnectionRpcResult<unknown> => ({
    ok: false,
    error: { code: 'model-fix/write-in-progress', message: '另一操作进行中，请稍后重试', details: {} },
})

/** 强制更新：置守卫 → fix → 解守卫；fix 内部已告警，此处转 RPC 失败结果 */
async function handleForceUpdate(ctx: Context): Promise<ConnectionRpcResult<unknown>> {
    if (isIgnoreAll()) return writeInProgress()
    startIgnoreAll()
    try {
        return { ok: true, value: { changed: await fix(ctx, true) } }
    } catch (error) {
        return { ok: false, error: { code: 'model-fix/force-update-failed', message: errorText(error), details: {} } }
    } finally {
        endIgnoreAll()
    }
}

/** 重置推理级别：守卫已开即拒 */
async function handleResetModels(ctx: Context): Promise<ConnectionRpcResult<unknown>> {
    if (isIgnoreAll()) return writeInProgress()
    try {
        return { ok: true, value: { changed: await resetModels(ctx) } }
    } catch (error) {
        return { ok: false, error: { code: 'model-fix/reset-models-failed', message: errorText(error), details: {} } }
    }
}

/** 恢复备份：守卫已开即拒 */
async function handleRestoreModels(ctx: Context): Promise<ConnectionRpcResult<unknown>> {
    if (isIgnoreAll()) return writeInProgress()
    try {
        return { ok: true, value: { changed: await restoreModels(ctx) } }
    } catch (error) {
        return { ok: false, error: { code: 'model-fix/restore-models-failed', message: errorText(error), details: {} } }
    }
}

/** 剔除不被支持的推理级别：守卫已开即拒；载荷非法（targets 解析失败）返回 invalid 结果 */
async function handlePruneEfforts(ctx: Context, payload: unknown): Promise<ConnectionRpcResult<unknown>> {
    if (isIgnoreAll()) return writeInProgress()
    const targets = parsePruneTargets(payload)
    if (targets === undefined) {
        return { ok: false, error: { code: 'model-fix/prune-efforts-invalid', message: '剔除请求不合法（提供方 / 模型 / 推理级别缺失或越界）', details: {} } }
    }
    try {
        return { ok: true, value: { pruned: await pruneUnsupportedEfforts(ctx, targets) } }
    } catch (error) {
        return { ok: false, error: { code: 'model-fix/prune-efforts-failed', message: errorText(error), details: {} } }
    }
}

/** 浏览器半启动时上报探测语言：Node 侧没有 locale 服务，见 effort-name.ts 的语言解析 */
function handleReportLocale(payload: unknown): ConnectionRpcResult<unknown> {
    reportLocale(payload)
    return { ok: true, value: {} }
}

/** 注册一个 channel（四个端点）；register 返回 disposer，经 ctx.effect 挂卸载自动回收 */
export function installRpc(ctx: Context): void {
    // 子 fiber 声明 connection + webServer：webServer 用于注册前缀路由，connection 用于信任围栏。
    // 无 webServer 的 profile（如 headless）下子 fiber 不启动，插件其余功能不受影响。
    ctx.inject(['connection', 'webServer'], (rpcCtx) => {
        const connection = rpcCtx.get('connection') as Pick<HostConnectionService, 'requestRejection' | 'fetch'>
        const webServer = rpcCtx.get('webServer') as WebServer
        rpcCtx.effect(() => {
            const channel = `/${PLUGIN_NS}`
            // 强制更新与恢复备份各按整份配置重算、不读载荷；重置也不读，但剔除要按调用方给的档位明细动手
            const handler: EndpointHandler = async (endpoint, payload) => {
                switch (endpoint) {
                    case ENDPOINT_FORCE_UPDATE: return handleForceUpdate(ctx)
                    case ENDPOINT_RESET_MODELS: return handleResetModels(ctx)
                    case ENDPOINT_RESTORE_MODELS: return handleRestoreModels(ctx)
                    case ENDPOINT_PRUNE_EFFORTS: return handlePruneEfforts(ctx, payload)
                    case ENDPOINT_REPORT_LOCALE: return handleReportLocale(payload)
                    default:
                        return { ok: false, error: { code: 'model-fix/unknown-endpoint', message: `未知端点：${endpoint}`, details: {} } }
                }
            }
            const disposeChannel = webServer.register({ kind: 'prefix', path: channel, handler: createChannelRoute(connection, channel, handler) })
            // 两条进度流走 connection.fetch 的 exact 路由而非 channel：它们要的是一个持续多帧的响应，
            // 而 RPC 的一次调用只对应一个 JSON 结果
            const disposeStream = connection.fetch.register({
                path: VERIFY_STREAM_ROUTE,
                methods: ['POST'],
                requestBody: 'buffered',
                fetch: progressStreamFetch((payload, options) => verifyModels(ctx.llm, payload, options), '验证'),
            })
            // 探测式填充的流多带一个 ctx：它一轮之内要写两次配置（预声明 + 收敛），都在守卫内完成
            const disposeProbe = connection.fetch.register({
                path: PROBE_STREAM_ROUTE,
                methods: ['POST'],
                requestBody: 'buffered',
                fetch: progressStreamFetch((payload, options) => probeAndFill(ctx, ctx.llm, payload, options), '探测', true),
            })
            return () => {
                disposeChannel()
                // fetch.register 的 disposer 是异步的；effect 只负责同步调用它
                void disposeStream()
                void disposeProbe()
            }
        }, `${PLUGIN_NAME}: rpc`)
    })
}

/**
 * 进度流的 Fetch 实现：请求体是模型清单，响应是以 SSE 分帧的进度。
 *
 * 走 `connection.fetch.register` 而非 `webServer.register` 是刻意的：前者由 Connection 代管信任围栏、
 * 浏览器认证与**客户端断开 → `request.signal`**，后者这些都得自己再搭一遍（见本文件头记的
 * connection 自 0.1.5 起不再注入 webServer 那个坑）。
 *
 * 验证与探测式填充共用这一份实现：两者的线上形状逐字段同形（同一批帧类型、同一编解码），
 * 差别的只有执行器与报错措辞，故那两样由调用方给。
 *
 * `needsIdleGuard` 只给会写配置的那条流用：它与写回端点共用事件流守卫做互斥，
 * 故入口先查守卫，已开即拒（409，文案即给前端展示，故不是裸状态码）。
 */
function progressStreamFetch(
    run: ProgressRunner,
    label: string,
    needsIdleGuard = false,
): (request: Request) => Promise<Response> {
    const encoder = new TextEncoder()
    return async (request) => {
        // 写配置的流（探测式填充）入口先查守卫：别在别的写回在途时插进来，
        // 那样对方的 finally 会提前解掉本轮的守卫，预声明写回就失去事件链的短路保护
        if (needsIdleGuard && isIgnoreAll()) return new Response('另一操作进行中，请稍后重试', { status: 409 })
        let payload: unknown
        try {
            payload = await request.json()
        } catch {
            return new Response('invalid json body', { status: 400 })
        }
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const settle = (): void => {
                    try {
                        controller.close()
                    } catch {
                        // 客户端已断开，控制器随之失效；无可挽回，也不必上报
                    }
                }
                run(payload, {
                    // 客户端断开时 request.signal 会中止，据此让执行循环早停——
                    // 这一轮是即用即弃的诊断，用户已经不在之后继续跑等于白烧他的额度
                    signal: request.signal,
                    onProgress: (frame) => {
                        try {
                            controller.enqueue(encoder.encode(encodeProgressFrame(frame)))
                        } catch {
                            // 同上：流已不可写。执行器随即随 signal 停下，不会再压更多帧
                        }
                    },
                }).then(settle, (error: unknown) => {
                    // 入参非法之类跑不到一帧的情形：只收尾，消费方见「流结束却没等到 done」即知没跑完
                    console.error(`[${PLUGIN_NAME}] ${label}流异常终止`, error)
                    settle()
                })
            },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }
}
