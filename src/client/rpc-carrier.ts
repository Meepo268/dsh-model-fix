/**
 * 浏览器半调 Node 半的唯一出口：四个 channel RPC 写回端点与两条进度流的读流。
 *
 * 收在一处是因为它们同源——channel 字面量、endpoint 名、两条流各自的载荷形状都与
 * Node 半一一对应；散在入口里改一个端点名，要翻两个文件才找得到另一处。卡片只消费
 * 本文件产出的 `RpcCarrier`，自己不发起请求。
 */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
// channel RPC 的结果信封
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import {
    ENDPOINT_FORCE_UPDATE, ENDPOINT_PRUNE_EFFORTS, ENDPOINT_RESET_MODELS, ENDPOINT_RESTORE_MODELS,
    PLUGIN_NS, PROBE_STREAM_URL, VERIFY_STREAM_URL,
} from '@/shared/constants'
import { decodeProgressFrame } from '@/shared/verify-progress'
import type { UnsupportedEffort, VerifyProgressUpdate, VerifySummary } from '@/shared/verify-progress'
import type { VerifyTarget } from '@/client/model'

/** 卡片可用的调用面：四个写回端点与两条诊断链的读流 */
export interface RpcCarrier {
    /** 强制更新 RPC：channel 与端点在入口拼好，卡片只消费结果 */
    forceUpdate: () => Promise<ConnectionRpcResult<unknown>>
    /** 重置推理级别 RPC：仅剔除模型上的 reasoningEfforts（最大上下文 / 输出上限 / 图片模态可在模型页自行设置，不清除；excludes 命中跳过），配置段原样保留；返回受影响的模型数 */
    resetModels: () => Promise<ConnectionRpcResult<unknown>>
    /** 恢复备份 RPC：回退启动时备份（交集 provider+model）到当前配置；返回被恢复的模型数 */
    restoreModels: () => Promise<ConnectionRpcResult<unknown>>
    /** 剔除不被支持的推理级别：入参是验证明细给出的「提供方 / 模型 / 档位」清单；返回实际剔掉的档位条数 */
    pruneEfforts: (targets: readonly UnsupportedEffort[]) => Promise<ConnectionRpcResult<unknown>>
    /** 验证模型：走进度流端点，对「模型 × 推理级别」各发一次最小请求（`needTest` 的模型另发一次不计数的探测作对照），逐条回调实时进度；整轮跑完回汇总，被中止（停止 / 关窗 / 断连）回 undefined */
    verifyModels: (
        models: readonly VerifyTarget[],
        onFrame: (frame: VerifyProgressUpdate) => void,
        signal: AbortSignal,
    ) => Promise<VerifySummary | undefined>
    /**
     * 探测式填充：走进度流端点，Node 半先把候选档位临时预声明进配置、再对每个模型逐档各发一次最小请求，
     * 跑完按「自动写入」开关收敛写回或整轮还原；终帧的 `summary.fill` 一律带收敛结论的增删统计
     * （关闭时是「可补全」的假设统计）。三个开关须与 Node 半的两次写回同值。被中止（停止 / 关窗 / 断连）
     * 回 undefined——中止不发终帧，且未跑完的模型一律还原成预声明之前的形态。
     */
    probeEfforts: (
        models: readonly VerifyTarget[],
        flags: { ignoreExcludes: boolean; dropUnsupported: boolean; autoWrite: boolean },
        onFrame: (frame: VerifyProgressUpdate) => void,
        signal: AbortSignal,
    ) => Promise<VerifySummary | undefined>
}

/**
 * 取一份调用面。
 *
 * @param rpc - 宿主 connection 服务的 client RPC 面（由调用方在子 fiber 内取用后传入）
 */
