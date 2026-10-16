/**
 * 模型可用性验证：对每个勾选模型声明的每个推理级别各发一次最小请求，仅以适配器是否真正开始产出内容块（`block-start`）判定可用。
 *
 * 设计裁决（受理判据、并发模型、中止与进度、判定口径与短路规则）见 docs/decisions.md「验证」。
 * 本文件独有的口径：全程只读——不碰 settings、不占事件流守卫，也不落任何「已验证」账本。
 */

import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { PLUGIN_NAME } from '@/shared/constants'
import type { ProviderBlockReason, ProviderProbeOutcome, VerifyProbeResult, VerifySummary } from '@/shared/verify-progress'
import type { GroupRunner, ProbeEmitter, ProbeRunOptions } from '@/probe-engine'
import { finishRun, probeOnce, runProbeGroups } from '@/probe-engine'
import type { ProviderProbeGroup } from '@/probe-plan'
import { VERIFY_LIMITS, planProbeGroups } from '@/probe-plan'
import { isEffortRejection, providerBlockReason, sameModelTail, shouldSkipModelTail, shouldSkipModelTailAfterBaseline } from '@/probe-verdict'

/** 验证请求不合法时的报错文案（入参来自浏览器半，一律按不可信输入校验） */
const VERIFY_REJECT_MESSAGE = `${PLUGIN_NAME}: 验证请求不合法（模型条目或推理级别取值越界）`

/**
 * 顺序跑完一组的验证请求（组内零并发）。
 *
 * 每模型**至多一次基线探测**：带档位的模型在验它第一条之前，先发一次不带档位的请求作对照——
 * 判「某档位不被支持」只能靠它（理由见 `isEffortRejection`）。基线不是被验对象：它不进明细、
 * 不计任何统计、跑通时也不留记录（用户看到的每一条都该是被验的那一次）。
 * 唯一的例外是**基线失败并据此短路**：那一条档位请求根本没发出去，用户无从得知，只能靠这条记录交代。
 *   瞬态失败（限流 / 超时）不留这种短路——它们只否定了这一次，随后照常逐档位验（见下）。
 * 两种模型没有基线：关掉档位开关时全部请求本就不带参数，以及模型没有声明任何档位时——
 * 那一次不带档位的请求本身就是被验对象（`needTest` 为假），故基线与它无从分开。
 *
 * 两级短路，判据只有一条：**能断定后续请求必然失败**（判据本体在 `@/probe-engine`，与「探测式填充」共用）：
 * - **provider 级**（`providerBlockReason`）：同一提供方共用同一 url 与同一把 key，这次过不了后面同样过不了。
 *   端点不通 / 凭据无效，外加**本组首个请求超时**——url 不可达、端点服务中断或本地网络不通，成因都落在
 *   请求之外，后续只会是同样无意义的超时。基线探测也算「本组的请求」，故首个请求常常正是它。
 * - **模型级**：档位请求上只有**额度耗尽**够格（`shouldSkipModelTail`）——同一把 key 的额度用完，
 *   换多少档都是同样结果。**基线请求**不带档位，失败天生与档位无关，故多认「被厂商确定性拒绝」一种
 *   （`shouldSkipModelTailAfterBaseline`）：模型不存在、参数被拒、无权限，换档位发出去的还是同一个请求。
 *   限流与超时两者都不算（`isTransientOutcome`）：它们只否定了这一次，否不了下一次——冷启动与限流窗口
 *   都可能让下一次反而跑通。实测限流挡掉的那一档，隔一会儿就通了。
 * 外部中止同样在此早停：只断在途请求而不停循环，后续请求会带着已中止的信号跑出一串假失败。
 */
