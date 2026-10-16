// 用例覆盖：src/probe-verdict.ts 的失败分类与两级短路判据、src/probe-plan.ts 的请求计划展开（逐模型逐档位 / needTest 声明 /
// 入参校验与配额）与按提供方分组、src/probe-report.ts 的逐组汇报与汇总求和，以及 src/verify.ts 带桩跑通的整条执行链（基线探测现发 +
// 分组串行 + 两级短路，含「本组首个请求超时即短整组」与进度帧的 done 不变量）
import { verifyModels } from '@/verify'
import { groupProbesByProvider, planProbes } from '@/probe-plan'
import { reportProvider, summarizeProviders } from '@/probe-report'
import { classifyFailure, providerBlockReason, shouldSkipModelTail, shouldSkipModelTailAfterBaseline } from '@/probe-verdict'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm/types'
import { decodeProgressFrame, encodeProgressFrame, isProviderBlocking, isTransientOutcome } from '@/shared/verify-progress'
import type { ProbeOutcome, VerifyFailureFacts, VerifyProbe, VerifyProbeResult, VerifyProbedFrame, VerifyProgressFrame, VerifyProviderReport } from '@/shared/verify-progress'
import { check, stable } from '@test/helper'

/**
 * 一个模型的载荷；参数收 unknown 以便构造非法入参用例（RPC 入参按不可信输入校验）。
 * `needTest` 默认「有档位才需要探测」——那正是卡片按开关收敛出来的口径。
 */
const entry = (provider: unknown, model: unknown, efforts: unknown, needTest: unknown = Array.isArray(efforts) && efforts.length > 0): Record<string, unknown> => ({ provider, model, efforts, needTest })

/** 失败事实桩：message 各厂商不同，分类不得依赖它 */
const failure = (code: string, status?: number): LlmFailure =>
    ({ code, message: '文案随便写，各厂商都不一样', ...(status === undefined ? {} : { status }) }) as LlmFailure

/** 分片桩：成功流先吐 block-start，终止流只吐 finish */
const BLOCK_START = { type: 'block-start', index: 0, blockType: 'text' }
const FINISH_STOP = { type: 'finish', reason: { kind: 'stop' } }
const finishError = (code: string, status?: number): StreamChunk =>
    ({ type: 'finish', reason: { kind: 'error', failure: failure(code, status) } }) as unknown as StreamChunk

/** 宿主归一出的中止终帧（`signal?.aborted || code === 'ABORTED'` → `aborted`，见 docs/host-api.md） */
const FINISH_ABORTED = { type: 'finish', reason: { kind: 'aborted', failure: failure('ABORTED') } } as unknown as StreamChunk

/** 失败事实（`VerifyFailureFacts`）桩：只给 code 与 message，status 恒缺（pi-ai 路径即如此） */
const failureFacts = (code: string): VerifyFailureFacts => ({ code, status: undefined, message: '文案随便写' })

/** 同上但自定义 message：基线对照判据要看报错原文，故得能构造出回显档位值的报文 */
const finishErrorText = (code: string, status: number, message: string): StreamChunk =>
    ({
        type: 'finish',
        reason: { kind: 'error', failure: { code, status, message } as LlmFailure },
    }) as unknown as StreamChunk

