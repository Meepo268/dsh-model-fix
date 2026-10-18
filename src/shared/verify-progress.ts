/**
 * 「验证模型」与「探测档位」共用的跨半契约：探测明细、逐提供方汇报、进度帧。
 *
 * 放在共享层而非 Node 半，是因为浏览器半要解析回传的结果与进度帧——浏览器半不能反向 import Node 半
 * （`eslint.config.ts` 的跨半纯度门禁），而复制一份类型必然随演进漂移。
 * 本文件只有类型与纯谓词：零 Node 依赖、零 schemastery、零宿主值导入。
 *
 * 两个功能共用同一份形状而不另立一套：验证是「每模型一次」不带 `reasoningEffort` 的最小请求，
 * 探测档位是「模型 × 推理级别」各一次最小请求；两者同样按 `block-start` 判受理、只按 `code` 分类、
 * provider 间并发 / provider 内串行，真正的分岔在「每组怎么跑」那一步（Node 半的执行器）。
 */

import { isPlainObject } from '@/shared/types'

/**
 * 计划里的一条**探测请求**：一次请求 = 一个「模型 × 推理级别」组合（`effort` 缺省即不带 `reasoningEffort`）。
 * 验证的每个模型只占一条不带档位的请求；探测档位按模型展开至多七条。
 */
export interface VerifyProbe {
    provider: string
    model: string
    effort?: string
}

/**
 * 单次探测的判定结果。分类只依据宿主 `LlmFailure` 的 `code`——宿主明令
 * 「route on `code`, never by parsing `message`」，故两侧都不做文案比对。
 */
export type ProbeOutcome =
    /** 收到 `block-start`：该「模型 × 档位」确实受支持 */
    | 'usable'
    /** 宿主在派发前本地判定该档位不被支持（`UNSUPPORTED_REASONING_EFFORT`，请求根本没发出去） */
    | 'unsupported-effort'
    /** 传输层失败且无 HTTP status：端点不可达（DNS / 拒绝连接） */
    | 'unreachable'
    /** 额度或余额耗尽；额度可能只覆盖其中某个模型，故只压该模型、不参与 provider 级短路 */
    | 'quota'
    /** 凭据缺失或无效 */
    | 'credential'
    /** 瞬态失败：上游限流（429）或超时，本次没得到结论——**不是该模型/档位不可用的证据**，重试仍可能通过 */
    | 'rate-limit'
    /** 瞬态失败：本方或上游超时，理由同上 */
    | 'timeout'
    /**
     * 中止（外部：用户点停止 / 关窗 / 断连；或上游主动中止）：**这一条没有结论**。
     * 故不入明细、不发帧、不短路——记成「其它失败」等于把用户按的停止说成厂商拒绝。
     */
    | 'aborted'
    /** 其它厂商侧拒绝（含上游 5xx）：**不能断定后续请求必然失败**，故既不短整组也不短该模型的档位尾 */
    | 'other'

/**
 * provider 级失败：命中即整组短路——理由只有一条：**能断定后续请求必然失败**。
 *
 * - `unreachable` / `credential`：同一提供方共用同一 url 与同一把 key，一次过不了后面同样过不了。
 *   额度耗尽不在其列（额度可能只覆盖其中某个模型），理由见 `quota` 那一支。
 * - `timeout`：**仅当它就是本组的首个请求**才成立（判据见 `@/probe-verdict` 的 `providerBlockReason`），
 *   故它不由本类型自己判定。单看一次超时只是「这次没跑成」，什么也断定不了。
 */
export type ProviderBlockReason = 'unreachable' | 'credential' | 'timeout'

/**
 * 该失败**单看自身**是否就否定整个提供方（即与请求内容无关、换个模型照样过不去）。
 *
 * 超时不在其列：它要连「本组首个请求」这条一起才成立，那是 `providerBlockReason` 的事。
 */
export function isProviderBlocking(outcome: ProbeOutcome): outcome is Exclude<ProviderBlockReason, 'timeout'> {
    return outcome === 'unreachable' || outcome === 'credential'
}

