import type { LlmFailure } from '@deepseek-ai/dsh-llm/types'
import type { ProbeOutcome, ProviderBlockReason, VerifyFailureFacts, VerifyProbe } from '@/shared/verify-progress'
import { isProviderBlocking } from '@/shared/verify-progress'

/**
 * 探测的判定层：把宿主给出的失败事实翻译成本插件的结论，并给出两级短路的唯一判据。
 *
 * 全部是零 ctx、不触网的纯函数（tests 依赖此形态）。
 * 设计裁决（失败分类、两级短路判据）见 docs/decisions.md「验证」与「探测式填充」。
 */

/** 宿主规范码：额度 / 余额耗尽（`ACCOUNT_QUOTA` 是宿主给「账户余额不足」定的字面量，不是 `ACCOUNT_QUOTA_EXCEEDED`） */
const QUOTA_CODES: ReadonlySet<string> = new Set(['QUOTA', 'ACCOUNT_QUOTA'])
/** 宿主规范码：凭据缺失或无效 */
const CREDENTIAL_CODES: ReadonlySet<string> = new Set(['INVALID_CREDENTIAL', 'MISSING_CREDENTIAL'])
/** 宿主规范码：模型未声明请求的这一推理级别（宿主在派发前本地拒绝，请求根本没发出去） */
const UNSUPPORTED_EFFORT_CODE = 'UNSUPPORTED_REASONING_EFFORT'
/** 宿主规范码：上游限流（429）；本次没跑成，换个档位重试仍可能通过 */
const RATE_LIMIT_CODE = 'RATE_LIMIT'
/** 宿主规范码：上游超时；与本方探测超时同性质 */
const TIMEOUT_CODE = 'TIMEOUT'
/** 宿主规范码：请求被中止。用户点停止、关窗断连与上游主动中止都归到它，故它不是失败、没有结论 */
const ABORTED_CODE = 'ABORTED'
/**
 * 宿主给出的传输层失败码：连接中断、流被截断。真「连不上」只有这一类信号。
 *
 * **不能拿「`status` 缺失」当不可达**：pi-ai 侧的错误一律不带 status——`llm-pi-ai` 抛错只给
 * `new LlmError(message, code)`，终止错误也只给 `{ message, code }`，任何上游状态码（400、5xx）
 * 在到达我们之前就被压成了文案。故 status 缺失只说明「不是 HTTP 层拒绝」，不说明「连不上」；
 * 按它判会把一次 400 或一次 5xx 误报成断线，进而错误短路整个 provider 剩下的全部模型。
 */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['TRANSPORT', 'STREAM_CLOSED'])
/** 宿主规范码：请求参数不正确（`classifyPiAiError` 从文案认出的 4xx / invalid_request，含 413 请求体过大） */
const INVALID_REQUEST_CODE = 'INVALID_REQUEST'

/** 一次探测的判定：结论 + 失败时的原始事实（收到 block-start 时无事实） */
export interface ProbeVerdict {
    outcome: ProbeOutcome
    failure: VerifyFailureFacts | undefined
}

/**
 * 由终止块的失败事实判定探测结果。一律按宿主的 `code` 判：不看 `status`（对 pi-ai 侧恒缺），
 * 也不比对文案。限流与超时单列为瞬态——只说明「这一次没跑成」，不参与 provider 级短路、也不短该模型的后续档位。
 * 中止单列一态：它没有结论，落到「其它」等于把用户按的停止说成厂商拒绝，进而错误短掉整个模型的档位尾。
 * 其余未识别的码归「其它厂商侧拒绝」，多与具体模型有关。
 */
export function classifyFailure(failure: LlmFailure): Exclude<ProbeOutcome, 'usable'> {
    if (failure.code === UNSUPPORTED_EFFORT_CODE) return 'unsupported-effort'
    if (QUOTA_CODES.has(failure.code)) return 'quota'
    if (CREDENTIAL_CODES.has(failure.code)) return 'credential'
    if (UNREACHABLE_CODES.has(failure.code)) return 'unreachable'
    if (failure.code === RATE_LIMIT_CODE) return 'rate-limit'
    if (failure.code === TIMEOUT_CODE) return 'timeout'
    if (failure.code === ABORTED_CODE) return 'aborted'
    return 'other'
}

/**
 * 该失败是否指明「就是这个推理级别不被支持」的第一个条件：宿主判为「请求参数不正确」
 * （`INVALID_REQUEST`）。
 *
 * 不支持必然落在客户端错误里；5xx、限流、超时、传输中断都是别的问题，不能算到档位头上。该码是宿主
 * `classifyPiAiError` 用 `/\b400\b|invalid.?request/i` 从报错文案里认出来的，`status` 在 pi-ai 侧恒缺、
 * 我们看不到，故只能取宿主已经归一好的结论，**不再自己比对文案**——上游措辞千差万别（实测有只列可用档位的、
 * 也有原样回显的），还有些网关在 4xx 里回显请求体，按文案匹配只会多出误判面。
 *
 * 第二个条件是「除档位外别无变量」，两个功能各用自己的对照（验证用不带档位的基线探测，
 * 探测式填充用同模型已跑通的更低档位），由 `runGroup` 保证后才落「档位不支持」这个结论。
 */