/** 执行本文件的全部用例 */
export async function run(): Promise<void> {
    // ---------- planProbes：逐模型逐档位展开（各模型档位数量不同，是累加非相乘），清单里只有被验对象、探测不进计划 ----------
    check(
        'planProbes 逐模型逐档位展开（清单里没有探测）',
        stable(planProbes({ models: [entry('a', 'm1', ['off', 'high']), entry('a', 'm2', ['low'])] })) === stable([
            { provider: 'a', model: 'm1', effort: 'off', needTest: true },
            { provider: 'a', model: 'm1', effort: 'high', needTest: true },
            { provider: 'a', model: 'm2', effort: 'low', needTest: true },
        ]),
    )
    // ---------- planProbes：没有档位可验时，那一次不带档位的请求本身就是被验对象 ----------
    check(
        'planProbes 无档位模型只留被验的那一次',
        stable(planProbes({ models: [entry('a', 'plain', []), entry('a', 'x', ['max'])] })) === stable([
            { provider: 'a', model: 'plain', needTest: false },
            { provider: 'a', model: 'x', effort: 'max', needTest: true },
        ]),
    )
    // ---------- planProbes：入参校验一律拒绝 ----------
    check('planProbes 非对象拒绝', planProbes(undefined) === undefined)
    check('planProbes models 非数组拒绝', planProbes({ models: {} }) === undefined)
    check('planProbes models 空数组拒绝', planProbes({ models: [] }) === undefined)
    check('planProbes 条目非对象拒绝', planProbes({ models: ['a'] }) === undefined)
    check('planProbes provider 非字符串拒绝', planProbes({ models: [entry('', 'm', [])] }) === undefined)
    check('planProbes model 非字符串拒绝', planProbes({ models: [entry('a', 1, [])] }) === undefined)
    check('planProbes efforts 非数组拒绝', planProbes({ models: [{ provider: 'a', model: 'm' }] }) === undefined)
    check('planProbes 档位非字符串拒绝', planProbes({ models: [entry('a', 'm', [1])] }) === undefined)
    // 档位必须落在 harness 支持的取值内（'none' 是目录侧拼写，写入配置时已归一为 'off'）
    check('planProbes 未知档位拒绝', planProbes({ models: [entry('a', 'm', ['turbo'])] }) === undefined)
    check('planProbes 目录拼写 none 拒绝', planProbes({ models: [entry('a', 'm', ['none'])] }) === undefined)
    // ---------- planProbes：needTest 由浏览器半声明，缺了或不是布尔值就无从判「要不要发探测」 ----------
    check('planProbes needTest 缺失拒绝', planProbes({ models: [{ provider: 'a', model: 'm', efforts: [] }] }) === undefined)
    check('planProbes needTest 非布尔拒绝', planProbes({ models: [entry('a', 'm', [], 'yes')] }) === undefined)
    // 无档位却声明要探测 = 探测没有对照对象，纯属白烧额度，按非法处理
    check('planProbes 无档位却声明 needTest 拒绝', planProbes({ models: [entry('a', 'm', [], true)] }) === undefined)
    // ---------- planProbes：请求总数超上限即拒绝（逐档位展开会累积条目，静默截断会漏验） ----------
    const many = Array.from({ length: 100 }, (_, i) => entry('a', `m${i}`, ['low', 'medium', 'high']))
    check('planProbes 超上限拒绝', planProbes({ models: many }) === undefined)
    // 探测也占一次真实请求，故上限按「档位数 + 探测数」计：40 个四档模型 = 40 × (4 + 1) = 200，
    // 但清单里只有被验对象，故长度为 160
    const atLimit = Array.from({ length: 40 }, (_, i) => entry('a', `m${i}`, ['low', 'medium', 'high', 'off']))
    check('planProbes 恰在上限放行', planProbes({ models: atLimit })?.length === 160)
    // 再多一个模型即 41 × 5 = 205 > 200：探测计入上限而非照旧放行
    check('planProbes 探测计入上限', planProbes({ models: [...atLimit, entry('a', 'm40', ['low', 'medium', 'high', 'off'])] }) === undefined)

    // ---------- groupProbesByProvider：同 provider 归一组、组内原序、下标回填 ----------
    const interleaved: VerifyProbe[] = [
        { provider: 'a', model: 'm1', effort: 'off', needTest: true },
        { provider: 'b', model: 'n1', effort: 'low', needTest: true },
        { provider: 'a', model: 'm2', effort: 'high', needTest: true },
    ]
    check(
        'groupProbesByProvider 按 provider 归组并保序',
        stable(groupProbesByProvider(interleaved)) === stable([
            { provider: 'a', indexes: [0, 2], probes: [interleaved[0], interleaved[2]] },
            { provider: 'b', indexes: [1], probes: [interleaved[1]] },
        ]),
        groupProbesByProvider(interleaved),
    )
    check('groupProbesByProvider 空输入得空组', groupProbesByProvider([]).length === 0)

    // ---------- classifyFailure：只认 code 与 status，绝不比对文案 ----------
    check('classifyFailure 档位不被支持', classifyFailure(failure('UNSUPPORTED_REASONING_EFFORT')) === 'unsupported-effort')
    check('classifyFailure 额度耗尽', classifyFailure(failure('QUOTA', 429)) === 'quota')
    // 宿主给账户余额不足定的字面量就是 ACCOUNT_QUOTA（宿主 `error.js`），写成 ACCOUNT_QUOTA_EXCEEDED 永不命中
    check('classifyFailure 余额耗尽', classifyFailure(failure('ACCOUNT_QUOTA', 402)) === 'quota')
    check('classifyFailure 凭据无效', classifyFailure(failure('INVALID_CREDENTIAL', 401)) === 'credential')
    check('classifyFailure 凭据缺失', classifyFailure(failure('MISSING_CREDENTIAL', 401)) === 'credential')
    // 不可达只认传输层失败码。pi-ai 侧错误一律不带 status（宿主抛错只给 message + code），
    // 故「无 status」不能当不可达——那会把一次 400 或一次 5xx 误报成断线并短路整个 provider，这是实测踩过的坑
    check('classifyFailure 传输层失败码判端点不可达', classifyFailure(failure('TRANSPORT')) === 'unreachable')
    check('classifyFailure 流被截断亦判不可达', classifyFailure(failure('STREAM_CLOSED')) === 'unreachable')
    check('classifyFailure 未识别的码归其它而非不可达', classifyFailure(failure('PI_AI_ERROR')) === 'other')
    check('classifyFailure 有 status 归其它', classifyFailure(failure('MODEL_NOT_FOUND', 404)) === 'other')
    // 档位码优先：它由宿主在派发前本地抛出，本就没有 HTTP 响应
    check('classifyFailure 档位码不被 status 盖过', classifyFailure(failure('UNSUPPORTED_REASONING_EFFORT', 400)) === 'unsupported-effort')
    // 零内容完成：请求成功抵达却无内容块，归其它（退化完成），不参与任何短路
    check('classifyFailure 零内容完成归其它而非不可达', classifyFailure(failure('EMPTY_RESPONSE')) === 'other')
    // 瞬态：本次没跑成，不是否定模型或档位的证据。实测 429 挡掉的那一档，隔一会儿就通了，
    // 当成「不可用」还顺手跳过后续档位，等于把一次抖动固化成结论
    check('classifyFailure 上游限流归瞬态而非不可用', classifyFailure(failure('RATE_LIMIT', 429)) === 'rate-limit')
    check('classifyFailure 上游超时归瞬态而非不可用', classifyFailure(failure('TIMEOUT')) === 'timeout')
    // 中止不是失败：用户按的停止与上游主动中止都归到它，落到「其它」会把停止说成厂商拒绝
    check('classifyFailure 中止单列一态', classifyFailure(failure('ABORTED')) === 'aborted')

    // ---------- isProviderBlocking：单看自身就否定整个提供方的只有端点不通与凭据无效 ----------
    check('isProviderBlocking 端点不可达', isProviderBlocking('unreachable') === true)
    check('isProviderBlocking 额度耗尽不短路（额度可能只覆盖其中某个模型）', isProviderBlocking('quota') === false)
    check('isProviderBlocking 凭据无效', isProviderBlocking('credential') === true)
    check('isProviderBlocking 档位不支持不短路', isProviderBlocking('unsupported-effort') === false)
    check('isProviderBlocking 其它失败不短路', isProviderBlocking('other') === false)
    check('isProviderBlocking 可用不短路', isProviderBlocking('usable') === false)
    check('isProviderBlocking 限流不短路（换个时间可能就通）', isProviderBlocking('rate-limit') === false)

    // ---------- providerBlockReason：判据只有「能断定后续请求必然失败」 ----------
    check('providerBlockReason 端点不通与凭据无效照旧短路', providerBlockReason('unreachable', false) === 'unreachable' && providerBlockReason('credential', true) === 'credential')
    check('providerBlockReason 首个请求超时短整组，理由记 timeout 而非 unreachable', providerBlockReason('timeout', true) === 'timeout')
    check('providerBlockReason 首个之后的超时不短路（链路已经跑通过，只是这一次慢）', providerBlockReason('timeout', false) === undefined)
    check('providerBlockReason 首个请求限流不当不可达（端点明明有应答）', providerBlockReason('rate-limit', true) === undefined)
    check('providerBlockReason 额度耗尽即便首个也不短整组（额度可能只覆盖其中某个模型）', providerBlockReason('quota', true) === undefined)
    check('providerBlockReason 可用不短路', providerBlockReason('usable', true) === undefined)
    check('providerBlockReason 厂商侧拒绝不短整组（多半是服务端的一次性故障）', providerBlockReason('other', true) === undefined)

    // ---------- shouldSkipModelTail：档位请求上只有额度耗尽能断定后续必然失败 ----------
    check('shouldSkipModelTail 额度耗尽短到该模型尾', shouldSkipModelTail('quota', failureFacts('QUOTA')) === true)
    check('shouldSkipModelTail 上游 5xx 不断（换个档位可能就通）', shouldSkipModelTail('other', failureFacts('SERVER')) === false)
    check('shouldSkipModelTail 参数不正确不断（它正是「只否定这一档」的候选）', shouldSkipModelTail('other', failureFacts('INVALID_REQUEST')) === false)
    check('shouldSkipModelTail 限流与超时不断（只否定了这一次）', shouldSkipModelTail('rate-limit', failureFacts('RATE_LIMIT')) === false && shouldSkipModelTail('timeout', failureFacts('TIMEOUT')) === false)
    check('shouldSkipModelTail 可用不短', shouldSkipModelTail('usable', undefined) === false)
    check('shouldSkipModelTail 退化完成（有结论但无失败事实）不短', shouldSkipModelTail('quota', undefined) === false)

    // ---------- shouldSkipModelTailAfterBaseline：基线不带档位，失败与档位无关 ----------
    check('基线额度耗尽短该模型尾', shouldSkipModelTailAfterBaseline('quota') === true)
    check('基线被厂商确定性拒绝（模型不存在 / 参数被拒 / 无权限）短该模型尾', shouldSkipModelTailAfterBaseline('other') === true)
    check('基线限流与超时不断（冷启动、限流窗口都可能让下一次反而跑通）', shouldSkipModelTailAfterBaseline('rate-limit') === false && shouldSkipModelTailAfterBaseline('timeout') === false)
    // 中止没有结论，什么也没否定：按它短掉整个模型的档位尾 = 把用户按的停止当成厂商拒绝
    check('基线中止不断（没有结论可言）', shouldSkipModelTailAfterBaseline('aborted') === false && providerBlockReason('aborted', true) === undefined && shouldSkipModelTail('aborted', undefined) === false)
    check('基线可用不短', shouldSkipModelTailAfterBaseline('usable') === false)

    // ---------- isTransientOutcome：瞬态既不算不可用，也不能用来短该模型的后续档位 ----------
    check('isTransientOutcome 限流', isTransientOutcome('rate-limit') === true)
    check('isTransientOutcome 超时', isTransientOutcome('timeout') === true)
    check('isTransientOutcome 厂商侧拒绝不是瞬态', isTransientOutcome('other') === false)
    check('isTransientOutcome 档位不支持不是瞬态', isTransientOutcome('unsupported-effort') === false)
    check('isTransientOutcome 可用不是瞬态', isTransientOutcome('usable') === false)

    // ---------- reportProvider：可用模型去重、档位不支持单列、可达与凭据取自全程（含探测） ----------
    const detail = (model: string, outcome: ProbeOutcome, effort?: string): VerifyProbeResult =>
        ({ provider: 'a', model, effort, outcome, failure: undefined })
    // tested 取自计划而非明细，故与 results 无关，桩里固定给 2
    const report = (results: VerifyProbeResult[], blockedBy?: 'unreachable' | 'credential', tests: VerifyProbeResult[] = []) =>
        reportProvider({ provider: 'a', results, tests, blockedBy, planned: 3, plannedEfforts: 3, tested: 2 })
    const allOk = report([detail('m1', 'usable', 'off'), detail('m1', 'usable', 'high'), detail('m2', 'usable', 'low')])
    check(
        'reportProvider 全可用：同模型多档只计一个可用模型',
        stable(allOk) === stable({
            provider: 'a', reachable: true, keyValid: true, skipped: false, blockedBy: undefined,
            models: 2, efforts: 3, unsupported: 0, planned: 3, plannedEfforts: 3, probed: 3, tested: 2,
        }),
        allOk,
    )
    const oneUnsupported = report([detail('m1', 'usable', 'off'), detail('m1', 'unsupported-effort', 'high'), detail('m2', 'usable', 'low')])
    check(
        'reportProvider 档位不支持单列，不混入其它失败',
        stable(oneUnsupported) === stable({
            provider: 'a', reachable: true, keyValid: true, skipped: false, blockedBy: undefined,
            models: 2, efforts: 2, unsupported: 1, planned: 3, plannedEfforts: 3, probed: 3, tested: 2,
        }),
        oneUnsupported,
    )
    const dead = report([detail('m1', 'unreachable')], 'unreachable')
    check(
        'reportProvider 端点不可达：短路且不臆断凭据有效',
        stable(dead) === stable({
            provider: 'a', reachable: false, keyValid: false, skipped: true, blockedBy: 'unreachable',
            models: 0, efforts: 0, unsupported: 0, planned: 3, plannedEfforts: 3, probed: 1, tested: 2,
        }),
        dead,
    )
    // 可达但额度耗尽：端点通、凭据没被否——额度多半是按模型设的，否定不了整把 key。
    // 额度不构成 provider 级短路，故此处不带 blockedBy；出了什么事看 m1 自己的明细条目
    const outOfQuota = report([detail('m1', 'usable', 'off'), detail('m1', 'quota', 'high')])
    check(
        'reportProvider 额度耗尽：可达且不否凭据（额度是模型级事实），不算 provider 级失败',
        stable(outOfQuota) === stable({
            provider: 'a', reachable: true, keyValid: true, skipped: false, blockedBy: undefined,
            models: 1, efforts: 1, unsupported: 0, planned: 3, plannedEfforts: 3, probed: 2, tested: 2,
        }),
        outOfQuota,
    )
    // 探测也是真发出去的一次请求，故它撞上的端点 / 凭据问题同样如实记账，只是不计任何计数
    const probedDead = report([], 'unreachable', [detail('m1', 'unreachable')])
    check(
        'reportProvider 探测撞端点不可达：如实记为不可达，明细与计数皆空',
        stable(probedDead) === stable({
            provider: 'a', reachable: false, keyValid: false, skipped: true, blockedBy: 'unreachable',
            models: 0, efforts: 0, unsupported: 0, planned: 3, plannedEfforts: 3, probed: 0, tested: 2,
        }),
        probedDead,
    )
    const probedNoKey = report([], undefined, [detail('m1', 'quota')])
    check(
        'reportProvider 探测撞额度耗尽：端点可达、凭据未被否（额度是模型级事实），且不构成短路故 skipped 为假',
        stable(probedNoKey) === stable({
            provider: 'a', reachable: true, keyValid: true, skipped: false, blockedBy: undefined,
            models: 0, efforts: 0, unsupported: 0, planned: 3, plannedEfforts: 3, probed: 0, tested: 2,
        }),
        probedNoKey,
    )

    // ---------- summarizeProviders：逐字段求和 ----------
    const ok: VerifyProviderReport = {
        provider: 'a', reachable: true, keyValid: true, skipped: false, blockedBy: undefined,
        models: 2, efforts: 3, unsupported: 1, planned: 3, plannedEfforts: 3, probed: 3, tested: 2,
    }
    const blocked: VerifyProviderReport = {
        provider: 'b', reachable: false, keyValid: false, skipped: true, blockedBy: 'unreachable',
        models: 0, efforts: 0, unsupported: 0, planned: 5, plannedEfforts: 4, probed: 1, tested: 3,
    }
    const details: VerifyProbeResult[] = [detail('m1', 'usable', 'off')]
    check(
        'summarizeProviders 求和（短路组的计划数计入、实测数只计已发出的、tested 取自各组计划）',
        stable(summarizeProviders([ok, blocked], details)) === stable({
            providers: [ok, blocked], results: details, unsupportedEfforts: [], usableEfforts: [{ provider: 'a', model: 'm1', effort: 'off' }], tested: 5, models: 2, efforts: 3, unsupported: 1, planned: 8, plannedEfforts: 7, probed: 4,
        }),
        summarizeProviders([ok, blocked], details),
    )
    check(
        'summarizeProviders 空输入',
        stable(summarizeProviders([], [])) === stable({
            providers: [], results: [], unsupportedEfforts: [], usableEfforts: [], tested: 0, models: 0, efforts: 0, unsupported: 0, planned: 0, plannedEfforts: 0, probed: 0,
        }),
    )
    // 不支持档位明细由结果派生：剔除要写配置就得逐条定位，聚合与明细同源、不另立口径
    const unsupportedDetail = [
        { provider: 'a', model: 'm1', effort: 'high', outcome: 'unsupported-effort', failure: undefined },
    ] as VerifyProbeResult[]
    check(
        'summarizeProviders 不支持档位明细逐条给出',
        stable(summarizeProviders([], unsupportedDetail).unsupportedEfforts)
        === stable([{ provider: 'a', model: 'm1', effort: 'high' }]),
        summarizeProviders([], unsupportedDetail).unsupportedEfforts,
    )
    // 可用档位明细与不支持明细同源同构：探测式填充据此写回补全，两处各筛一遍必然分叉
    const usableDetail = [
        { provider: 'a', model: 'm1', effort: 'high', outcome: 'usable', failure: undefined },
        // 不带档位的请求验的是模型本身，没有「哪一档可用」可言，不进这两只明细
        { provider: 'a', model: 'm2', effort: undefined, outcome: 'usable', failure: undefined },
    ] as VerifyProbeResult[]
    check(
        'summarizeProviders 可用档位明细逐条给出，且不含不带档位的条目',
        stable(summarizeProviders([], usableDetail).usableEfforts)
        === stable([{ provider: 'a', model: 'm1', effort: 'high' }]),
        summarizeProviders([], usableDetail).usableEfforts,
    )
    // tested 记「计划里探过的模型」而非「可用的模型」：全档位被短路的模型也要计入，否则开档位模式下总数小于用户勾选数。
    // 它取自各组汇报的 tested，故与明细是否为空无关
    const allFailed: VerifyProviderReport = {
        provider: 'a', reachable: true, keyValid: true, skipped: false, blockedBy: undefined,
        models: 0, efforts: 0, unsupported: 0, planned: 2, plannedEfforts: 2, probed: 0, tested: 1,
    }
    check(
        'summarizeProviders tested 计入全档位被短路的模型，与可用模型数分开',
        summarizeProviders([allFailed], []).tested === 1 && summarizeProviders([allFailed], []).models === 0,
        summarizeProviders([allFailed], []),
    )

    // ---------- verifyModels：带桩跑通整条链，逐组串行且短路 ----------
    /** 桩：按「模型@档位 -> 分片序列」应答，未登记的组合默认成功；记录调用顺序与提示词；`onCall` 供用例在中途触发中止 */
    const stub = (script: Record<string, readonly StreamChunk[]>, onCall?: (callIndex: number) => void) => {
        const calls: string[] = []
        const prompts: string[] = []
        const stream = (options: {
            provider: string
            model: string
            reasoningEffort?: string
            messages: readonly { role: string; content: readonly { type: 'text'; text: string }[] }[]
        }): AsyncIterable<StreamChunk> => {
            const tag = `${options.model}${options.reasoningEffort === undefined ? '' : `@${options.reasoningEffort}`}`
            calls.push(`${options.provider}/${tag}`)
            prompts.push(options.messages[0].content[0].text)
            onCall?.(calls.length)
            const chunks = script[tag] ?? [BLOCK_START as unknown as StreamChunk, FINISH_STOP as unknown as StreamChunk]
            return (async function* () { for (const chunk of chunks) yield chunk })()
        }
        return { llm: { stream } as unknown as Pick<LlmRuntime, 'stream'>, calls, prompts }
    }

    {
        const { llm, prompts, calls } = stub({})
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high']), entry('a', 'm2', ['low'])] })
        check(
            'verifyModels 全可用：逐档位各发一次并逐组汇报（探测另发，不计统计）',
            summary.models === 2 && summary.efforts === 3 && summary.probed === 3 && summary.planned === 3
            && summary.plannedEfforts === 3 && summary.tested === 2
            && calls.length === 5
            && summary.providers.length === 1 && summary.providers[0].reachable && summary.providers[0].keyValid,
            summary,
        )
        // 明细：逐条给出「提供方 / 模型 / 档位 / 结论」，顺序为「组序 → 组内探测序」；探测不在其中
        check(
            'verifyModels 返回逐条明细（不含探测）',
            stable(summary.results) === stable([
                { provider: 'a', model: 'm1', effort: 'off', outcome: 'usable', failure: undefined },
                { provider: 'a', model: 'm1', effort: 'high', outcome: 'usable', failure: undefined },
                { provider: 'a', model: 'm2', effort: 'low', outcome: 'usable', failure: undefined },
            ]),
            summary.results,
        )
        // 提示词固定为一句 Just say OK——它是省额度的前提，不该被顺手改成更啰嗦的说法
        check('verifyModels 每次请求的提示词都是 Just say OK', prompts.length === 5 && prompts.every((text) => text === 'Just say OK'), prompts)
    }
    {
        // 没声明档位的模型要验的那一次不带档位：它算一次被验请求（进 planned），但验的是模型不是级别，不进 plannedEfforts——
        // 否则开档位模式下「X / Y 个推理级别」的分母会虚高，用户会以为有档位没验成
        const { llm, calls } = stub({})
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high']), entry('a', 'm2', [])] })
        check(
            'verifyModels 无档位模型的那次请求计入 planned 但不计入 plannedEfforts',
            summary.planned === 3 && summary.plannedEfforts === 2 && summary.probed === 3
            && summary.efforts === 2 && summary.models === 2 && summary.tested === 2
            && calls.length === 4,
            summary,
        )
    }
    {
        // 额度耗尽：只压该模型的剩余档位（额度可能只覆盖其中某个模型），不构成 provider 级失败，
        // 也不否凭据——它是模型级事实，整把 key 有没有效还看不出来
        const { llm, calls } = stub({ 'm1@off': [finishError('QUOTA', 429)] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high'])] })
        check(
            'verifyModels 额度耗尽跳过后续档位但不算 provider 级失败',
            calls.length === 2 && summary.probed === 1 && summary.planned === 2
            && !summary.providers[0].skipped && summary.providers[0].blockedBy === undefined
            && summary.providers[0].reachable && summary.providers[0].keyValid,
            { calls, summary },
        )
        // 明细须带上失败的原始事实，调用方可据此做比本插件更细的分类与展示
        check(
            'verifyModels 明细带失败原始事实',
            stable(summary.results) === stable([
                {
                    provider: 'a', model: 'm1', effort: 'off', outcome: 'quota',
                    failure: { code: 'QUOTA', status: 429, message: '文案随便写，各厂商都不一样' },
                },
            ]),
            summary.results,
        )
    }
    {
        // 同提供方的 url 与 key 确是共用的，额度却未必——压整组会把仍可用的模型一并漏掉
        const { llm, calls } = stub({ 'm1@off': [finishError('QUOTA', 429)] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high']), entry('a', 'm2', ['low'])] })
        check(
            'verifyModels 额度耗尽不牵连同组其它模型',
            calls.length === 4 && summary.probed === 2 && summary.planned === 3,
            { calls, summary },
        )
    }
    {
        // 限流只否定了这一次：不得跳过后续档位，也不得把它算进不可用。实测踩过的坑——某一档被 429 挡掉，
        // 记录写「不可用」且后面的档位全不验，隔一会儿手动一聊又完全正常
        const { llm, calls } = stub({ 'm1@off': [finishError('RATE_LIMIT', 429)] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high'])] })
        check(
            'verifyModels 限流不跳过后续档位',
            calls.length === 3 && summary.probed === 2 && summary.planned === 2 && summary.efforts === 1,
            { calls, summary },
        )
        check(
            'verifyModels 限流结论单列，不混成不可用',
            stable(summary.results) === stable([
                {
                    provider: 'a', model: 'm1', effort: 'off', outcome: 'rate-limit',
                    failure: { code: 'RATE_LIMIT', status: 429, message: '文案随便写，各厂商都不一样' },
                },
                { provider: 'a', model: 'm1', effort: 'high', outcome: 'usable', failure: undefined },
            ]),
            summary.results,
        )
    }
    {
        // 端点不可达：可达与凭据都判否
        const { llm, calls } = stub({ 'm1': [finishError('TRANSPORT')] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', []), entry('a', 'm2', [])] })
        check(
            'verifyModels 端点不可达短路并记为不可达',
            calls.length === 1 && summary.probed === 1 && summary.planned === 2
            && summary.providers[0].blockedBy === 'unreachable'
            && !summary.providers[0].reachable && !summary.providers[0].keyValid,
            { calls, summary },
        )
    }
    {
        // 档位不被支持是逐模型逐档位的个体结论：只跳过这一条，不短路
        const { llm, calls } = stub({ 'm1@high': [finishError('UNSUPPORTED_REASONING_EFFORT', 400)] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high'])] })
        check(
            'verifyModels 档位不支持不短路、计入 unsupported',
            calls.length === 3 && summary.probed === 2 && summary.planned === 2 && summary.unsupported === 1
            && summary.efforts === 1 && !summary.providers[0].skipped,
            { calls, summary },
        )
    }
    {
        // 厂商侧拒绝（如该模型不存在）多与具体模型有关，同样不短路
        const { llm, calls } = stub({ 'm1': [finishError('MODEL_NOT_FOUND', 404)] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', []), entry('a', 'm2', [])] })
        check(
            'verifyModels 其它厂商拒绝不短路',
            // 这两个模型都没声明档位，故那一次不带档位的请求本身就是被验对象：它不计 efforts
            // （没有档位可言），可用性由 models 体现
            calls.length === 2 && summary.probed === 2 && summary.efforts === 0 && summary.models === 1
            && summary.providers[0].reachable && summary.providers[0].keyValid && !summary.providers[0].skipped,
            { calls, summary },
        )
    }
    {
        // 模型级短路：档位请求上报额度耗尽时换任何档都是同样结果，不必再花额度
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({ 'm1@off': [finishError('QUOTA', 429)] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high', 'max'])] }, {
            onProgress: (frame) => { frames.push(frame) },
        })
        check(
            'verifyModels 档位请求撞额度耗尽即短该模型尾并记 skipped',
            calls.length === 2 && summary.probed === 1 && summary.planned === 3
            && stable(frames[1]) === stable({
                type: 'probed', provider: 'a', model: 'm1', effort: 'off', outcome: 'quota', skipped: 2, done: 3, total: 3,
            }),
            { calls, summary, frames },
        )
    }
    {
        // 反面：上游 5xx 断不得「后续必然失败」（多半是服务端的一次性故障，换个档位可能就通），
        // 故档位请求上只记这一条、不短后面的档位
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({ 'm1@off': [finishError('SERVER_ERROR', 500)] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high', 'max'])] }, {
            onProgress: (frame) => { frames.push(frame) },
        })
        check(
            'verifyModels 上游 5xx 不参与模型级短路：后续档位照验',
            calls.length === 4 && summary.probed === 3 && summary.planned === 3 && summary.efforts === 2
            && frames[1].type === 'probed' && frames[1].outcome === 'other' && frames[1].skipped === undefined,
            { calls, summary, frames },
        )
    }
    {
        // 探测对照：探测（不带档位）已通过 + 4xx + 原文回显带引号的该档位 ⇒ 判该档位不支持，
        // 且**不**短该模型后续档位——换个档位可能就通了，那正是逐档位验的意义
        const { llm, calls } = stub({
            'm1@max': [finishErrorText('INVALID_REQUEST', 400, "Invalid value for 'reasoning_effort': 'max'.")],
        })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high', 'max'])] })
        check(
            'verifyModels 探测通过且宿主判参数不正确 → 判该档位不支持且不短后续',
            calls.length === 4 && summary.planned === 3 && summary.unsupported === 1 && summary.efforts === 2
            && stable(summary.unsupportedEfforts) === stable([{ provider: 'a', model: 'm1', effort: 'max' }]),
            { calls, summary },
        )
    }
    {
        // 5xx 即便原文提到该档位也不判不支持：它是服务端问题，不是这一档被拒
        const { llm, calls } = stub({
            'm1@off': [finishErrorText('SERVER_ERROR', 500, "'off' is not available right now")],
        })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high'])] })
        check(
            'verifyModels 5xx 即使回显了档位也不判不支持，且不短后面的档位',
            calls.length === 3 && summary.unsupported === 0 && summary.probed === 2,
            { calls, summary },
        )
    }
    {
        // 报错原文完全不提该档位（实测确有上游只列可用档位）也照判：判据是宿主归一后的 code，不是文案。
        // 反过来，改用文案匹配会被网关「4xx 里回显请求体」骗到——那段里的档位只是原样回声，不是「这一档被拒」
        const { llm, calls } = stub({
            'm1@max': [finishErrorText('INVALID_REQUEST', 400, "Supported values are: 'low', 'high'")],
        })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high', 'max'])] })
        check(
            'verifyModels 报错原文未提该档位也照判不支持（判据是 code 不是文案）',
            calls.length === 4 && summary.unsupported === 1 && summary.efforts === 2
            && stable(summary.unsupportedEfforts) === stable([{ provider: 'a', model: 'm1', effort: 'max' }]),
            { calls, summary },
        )
    }
    {
        // 探测都不通，档位一律不判不支持：无从归因到档位，直接短该模型
        const { llm, calls } = stub({ 'm1': [finishError('INVALID_REQUEST', 400)] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high'])] })
        check(
            'verifyModels 探测不通则不判档位不支持、直接短该模型（明细里不留探测）',
            calls.length === 1 && summary.probed === 0 && summary.unsupported === 0 && summary.planned === 2 && summary.tested === 1,
            { calls, summary },
        )
    }
    {
        // 模型级短路只压该模型自己的档位，同组其余模型照验（provider 级才是压整组）
        const { llm, calls } = stub({ 'm1@off': [finishError('QUOTA', 429)] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high']), entry('a', 'm2', ['low'])] })
        check(
            'verifyModels 模型级短路不牵连同组其它模型',
            calls.length === 4 && summary.probed === 2 && summary.planned === 3,
            { calls, summary },
        )
    }
    {
        // 零内容完成是「请求成功抵达、但一个内容块都没有」，既非 provider 级失败也不该短路：
        // 若漏判就会把一次成功响应误报成端点断线，后面的模型全部不再验证
        const { llm, calls } = stub({ 'm1': [finishError('EMPTY_RESPONSE')] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', []), entry('a', 'm2', [])] })
        check(
            'verifyModels 零内容完成不短路',
            calls.length === 2 && summary.probed === 2 && summary.efforts === 0 && summary.models === 1
            && summary.providers[0].reachable && !summary.providers[0].skipped,
            { calls, summary },
        )
    }
    {
        // 两个提供方互不牵连：一个不可达，另一个照常验证
        const { llm, calls } = stub({ 'm1': [finishError('TRANSPORT')] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', []), entry('b', 'n1', [])] })
        check(
            'verifyModels 短路只影响本组',
            summary.providers.length === 2 && summary.providers[0].skipped === true
            && summary.providers[1].skipped === false && summary.providers[1].models === 1,
            { calls, summary },
        )
    }
    {
        let threw = false
        try {
            await verifyModels(stub({}).llm, { models: [entry('a', 'm', ['turbo'])] })
        } catch {
            threw = true
        }
        check('verifyModels 入参非法抛错（由 RPC 层转失败结果）', threw)
    }
    {
        // 正常帧序列：opened 起 → 每条被验请求 probed → 收于唯一一条 done；探测一条帧都不发
        const frames: VerifyProgressFrame[] = []
        const { llm } = stub({})
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high']), entry('a', 'm2', ['low'])] }, {
            onProgress: (frame) => { frames.push(frame) },
        })
        const last = frames[frames.length - 1]
        check(
            'verifyModels 进度帧：opened 起、逐条 probed、done 收尾（探测不占帧）',
            stable(frames.slice(0, 4)) === stable([
                { type: 'opened', total: 3 },
                { type: 'probed', provider: 'a', model: 'm1', effort: 'off', outcome: 'usable', done: 1, total: 3 },
                { type: 'probed', provider: 'a', model: 'm1', effort: 'high', outcome: 'usable', done: 2, total: 3 },
                { type: 'probed', provider: 'a', model: 'm2', effort: 'low', outcome: 'usable', done: 3, total: 3 },
            ]) && frames.length === 5 && last.type === 'done' && last.summary === summary,
            frames,
        )
    }
    {
        // 基线（不带档位的对照请求）不是被验对象，进度上也不占位：限流时它那条模型级记录是**附注帧**，
        // 只交代「基线为什么没过」，done 不动，故后面逐档位的帧照常从 1 数起
        const frames: VerifyProgressFrame[] = []
        const { llm } = stub({ 'm1': [finishError('RATE_LIMIT', 429)] })
        await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high'])] }, {
            onProgress: (frame) => { frames.push(frame) },
        })
        check(
            'verifyModels 基线瞬态失败的那帧不占进度位（done 不越界）',
            stable(frames.slice(0, 4)) === stable([
                { type: 'opened', total: 2 },
                { type: 'probed', provider: 'a', model: 'm1', effort: undefined, outcome: 'rate-limit', done: 0, total: 2 },
                { type: 'probed', provider: 'a', model: 'm1', effort: 'off', outcome: 'usable', done: 1, total: 2 },
                { type: 'probed', provider: 'a', model: 'm1', effort: 'high', outcome: 'usable', done: 2, total: 2 },
            ]),
            frames,
        )
    }
    {
        // 进度契约的不变式：任何分支下每帧 done ≤ total，且整轮跑完落在 total 上（基线不占位、跳过条目计入）
        const frames: VerifyProgressFrame[] = []
        const { llm } = stub({ 'm1': [finishError('RATE_LIMIT', 429)], 'm2': [finishError('TRANSPORT')] })
        await verifyModels(llm, {
            models: [entry('a', 'm1', ['off', 'high']), entry('a', 'm2', ['low', 'max'])],
        }, { onProgress: (frame) => { frames.push(frame) } })
        const probed = frames.filter((frame): frame is VerifyProbedFrame => frame.type === 'probed')
        check(
            'verifyModels 全程 done ≤ total 且整轮跑完落在 total 上',
            probed.every((frame) => frame.done <= frame.total)
            && probed[probed.length - 1].done === probed[probed.length - 1].total,
            probed,
        )
    }
    {
        // 探测撞上端点不通：整组立刻停。探测本身不是被验对象（不进明细、不计统计），
        // 但它不通就意味着这个模型一条都没验成——不发记录的话它在记录区彻底消失，
        // 用户只看到别的模型的结果，无从知道它为什么没出现。故发一条不带档位的模型级记录
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({ 'm1': [finishError('TRANSPORT')] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high', 'max'])] }, {
            onProgress: (frame) => { frames.push(frame) },
        })
        check(
            'verifyModels 探测撞端点不通即短整组，并留一条模型级记录（档位缺省、未发出的三条计入 skipped）',
            calls.length === 1 && summary.probed === 0 && summary.planned === 3 && summary.tested === 1
            && summary.providers[0].blockedBy === 'unreachable' && !summary.providers[0].reachable
            && stable(frames[1]) === stable({
                type: 'probed', provider: 'a', model: 'm1', effort: undefined, outcome: 'unreachable', skipped: 3, done: 3, total: 3,
            }) && frames[2].type === 'done',
            { calls, summary, frames },
        )
    }
    {
        // 本组首个请求就超时（这里正是那条基线探测）：成因在请求之外——url 不可达、端点服务中断、
        // 本地网络不通，后面每个模型、每档位再等一次只是把同样的 30 秒乘上几十遍，故短整组
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({ 'm1': [finishError('TIMEOUT')] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high', 'max'])] }, {
            onProgress: (frame) => { frames.push(frame) },
        })
        check(
            'verifyModels 首个请求超时短整组（基线也算本组的请求），blockedBy 记 timeout',
            calls.length === 1 && summary.probed === 0 && summary.planned === 3 && summary.tested === 1
            // 理由记「超时」而非「不可达」，reachable 也不翻假：超时只是没等到受理，不是传输层失败的证据
            && summary.providers[0].blockedBy === 'timeout' && summary.providers[0].reachable
            && stable(frames[1]) === stable({
                type: 'probed', provider: 'a', model: 'm1', effort: undefined, outcome: 'timeout', skipped: 3, done: 3, total: 3,
            }) && frames[2].type === 'done',
            { calls, summary, frames },
        )
    }
    {
        // 首个之后的超时：链路已经跑通过，只是这一次慢——照旧瞬态处理，既不短整组也不短该模型的档位尾
        const { llm, calls } = stub({ 'm1@high': [finishError('TIMEOUT')] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high']), entry('a', 'm2', ['low'])] })
        check(
            'verifyModels 首个之后的超时不当不可达：后面的档位与模型照验',
            calls.length === 5 && summary.probed === 3 && summary.planned === 3
            && summary.providers[0].blockedBy === undefined && summary.providers[0].reachable
            && summary.models === 2 && summary.efforts === 2,
            { calls, summary },
        )
    }
    {
        // 探测不通（非 provider 级）短该模型时同样要留记录，skipped 含这条探测自身——它也没发出去
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({ 'm1': [finishError('MODEL_NOT_FOUND', 404)] })
        await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high'])] }, {
            onProgress: (frame) => { frames.push(frame) },
        })
        check(
            'verifyModels 探测不通短该模型时发一条记录，skipped 含探测自身',
            calls.length === 1 && stable(frames[1]) === stable({
                type: 'probed', provider: 'a', model: 'm1', effort: undefined, outcome: 'other', skipped: 2, done: 2, total: 2,
            }),
            frames,
        )
    }
    {
        // provider 级短路那条自带 skipped：消费方才好交代「这组还剩几条没验」
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({ 'm1@off': [finishError('INVALID_CREDENTIAL', 401)] })
        await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high', 'max'])] }, {
            onProgress: (frame) => { frames.push(frame) },
        })
        check(
            'verifyModels provider 级短路那条 probed 带 skipped',
            calls.length === 2 && stable(frames[1]) === stable({
                type: 'probed', provider: 'a', model: 'm1', effort: 'off', outcome: 'credential', skipped: 2, done: 3, total: 3,
            }),
            frames,
        )
    }
    {
        // 中止：桩不理会信号本身，这里要验的是「本组不再发新探测」与「不发 done」
        const controller = new AbortController()
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({}, (index) => { if (index === 2) controller.abort() })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high']), entry('a', 'm2', ['low'])] }, {
            signal: controller.signal,
            onProgress: (frame) => { frames.push(frame) },
        })
        check(
            'verifyModels 中止后早停且不发 done',
            calls.length === 2 && frames.every((frame) => frame.type !== 'done')
            && summary.probed === 1 && summary.planned === 3,
            { calls, frames, summary },
        )
    }
    {
        // 中止撞在在途请求上：宿主给 `aborted` 终帧。它没有结论——不记「不可用」，也不短该模型档位尾
        const controller = new AbortController()
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({ m1: [FINISH_ABORTED] }, () => controller.abort())
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high'])] }, {
            signal: controller.signal,
            onProgress: (frame) => { frames.push(frame) },
        })
        check(
            'verifyModels 基线中止不入账不发帧（不再记成不可用、不再甩锅短路）',
            calls.length === 1 && summary.results.length === 0
            && frames.filter((frame) => frame.type === 'probed').length === 0
            && frames.every((frame) => frame.type !== 'done'),
            { calls, frames, summary },
        )
    }
    {
        // 上游自己报 ABORTED 而我们并未中止：同样没有结论，但不能因此停下，后面档位照验
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({ 'm1@off': [FINISH_ABORTED] })
        const summary = await verifyModels(llm, { models: [entry('a', 'm1', ['off', 'high'])] }, {
            onProgress: (frame) => { frames.push(frame) },
        })
        check(
            'verifyModels 上游中止不记账但继续验后续档位',
            calls.length === 3 && summary.probed === 1 && summary.planned === 2 && summary.efforts === 1
            && stable(summary.results) === stable([
                { provider: 'a', model: 'm1', effort: 'high', outcome: 'usable', failure: undefined },
            ]),
            { calls, frames, summary },
        )
    }
    {
        // 六个提供方、五个 worker：第 3 次调用时中止，此时前 3 组已开跑、后 3 组从未开始。
        // 它们不该出现在汇报里——报成「可达且凭据有效」或「全不可用」都是撒谎，它压根没被验证过。
        const controller = new AbortController()
        const { llm } = stub({}, (index) => { if (index === 3) controller.abort() })
        const summary = await verifyModels(
            llm,
            { models: ['a', 'b', 'c', 'd', 'e', 'f'].map((provider) => entry(provider, 'm', [])) },
            { signal: controller.signal },
        )
        check(
            'verifyModels 从未开跑的提供方不进汇报',
            stable(summary.providers.map((report) => report.provider)) === stable(['a', 'b', 'c'])
            // 这些模型都没声明档位，那一次不带档位的请求本身就是被验对象，故每组各计 1；
            // 但它们验的是模型不是级别，故计划推理级别数为 0（开档位模式的分母会是 0，此时改用 verifyDoneModels 那行）
            && summary.planned === 3 && summary.probed === 3 && summary.tested === 3 && summary.plannedEfforts === 0,
            summary.providers.map((report) => report.provider),
        )
    }

    // ---------- 进度帧编解码：线上格式与形状校验 ----------
    const opened = encodeProgressFrame({ type: 'opened', total: 3 })
    check('encodeProgressFrame 输出 data 行加空行分隔', opened === 'data: {"type":"opened","total":3}\n\n', opened)
    check('decodeProgressFrame 往返一致', stable(decodeProgressFrame(opened)) === stable({ type: 'opened', total: 3 }))
    // SSE 心跳是注释行；我们不用 EventSource（它会自动重连，等于重跑整轮），但仍按格式容忍
    check('decodeProgressFrame 忽略注释帧', decodeProgressFrame(': connected') === undefined)
    check('decodeProgressFrame 忽略非法 JSON', decodeProgressFrame('data: {oops') === undefined)
    check('decodeProgressFrame 忽略非帧对象', decodeProgressFrame('data: {"type":"nope"}') === undefined)
    // done 帧直接驱动卡片上的统计数字，计数缺失就该判非法，而不是把 undefined 当 0 展示
    check('decodeProgressFrame 拒计数缺失的 done', decodeProgressFrame('data: {"type":"done","summary":{}}') === undefined)
    check(
        'decodeProgressFrame 接受收尾那行要用的四个计数齐全的 done',
        decodeProgressFrame('data: {"type":"done","summary":{"tested":2,"models":1,"efforts":3,"plannedEfforts":4}}') !== undefined,
    )
    check('decodeProgressFrame 拒字段缺失的 probed', decodeProgressFrame('data: {"type":"probed","provider":"a"}') === undefined)
    check(
        'decodeProgressFrame 接受无 effort 的 probed（模型未声明档位，键缺省是合法形态）',
        stable(decodeProgressFrame('data: {"type":"probed","provider":"a","model":"m","outcome":"usable","done":1,"total":1}'))
        === stable({ type: 'probed', provider: 'a', model: 'm', outcome: 'usable', done: 1, total: 1 }),
    )
    // failed 终帧承载「整轮没能开跑」的真实原因，文案缺失即无信息可展示，故判非法
    check(
        'decodeProgressFrame 接受 failed 并原样带出文案',
        stable(decodeProgressFrame('data: {"type":"failed","message":"超出上限"}')) === stable({ type: 'failed', message: '超出上限' }),
    )
    check('decodeProgressFrame 拒无文案的 failed', decodeProgressFrame('data: {"type":"failed"}') === undefined
        && decodeProgressFrame('data: {"type":"failed","message":1}') === undefined)
}