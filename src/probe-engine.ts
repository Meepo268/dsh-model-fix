/**
 * 「模型 × 推理级别」最小请求的执行引擎：验证与探测式填充共用。
 *
 * 设计裁决（四级分层、受理判据、失败分类、短路判据、并发与中止语义）见 docs/decisions.md「验证」与「探测式填充」。
 * 本文件独有的口径：收到首个 `block-start` 即判该「模型 × 档位」可用，随即中断；`PROBE_TIMEOUT_MS` 定单次探测等待上限。
 */

import type { LlmRuntime, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
// LlmFailure 定义在 types 子路径（包根只 import 未再导出）；仅取类型，擦除后不落运行期依赖
import type { LlmFailure } from '@deepseek-ai/dsh-llm/types'
import type { ProviderProbeOutcome, VerifyFailureFacts, VerifyProbe, VerifyProbeResult, VerifyProgressFrame, VerifyProviderReport, VerifySummary } from '@/shared/verify-progress'
import type { ProviderProbeGroup } from '@/probe-plan'
import { reportProvider, summarizeProviders } from '@/probe-report'
import { classifyFailure, type ProbeVerdict } from '@/probe-verdict'

/** 探测提示词：只要一句应答，最省 token */
const PROBE_PROMPT = 'Just say OK'
/** 单次探测的等待上限（毫秒）：超时视为本次没跑成，防个别端点把整批拖死 */
const PROBE_TIMEOUT_MS = 30_000
/** 同时在跑的**提供方**数（不是单提供方并发数——后者恒为 1，由分组串行保证） */
const PROBE_PROVIDER_CONCURRENCY = 5

/** 取失败事实的可序列化子集（供调用方自行细分，不参与本插件的判定） */
function failureFacts(failure: LlmFailure): VerifyFailureFacts {
    return { code: failure.code, status: failure.status, message: failure.message }
}

/**
 * 发一次探测并判定：收到首个 `block-start` 即判「受支持」；否则读到终止块、据其失败事实分类。
 * 中止（外部或上游）没有结论，单列 `'aborted'`；我方超时归 `'timeout'`——都不能误判成端点不可达。
 */
export async function probeOnce(
    llm: Pick<LlmRuntime, 'stream'>,
    probe: Pick<VerifyProbe, 'provider' | 'model' | 'effort'>,
    signal: AbortSignal,
): Promise<ProbeVerdict> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, PROBE_TIMEOUT_MS)
    try {
        for await (const chunk of llm.stream({
            provider: probe.provider,
            model: probe.model,
            // 档位 id 取自宿主自己的 reasoningEfforts 配置键（即模型页送出的同一个值），断言只为满足品牌类型，
            // 免为此引入 @deepseek-ai/dsh-llm 的运行期值导入
            ...(probe.effort === undefined ? {} : { reasoningEffort: probe.effort as ReasoningEffortId }),
            messages: [{ role: 'user', content: [{ type: 'text', text: PROBE_PROMPT }] }],
            // 我方超时与外部中止合成一路，两者都该停在探测边界上。
            // 不能改用 AbortSignal.timeout：那会抹掉下面判断「超时的是我」的 timedOut 标志，慢端点又被误判成断线
            signal: AbortSignal.any([signal, controller.signal]),
        })) {
            // 只认 block-start——它证明适配器已真正开始产出内容块（宿主 isVisibleChunk 同样把 usage / finish 排除在「内容」之外）。
            // 不能沿用「首个非 finish 块即成功」：额度耗尽的 key 也会先来一条 usage，那不是受理信号。
            // 命中即返回，随后的 finally 中断请求、不再消耗生成额度
            if (chunk.type === 'block-start') return { outcome: 'usable', failure: undefined }
            if (chunk.type === 'finish') {
                const reason = chunk.reason
                // stop / tool-calls / max-tokens：正常终止却没有内容块，宿主归为退化完成，同样没跑成
                if (reason.kind !== 'error' && reason.kind !== 'aborted') return { outcome: 'other', failure: undefined }
                // 外部中止单列：没有结论，既不是不可用也不能断后续请求。
                // 只认外部那一路——我方超时也走 `aborted` 终帧（合成信号被中止），归下面的 timeout
                if (reason.kind === 'aborted' && signal.aborted) {
                    return { outcome: 'aborted', failure: failureFacts(reason.failure) }
                }
                // 我方超时不算端点不可达，也不算不可用——但原始失败事实照留，供调用方自行判断
                return {
                    outcome: timedOut ? 'timeout' : classifyFailure(reason.failure),
                    failure: failureFacts(reason.failure),
                }
            }
        }
        // 适配器中止时直接收流、不给终帧：同样没有结论
        if (signal.aborted) return { outcome: 'aborted', failure: undefined }
        return { outcome: 'other', failure: undefined }
    } catch {
        // 适配器未注册等抛出的异常一律归入「其它失败」，不参与短路——宁可少短路，不可误短路
        return { outcome: 'other', failure: undefined }
    } finally {
        clearTimeout(timer)
        controller.abort()
    }
}