export function isEffortRejection(failure: VerifyFailureFacts | undefined): boolean {
    return failure?.code === INVALID_REQUEST_CODE
}

/**
 * 从 `from` 之后起与它同模型的探测条数。请求按模型分组生成，故这些就是该模型剩下的档位。
 */
export function sameModelTail(probes: readonly VerifyProbe[], from: number): number {
    let count = 0
    for (let index = from + 1; index < probes.length && probes[index]?.model === probes[from]?.model; index++) count++
    return count
}

/**
 * 该失败是否足以否定**整个提供方**（provider 级短路的唯一判据，验证与探测式填充共用）。
 *
 * 判据只有一条：**能断定后续请求必然失败**，才能短路。返回短路原因，不短路即 `undefined`：
 * - **端点不通 / 凭据无效**（`isProviderBlocking`）：与请求内容无关，同一提供方又共用同一 url 与
 *   同一把 key，故一条不通整组都不通。
 * - **该提供方的首个请求超时**：首条就等满单次探测的等待上限（30 秒，定在执行层），成因无非是 url 不可达、端点服务中断、
 *   本地网络不通——后续请求只会是同样无意义的超时，等下去既拿不到结果又白等几十遍 30 秒，
 *   故断整组。理由记 `timeout` 而**不是** `unreachable`：报告里的「可达 / 凭据」只按真实失败事实记，
 *   超时不是传输层失败的证据，翻假会让用户以为端点已确认连不上。
 *   首个之后的超时不同：那时已经跑通过请求，链路是活的，只是这一次慢，仍按瞬态处理。
 *
 * `firstRequest` 由各功能按「本组已发出几条请求」给出，验证那边要把它额外的基线探测请求算进去。
 */
export function providerBlockReason(outcome: ProbeOutcome, firstRequest: boolean): ProviderBlockReason | undefined {
    if (isProviderBlocking(outcome)) return outcome
    return firstRequest && outcome === 'timeout' ? 'timeout' : undefined
}

/**
 * 该失败是否足以否定**该模型的其余档位**（模型级短路的唯一判据，验证与探测式填充共用）。
 *
 * 判据同 provider 级：**能断定后续请求必然失败**才短。档位请求上只有**额度耗尽**够格——
 * 额度按提供方与模型计，同一把 key 的额度已经用完，换多少档都是同样结果。
 *
 * 其余一律不短，宁可多烧几次额度也不误杀可用档位：
 * - **其它厂商侧拒绝**（含上游 5xx、`PI_AI_ERROR` 未归一的错误）：多半是服务端的一次性故障，
 *   换个档位可能就通；判「只否定这一档」还要求宿主判为 `INVALID_REQUEST` **且**该功能自己的对照
 *   成立（验证拿不带档位的基线，探测式填充拿同模型已跑通的更低档，见 `isEffortRejection`），
 *   两者凑齐才落「档位不支持」，那种结论本就不该短后面的档位。
 * - **限流与超时**：只否定了这一次，重试同一模型只是白烧额度。（例外：探测式填充把**限流**
 *   追加为自己的模型级短路——限流不分档位，被短模型整轮还原档位表、无误杀，只省请求；
 *   超时两边都不短。见 `src/probe.ts` 的 `runProbeGroup` 与 docs/decisions.md「探测式填充」。）
 */
export function shouldSkipModelTail(outcome: ProbeOutcome, failure: VerifyFailureFacts | undefined): boolean {
    return failure !== undefined && outcome === 'quota'
}

/**
 * **基线**失败后是否短该模型的档位尾（验证独有，但判据与上面的共用判据同处一地，便于对照与单测）。
 *
 * 基线请求**不带推理级别**，故它的失败天生与档位无关：同一个模型再换任何档位，请求的其余部分一模一样。
 * 于是只剩「这个失败是不是确定性的」一问——限流与超时明确不是（隔一会儿就通），
 * 额度耗尽与其它厂商侧拒绝则是（模型不存在、参数被拒、无权限、上游持续故障），故短路。
 * 中止不在其列：它没有结论，什么也没否定。
 *
 * 与档位请求上的模型级短路分开，是因变量不同：那里「档位」是唯一变过的变量，故只有额度够格；
 * 这里档位压根没参与，剩下的失败对同一模型的后续请求照样成立。
 */
export function shouldSkipModelTailAfterBaseline(outcome: ProbeOutcome): boolean {
    return outcome === 'quota' || outcome === 'other'
}