/**
 * 该结果是否只是本次没跑成（限流 / 超时），而非模型或档位本身的缺陷。
 *
 * 这类结论既不算不可用，也**不能用来短该模型的后续档位**：把它们当失败等于把一次偶发抖动
 * 固化成「这个档位不可用」。中止不在其列：它压根没跑成，由执行层直接不入账。
 */
export function isTransientOutcome(outcome: ProbeOutcome): boolean {
    return outcome === 'rate-limit' || outcome === 'timeout'
}

/** 失败的原始事实（宿主 `LlmFailure` 的可序列化子集）：供调用方做比本插件更细的分类与展示 */
export interface VerifyFailureFacts {
    code: string
    /** HTTP 状态；传输层失败没有它（宿主兜底对象只给 code 与 message） */
    status: number | undefined
    /** 人类可读的失败描述——**仅供展示与诊断，分类绝不可依赖它**（各厂商措辞不同且会变） */
    message: string
}

/**
 * 单条探测明细：一个「提供方 / 模型 / 推理级别」及其结论。调用方可据此做后续操作
 * （只重验某个提供方、只补验某些档位、按 code 细分失败原因等），不必再回解析统计值。
 *
 * 明细只含**实际发出**的探测：被短路掉的从未发出去、没有结论可言。哪几条没跑，
 * 由逐提供方的 `planned` 与 `probed` 之差给出（短路以整组为单位，故按组定位即可）。
 */
export interface VerifyProbeResult {
    provider: string
    model: string
    /** 推理级别；模型未声明档位时为 undefined（不带档位探测），经 JSON 传输后该键缺省 */
    effort: string | undefined
    outcome: ProbeOutcome
    /** 失败时的原始事实；收到 block-start 时为 undefined */
    failure: VerifyFailureFacts | undefined
}

/** 一个提供方的验证结论：逐条明细 + 短路情况（由 Node 半执行器产出，供汇报函数消费） */
export interface ProviderProbeOutcome {
    provider: string
    /** 与该组探测请求清单前缀对齐：短路时长度小于 planned */
    results: VerifyProbeResult[]
    blockedBy: ProviderBlockReason | undefined
    /** 计划请求数（验证每模型一条；探测档位逐档展开） */
    planned: number
    /** 计划里带档位的条目数（验证恒为 0——验的是模型本身，不占级别） */
    plannedEfforts: number
    /** 计划验过的模型数（按「提供方 / 模型」去重）：取自计划而非明细——模型若被短路到一条未发，明细里就没有它 */
    tested: number
}

/** 单个提供方的验证结论（逐提供方可见） */
export interface VerifyProviderReport {
    provider: string
    /** 端点可达：全程未出现传输层失败 */
    reachable: boolean
    /**
     * 凭据有效：可达且全程未出现凭据类失败（从未可达时不作断言）。
     * **额度耗尽不在此列**——它多半是按模型设的额度，属模型级事实，否定不了整把 key。
     */
    keyValid: boolean
    /** 整组是否因 provider 级失败被短路 */
    skipped: boolean
    blockedBy: ProviderBlockReason | undefined
    /** 该组计划验过的模型数（按「提供方 / 模型」去重），即用户勾了几个 */
    tested: number
    /** 该组内可用模型数（按「提供方 / 模型」去重） */
    models: number
    /** 该组内可用档位数 */
    efforts: number
    /** 判定为「档位不支持」的请求数：逐模型逐档位，故与其它失败分开计数 */
    unsupported: number
    /** 计划请求数（验证每模型一条；探测档位逐档展开） */
    planned: number
    /** 计划里带档位的条目数（验证恒为 0） */
    plannedEfforts: number
    /** 实际发出的请求数（短路时小于 planned） */
    probed: number
}

/**
 * 一个「提供方 / 模型」下的某个推理级别被判为**不被支持**。
 *
 * 只收**明确**判为不支持的；超时、限流、额度耗尽、端点不可达都只是没验成，不在此列
 * （判据见 docs/decisions.md「验证」）。
 */
