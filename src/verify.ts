/** 模型可用性验证：每勾选模型发一次不带 `reasoningEffort` 的最小请求，仅以适配器是否开始产出内容块（`block-start`）判可用；
 * 全程只读（不碰 settings、不占事件流守卫、不落「已验证」账本），口径见 docs/decisions.md「验证」 */

import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { PLUGIN_NAME } from '@/shared/constants'
import type { ProviderBlockReason, ProviderProbeOutcome, VerifyProbeResult, VerifySummary } from '@/shared/verify-progress'
import type { GroupRunner, ProbeEmitter, ProbeRunOptions } from '@/probe-engine'
import { finishRun, probeOnce, runProbeGroups } from '@/probe-engine'
import type { ProviderProbeGroup } from '@/probe-plan'
import { VERIFY_LIMITS, planProbeGroups } from '@/probe-plan'
import { providerBlockReason } from '@/probe-verdict'

/** 验证请求不合法时的报错文案（入参来自浏览器半，一律按不可信输入校验） */
const VERIFY_REJECT_MESSAGE = `${PLUGIN_NAME}: 验证请求不合法（模型条目取值越界）`

/** 顺序跑完一组验证请求（组内零并发）：每模型一条请求（不带档位参数）；provider 级失败（端点不通 / 凭据无效 / 首请求超时）短整组；外部中止早停（只断在途请求） */
const runGroup: GroupRunner = async (
    llm: Pick<LlmRuntime, 'stream'>,
    group: ProviderProbeGroup,
    signal: AbortSignal,
    emitProbe: ProbeEmitter,
): Promise<ProviderProbeOutcome> => {
    const results: VerifyProbeResult[] = []
    let blockedBy: ProviderBlockReason | undefined
    // 本组已发出的请求数：provider 级短路要区分「首个请求就超时」与「链路已跑通、只是这一次慢」
    let sent = 0
    for (let index = 0; index < group.probes.length; index++) {
        if (signal.aborted) break
        const probe = group.probes[index]
        const verdict = await probeOnce(llm, probe, signal)
        sent += 1
        // 中止没有结论：不入明细也不发帧，不能算成「模型不可用」
        if (verdict.outcome === 'aborted') continue
        results.push({
            provider: probe.provider,
            model: probe.model,
            effort: probe.effort,
            outcome: verdict.outcome,
            failure: verdict.failure,
        })
        // provider 级短路的剩余未发出条数在此算出断到组尾；被跳过的请求不进 results，故 probed 少于 planned
        let skipped = 0
        const blockReason = providerBlockReason(verdict.outcome, sent === 1)
        if (blockReason !== undefined) {
            blockedBy = blockReason
            skipped = group.probes.length - index - 1
        }
        if (skipped > 0) index += skipped
        emitProbe(probe, verdict, {
            settled: 1 + skipped,
            ...(skipped === 0 ? {} : { skipped }),
        })
        if (blockedBy !== undefined) break
    }
    // 计划数 = 该组的验证请求数 = 勾选的模型数
    const models = new Set<string>()
    let plannedEfforts = 0
    for (const probe of group.probes) {
        models.add(JSON.stringify([probe.provider, probe.model]))
        if (probe.effort !== undefined) plannedEfforts++
    }
    return {
        provider: group.provider,
        results,
        blockedBy,
        planned: group.probes.length,
        plannedEfforts,
        tested: models.size,
    }
}

/** 验证的可选控制项；不传即静默跑完 */
type VerifyOptions = ProbeRunOptions

/** 执行一次验证：按勾选展开清单 → 按提供方分组 → 逐组跑 → 逐组汇报并求和；入参非法即抛出（调用方转 RPC 失败结果） */
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