export function makeRpcCarrier(rpc: ClientConnectionRpc): RpcCarrier {
    const channel = `/${PLUGIN_NS}`
    const forceUpdate = () => rpc.call(channel, ENDPOINT_FORCE_UPDATE, {})
    const resetModels = () => rpc.call(channel, ENDPOINT_RESET_MODELS, {})
    const restoreModels = () => rpc.call(channel, ENDPOINT_RESTORE_MODELS, {})
    // 剔除不被支持的推理级别：走 Node 半而非浏览器半直写，因为这条写回必须经事件流守卫，
    // 而守卫是 Node 半的模块级标志，浏览器半跨不过半纯度门禁
    const pruneEfforts = (targets: readonly UnsupportedEffort[]) =>
        rpc.call(channel, ENDPOINT_PRUNE_EFFORTS, { targets })
    /**
     * 读一条进度流：POST 载荷，逐帧回调非终帧，收于终帧时返回整轮汇总。
     *
     * 用 `fetch` + `getReader()` 而非 `EventSource`：后者自动重连，而重连等于把整轮重新跑一遍。
     * 非 2xx 时优先用响应体文案（Node 半两条流都会给一句中文原因，如「另一操作进行中」），
     * 裸状态码对用户无意义。
     *
     * @returns 整轮汇总；被中止（点停止 / 关窗 / 断连）时返回 `undefined`，那不是失败
     */
    const streamSummary = async (
        url: string,
        body: unknown,
        onFrame: (frame: VerifyProgressUpdate) => void,
        signal: AbortSignal,
    ): Promise<VerifySummary | undefined> => {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal,
            })
            if (!response.ok || response.body === null) {
                const reason = (await response.text().catch(() => '')).trim()
                throw new Error(reason === '' ? `HTTP ${response.status}` : reason)
            }
            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            let summary: VerifySummary | undefined
            for (;;) {
                const { done, value } = await reader.read()
                // 解码走 stream 模式：多字节字符可能横跨两个分片边界
                if (value !== undefined) buffer += decoder.decode(value, { stream: true })
                // SSE 以空行分帧；末尾不足一帧的残片留给下一批
                let cut = buffer.indexOf('\n\n')
                while (cut !== -1) {
                    const frame = decodeProgressFrame(buffer.slice(0, cut))
                    buffer = buffer.slice(cut + 2)
                    cut = buffer.indexOf('\n\n')
                    if (frame === undefined) continue
                    if (frame.type === 'done') summary = frame.summary
                    else onFrame(frame)
                }
                if (done) break
            }
            return summary
        } catch (error) {
            if (signal.aborted) return undefined
            throw error
        }
    }
    /**
     * 验证模型：载荷是卡片按勾选收敛好的「提供方 / 模型 / 各自档位列表 / 是否需要探测」计划，Node 半只按它逐档位展开；探测由 Node 半在执行阶段现发。
     *
     * 走独立的进度流端点而非 channel RPC——一次调用要回持续多帧的响应，RPC 的「一次调用 = 一个
     * JSON 结果」装不下。用文档相对路由（去掉前导斜杠）是宿主对浏览器侧的约定，服务端 key 保持绝对，
     * 两侧同取 `src/shared/constants.ts` 的同一常量。
     */
    const verifyModels = (models: readonly VerifyTarget[], onFrame: (frame: VerifyProgressUpdate) => void, signal: AbortSignal) =>
        streamSummary(VERIFY_STREAM_URL, { models }, onFrame, signal)
    /**
     * 探测式填充：载荷与验证同形（每个模型一份「要试哪几档」的清单），另带三个开关。
     *
     * 三个开关必须与 Node 半共用同一个值：「忽略排除」若只在这边放开而那边仍跳过排除，
     * 等于白探测一轮；「剔除不支持」决定收敛口径（`可用 ∪ 原有` 还是 `可用 ∪ (原有 − 不支持)`）；
     * 「自动写入」关闭时 Node 半在探测结束后只把预声明原样收回（与中止同一形态）。
     * 终帧里的 `summary.fill` 一律是收敛结论的增删统计——开启即已写入的补全，关闭即「可补全」的
     * 假设统计；收敛发生在整轮探测之后、终帧之前。
     */
    const probeEfforts = (
        models: readonly VerifyTarget[],
        flags: { ignoreExcludes: boolean; dropUnsupported: boolean; autoWrite: boolean },
        onFrame: (frame: VerifyProgressUpdate) => void,
        signal: AbortSignal,
    ) => streamSummary(PROBE_STREAM_URL, { models, ...flags }, onFrame, signal)
    return { forceUpdate, resetModels, restoreModels, pruneEfforts, verifyModels, probeEfforts }
}