export interface UnsupportedEffort {
    provider: string
    model: string
    effort: string
}

/**
 * 一个「提供方 / 模型」下的某个推理级别被判为**确实可用**（收到 `block-start`）。
 *
 * 与 `UnsupportedEffort` 对称的一只：探测档位要把可用档位**写回配置**，故同样得逐条定位。
 * 只收带档位的条目：不带档位的那次请求验的是模型本身，没有「哪一档可用」可言。
 */
export interface UsableEffort {
    provider: string
    model: string
    effort: string
}

/**
 * 探测档位「收敛写回」的结果（相对本轮开始前的配置）：浏览器半直接拿去显示，不再自己算。
 *
 * 三个数字的口径都以**本轮开始前**的档位表为基线，而不是以临时预声明的表为基线——
 * 预声明只是为了让请求出得去（宿主按配置里的声明校验档位），它不是用户配置的一部分，
 * 把它算进「新增」会虚报成凭空多出来的档位。
 */
export interface ProbeFillResult {
    /** 实际改写了档位表的模型数 */
    models: number
    /** 新增的档位条数（原来没声明、这轮验出能用） */
    added: number
    /** 删掉的档位条数（原来声明了、这轮判为不能用，或只是临时预声明后收回的——后者不计入） */
    removed: number
}

/** 验证结果汇总：逐提供方汇报 + 逐条明细 + 不支持档位明细 + 全局计数 */
export interface VerifySummary {
    providers: readonly VerifyProviderReport[]
    /** 逐条探测明细，顺序为「组序 → 组内探测序」，可重复消费 */
    results: readonly VerifyProbeResult[]
    /**
     * 明确判为不被支持的档位明细：写配置就得逐条定位（理由见 `UnsupportedEffort`）。
     * 只有探测档位会产出它（收敛时按「剔除不支持」开关扣减）；验证只验模型本身、不带档位，恒为空。
     */
    unsupportedEfforts: readonly UnsupportedEffort[]
    /**
     * 判为可用的档位明细（与 `unsupportedEfforts` 同源同构）：探测档位据此写回补全档位；
     * 验证不带档位，恒为空。
     */
    usableEfforts: readonly UsableEffort[]
    /**
     * 收敛结论的增删统计：**只有探测档位给出**（验证只读、不碰配置，故此字段恒缺省）。
     * 它随终帧一起回到浏览器半，因为收敛发生在整轮探测之后、终帧之前。「自动写入」开启即已写入的
     * 补全统计；关闭时这里是「可补全」的假设统计，浏览器半据此换措辞汇报。
     */
    fill?: ProbeFillResult
    /** 本次验证的模型数（按「提供方 / 模型」去重），即用户勾了几个；取自计划而非明细，故被短路的模型也在内 */
    tested: number
    /** 可用模型数：至少有一条请求通过的去重模型数（验证即「勾选的模型里跑通几个」；探测档位全档位失败的模型不计入） */
    models: number
    /** 判可用的带档位请求数（验证恒为 0） */
    efforts: number
    /** 判「档位不支持」的请求数（验证恒为 0） */
    unsupported: number
    /** 计划请求数（验证每模型一条，即勾选模型数；探测档位逐档展开） */
    planned: number
    /** 计划里带档位的条目数（验证恒为 0；探测档位收尾文案「X / Y 个推理级别」的分母） */
    plannedEfforts: number
    /** 实际发出的请求数（短路时小于 planned） */
    probed: number
}

/**
 * 一次验证运行的进度帧判别联合。投递顺序即帧顺序：先是唯一一条 `opened`，
 * 随后每完成一条探测发一条 `probed`，最后收于唯一一条终帧（`done` 或 `failed`）。
 *
 * 中途被中止（用户点停止、关窗、连接断开）时**不发终帧**——收到流自然结束却没等到终帧，
 * 消费方即知这轮没跑完。
 */