/** 「永不中止」的占位信号（AbortSignal 没有 null 态，未给 signal 时用它） */
const NEVER_ABORTED = new AbortController().signal

/**
 * 一帧的进度交代：`settled` 是进度增量（`done` 只数计划条目），`skipped` 是因短路而未发出的条数。
 *
 * 恒有 `settled === skipped + (当前条目确已发出 ? 1 : 0)`：基线探测不是被验对象、占不了进度位，
 * 而被短路而未发出的条目同样计入——它们不会再被验，进度就该在这一帧走完，否则整轮跑完停在 `done < total`。
 */
export interface ProbeFrameProgress {
    /** 本帧了结的计划条目数；0 即附注帧，不推进 `done` */
    settled: number
    /** 因短路而未发出的条数；无则缺省 */
    skipped?: number
}

/** 一个 `runGroup` 的产出出口：一条请求的结论 + 该帧的进度交代 */
export type ProbeEmitter = (
    probe: Pick<VerifyProbe, 'provider' | 'model' | 'effort'>,
    verdict: ProbeVerdict,
    progress: ProbeFrameProgress,
) => void

/** 一组怎么逐条跑：两个功能的全部差异都在这个回调里（验证带基线探测，探测式填充逐档平推） */
export type GroupRunner = (
    llm: Pick<LlmRuntime, 'stream'>,
    group: ProviderProbeGroup,
    signal: AbortSignal,
    emitProbe: ProbeEmitter,
) => Promise<ProviderProbeOutcome>

/** 一轮请求的可选控制项；不传即静默跑完 */
export interface ProbeRunOptions {
    /** 外部中止：客户端断开或用户点停止 / 关窗。已中止即不再发新请求 */
    signal?: AbortSignal
    /** 进度出口。`done` 帧只在整轮真正跑完时发出，中止时不发 */
    onProgress?: (frame: VerifyProgressFrame) => void
}

/**
 * 跑完一组清单（组内零并发、组间最多五路）并汇总；**不发 `done` 帧**——终帧由调用方在收尾时发。
 *
 * 中止的处理在这里已经定型：已中止即不再开新组，从未开跑的组保持 undefined 并被排除在汇报之外
 * （把它们报成「全可用」或「全不可用」都是撒谎）。
 */
export async function runProbeGroups(
    llm: Pick<LlmRuntime, 'stream'>,
    groups: readonly ProviderProbeGroup[],
    runGroup: GroupRunner,
    options: ProbeRunOptions = {},
): Promise<VerifySummary> {
    const signal = options.signal ?? NEVER_ABORTED
    // 分母只数计划条目：基线探测不是被验对象（口径同 `planned` / `probed`），故 `done ≤ total` 恒成立
    const total = groups.reduce((sum, group) => sum + group.probes.length, 0)
    // 稀疏数组：中止时从未开跑的组保持 undefined，汇报时据实排除
    const outcomes = new Array<ProviderProbeOutcome>(groups.length)
    let completed = 0
    const emitProbe: ProbeEmitter = (probe, verdict, progress): void => {
        // 跨 worker 的累计位置：本函数只在 await 之后同步调用，单线程下不会交错，累加即可
        completed += progress.settled
        options.onProgress?.({
            type: 'probed',
            provider: probe.provider,
            model: probe.model,
            effort: probe.effort,
            outcome: verdict.outcome,
            ...(progress.skipped === undefined ? {} : { skipped: progress.skipped }),
            done: completed,
            total,
        })
    }
    options.onProgress?.({ type: 'opened', total })
    // 第 w 个 worker 只跑下标 ≡ w (mod workers) 的组：一个普通 for 即可切分，无需共享游标，
    // 各 worker 拿到的组数相差至多一个；组内逐条 await 即「同一 provider 零并发」
    const workers = Math.min(PROBE_PROVIDER_CONCURRENCY, groups.length)
    await Promise.all(Array.from({ length: workers }, (_, worker) => (async () => {
        for (let at = worker; at < groups.length; at += workers) {
            if (signal.aborted) break
            outcomes[at] = await runGroup(llm, groups[at], signal, emitProbe)
        }
    })()))
    const reports: VerifyProviderReport[] = []
    const details: VerifyProbeResult[] = []
    for (let at = 0; at < groups.length; at++) {
        const outcome = outcomes[at]
        if (outcome === undefined) continue
        reports.push(reportProvider(outcome))
        details.push(...outcome.results)
    }
    return summarizeProviders(reports, details)
}

/**
 * 收尾发终帧：**中止不发 `done`**——消费方见「流自然结束却没等到 done」即知这轮没跑完，
 * 据此保留进度而不是报成功。由调用方在全部收尾动作（探测式填充的收敛写回）之后调用，
 * 故终帧里的汇总已是最终形态。
 */
export function finishRun(summary: VerifySummary, options: ProbeRunOptions = {}): void {
    if (options.signal?.aborted) return
    options.onProgress?.({ type: 'done', summary })
}