const runGroup: GroupRunner = async (
    llm: Pick<LlmRuntime, 'stream'>,
    group: ProviderProbeGroup,
    signal: AbortSignal,
    emitProbe: ProbeEmitter,
): Promise<ProviderProbeOutcome> => {
    const results: VerifyProbeResult[] = []
    // 基线结论单列：它真发出去过，能证伪端点与凭据；但它不是被验对象，不混进明细与计数
    const tests: VerifyProbeResult[] = []
    let blockedBy: ProviderBlockReason | undefined
    // 本组已发出的请求数（含基线）：provider 级短路要区分「首个请求就超时」与「链路已跑通、只是这一次慢」
    let sent = 0
    // 本组内已发过基线的模型（每模型至多一次）与基线已通过的模型（它们的档位请求失败即判该档位不支持）
    const probed = new Set<string>()
    const baselineOk = new Set<string>()
    for (let index = 0; index < group.probes.length; index++) {
        if (signal.aborted) break
        const probe = group.probes[index]
        const tail = sameModelTail(group.probes, index)
        // 基线：组内该模型的第一条带 needTest 的请求即它的基线位。跑通只记事实、不发记录；
        // 失败则发一条模型级记录交代「这个模型为什么没验成」——能断定的据其短路，限流 / 超时则照常逐档位验
        if (probe.needTest && !probed.has(probe.model)) {
            probed.add(probe.model)
            const testVerdict = await probeOnce(llm, { provider: probe.provider, model: probe.model }, signal)
            sent += 1
            tests.push({
                provider: probe.provider,
                model: probe.model,
                effort: undefined,
                outcome: testVerdict.outcome,
                failure: testVerdict.failure,
            })
            const blockReason = testVerdict.outcome === 'usable' ? undefined : providerBlockReason(testVerdict.outcome, sent === 1)
            if (testVerdict.outcome === 'usable') {
                baselineOk.add(probe.model)
            } else if (blockReason !== undefined) {
                // 端点不通 / 凭据无效（以及本组首个请求就超时）：同一提供方共用同一 url 与同一把 key，整组都过不去
                blockedBy = blockReason
                // 未发出的条数含当前这条：它同样因基线不通而没发出去
                const remaining = group.probes.length - index
                emitProbe({ provider: probe.provider, model: probe.model }, testVerdict, { settled: remaining, skipped: remaining })
                break
            } else if (shouldSkipModelTailAfterBaseline(testVerdict.outcome)) {
                // 基线请求**不带推理级别**，故它的失败与档位无关：同一模型换任何档位，发出去的还是同一个请求。
                // 额度用尽、或被厂商确定性拒绝（模型不存在、参数被拒、无权限）时，后续必然同样失败，短到该模型尾
                emitProbe({ provider: probe.provider, model: probe.model }, testVerdict, { settled: tail + 1, skipped: tail + 1 })
                index += tail
                continue
            } else if (testVerdict.outcome === 'aborted') {
                // 中止没有结论：不发记录、不短路。外部中止就此整组停下；上游中止照常往下验
                if (signal.aborted) break
            } else {
                // 限流与超时只否定了这一次：冷启动、限流窗口都可能让下一次反而跑通，断不得。
                // 留一条模型级记录（不带档位——没有哪一档被验过）交代基线为什么没过，随后照常逐档位验：
                // 用户要的正是「哪一档行」，宁可多烧几次额度也不能替他把答案省掉
                // 附注帧：基线不是被验对象，不占进度位
                emitProbe({ provider: probe.provider, model: probe.model }, testVerdict, { settled: 0 })
            }
        }
        const verdict = await probeOnce(llm, probe, signal)
        sent += 1
        // 中止没有结论：不入明细也不发帧，更不能算成「档位不支持」
        if (verdict.outcome === 'aborted') continue
        // 基线已通过、且该档位的失败指明了「就是它」时，才判该档位不支持。判据见 isEffortRejection
        const outcome = probe.effort !== undefined && baselineOk.has(probe.model) && isEffortRejection(verdict.failure)
            ? 'unsupported-effort'
            : verdict.outcome
        results.push({
            provider: probe.provider,
            model: probe.model,
            effort: probe.effort,
            outcome,
            failure: verdict.failure,
        })
        // 两级短路的「剩余未发出的条数」在此一并算出：provider 级断到组尾，模型级只断到该模型自己的档位尾。
        // 消费方据此交代「还剩几条没验」，被跳过的请求不进 results，故 probed 少于 planned
        let skipped: number
        const blockReason = providerBlockReason(outcome, sent === 1)
        if (blockReason !== undefined) {
            blockedBy = blockReason
            skipped = group.probes.length - index - 1
        } else if (shouldSkipModelTail(outcome, verdict.failure)) {
            skipped = tail
        } else {
            skipped = 0
        }
        if (skipped > 0) index += skipped
        emitProbe(probe, { outcome, failure: verdict.failure }, {
            settled: 1 + skipped,
            ...(skipped === 0 ? {} : { skipped }),
        })
        if (blockedBy !== undefined) break
    }
    // 计划数 = 该组的验证请求数（基线不在清单里）：关档位时等于勾选模型数，开档位时等于档位数之和
    const models = new Set<string>()
    // 推理级别数只数带档位的条目：没声明档位的模型验的是模型本身，不占级别，故不进「X / Y 个推理级别」的分母
    let plannedEfforts = 0
    for (const probe of group.probes) {
        models.add(JSON.stringify([probe.provider, probe.model]))
        if (probe.effort !== undefined) plannedEfforts++
    }
    return {
        provider: group.provider,
        results,
        tests,
        blockedBy,
        planned: group.probes.length,
        plannedEfforts,
        tested: models.size,
    }
}

/** 验证的可选控制项；不传即静默跑完，行为与引入进度帧之前完全一致 */
export type VerifyOptions = ProbeRunOptions

/**
 * 执行一次验证：按用户勾选展开成清单、按提供方分组、逐组跑、逐组汇报并求和。
 * 返回逐提供方结论（可达 / 凭据 / 可用数 / 是否短路）与全局计数；入参非法即抛出，由调用方转 RPC 失败结果。
 */
export async function verifyModels(
    llm: Pick<LlmRuntime, 'stream'>,
    payload: unknown,
    options: VerifyOptions = {},
): Promise<VerifySummary> {
    const groups = planProbeGroups(payload, VERIFY_LIMITS, VERIFY_REJECT_MESSAGE)
    const summary = await runProbeGroups(llm, groups, runGroup, options)
    finishRun(summary, options)
    return summary
}