export type VerifyProgressFrame =
    /** 开流即发的第一条：让 UI 立刻知道总共几项，而不是对着空白等第一条结果 */
    | { type: 'opened'; total: number }
    /**
     * 一条探测出结果。`done`/`total` 是跨提供方并行的进度位置，可直接显示为进度：
     * `total` 是计划条目数（与 `planned`/`probed` 同口径），
     * `done` 是已了结的条目数（被短路而未发出的计入），故 `done ≤ total` 恒成立。
     * `skipped` 在该结论短路了后续请求时出现，值为未发出的条数。`effort` 缺省即不带档位的模型级结论。
     */
    | {
        type: 'probed'
        provider: string
        model: string
        effort: string | undefined
        outcome: ProbeOutcome
        skipped?: number
        done: number
        total: number
    }
    /** 终帧：整轮跑完，`summary` 承载完整结论 */
    | { type: 'done'; summary: VerifySummary }
    /**
     * 终帧：整轮没能开跑（入参非法、超配额等）或执行中途异常，`message` 是 Node 半给出的中文原因。
     * 与「中止」的区别：中止**没有**终帧，消费方据「流结束却无终帧」判中止。
     */
    | { type: 'failed'; message: string }

/** 单条探测结果帧；消费方逐条格式化展示，故单列一个名字 */
export type VerifyProbedFrame = Extract<VerifyProgressFrame, { type: 'probed' }>

/** 非终帧：逐条回调的形状。两个终帧（`done` / `failed`）由调用方单独接住——它们带的是整轮结局，不是可逐行展示的一条 */
export type VerifyProgressUpdate = Exclude<VerifyProgressFrame, { type: 'done' | 'failed' }>

/** 宿主 hmr 的 SSE 分帧格式：单行 `data: ` + 空行分隔（`DSH/packages/boot/hmr/src/index.ts`） */
const DATA_PREFIX = 'data: '

/**
 * 把一帧编成线上文本（单行 `data: ` + 空行分帧）。
 *
 * 内容类型取 `text/event-stream` 的缘由（宿主 gzip 中间件显式跳过它）见 `src/rpc.ts` 与 docs/host-api.md。
 */
export function encodeProgressFrame(frame: VerifyProgressFrame): string {
    return `${DATA_PREFIX}${JSON.stringify(frame)}\n\n`
}

/**
 * 解析一条 `data: ` 行；SSE 注释帧（`: …` 心跳）与非法 JSON 一律返回 undefined，调用方跳过即可。
 *
 * 逐字段校验而非 `JSON.parse` 了事：这条流的终点 `done.summary` 直接驱动卡片上的统计数字。
 */
export function decodeProgressFrame(line: string): VerifyProgressFrame | undefined {
    if (!line.startsWith(DATA_PREFIX)) return undefined
    try {
        const parsed: unknown = JSON.parse(line.slice(DATA_PREFIX.length))
        return isProgressFrame(parsed) ? parsed : undefined
    } catch {
        return undefined
    }
}

/** 帧的形状校验；只查消费方真正会读的字段，不做整棵 `VerifySummary` 的深度校验 */
function isProgressFrame(value: unknown): value is VerifyProgressFrame {
    if (!isPlainObject(value)) return false
    if (value.type === 'opened') return typeof value.total === 'number'
    if (value.type === 'probed') {
        return typeof value.provider === 'string' && typeof value.model === 'string'
            && typeof value.outcome === 'string' && typeof value.done === 'number' && typeof value.total === 'number'
            // effort 缺省即不带档位的模型级结论，键缺省是合法形态
            && (value.effort === undefined || typeof value.effort === 'string')
            // skipped 仅在该结论短路了后续请求时出现
            && (value.skipped === undefined || typeof value.skipped === 'number')
    }
    // failed 帧只校验消费方会读的那个字段：整轮结局的原因要原样展示，文案缺失即无信息可用
    if (value.type === 'failed') return typeof value.message === 'string'
    // done 帧只校验收尾那行文案要用的四个计数；其余字段不做深度校验
    return value.type === 'done' && isPlainObject(value.summary)
        && typeof value.summary.tested === 'number' && typeof value.summary.models === 'number'
        && typeof value.summary.efforts === 'number' && typeof value.summary.plannedEfforts === 'number'
}
