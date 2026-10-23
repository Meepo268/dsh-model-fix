/**
 * 「探测档位」的 Node 半执行器：把候选档位**临时预声明**进模型配置 → 逐档各发一次最小请求 →
 * 按结论**收敛**成最终档位表并写回。全过程只由用户主动发起，在途全程持有事件流守卫。
 * 设计裁决见 docs/decisions-diagnose.md「探测」。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { EFFORT_LEVELS, PLUGIN_NAME } from '@/shared/constants'
import { errorText } from '@/shared/errors'
import { isPlainObject } from '@/shared/types'
import type { ProviderBlockReason, ProviderProbeOutcome, VerifyProbeResult, VerifySummary } from '@/shared/verify-progress'
import type { GroupRunner, ProbeEmitter, ProbeRunOptions } from '@/probe-engine'
import { finishRun, probeOnce, runProbeGroups } from '@/probe-engine'
import type { ProviderProbeGroup } from '@/probe-plan'
import { PROBE_LIMITS, planProbeGroups } from '@/probe-plan'
import { isEffortRejection, providerBlockReason, sameModelTail, shouldSkipModelTail } from '@/probe-verdict'
import type { EffortApply } from '@/fill'
import { convergeProbeEfforts, declareProbeEfforts } from '@/fill'
import { clearProbeBackup, saveProbeBackup } from '@/probe-backup'
import { endIgnoreAll, startIgnoreAll } from '@/guard'

/** 探测请求不合法时的报错文案（入参来自浏览器半，一律按不可信输入校验） */
const PROBE_REJECT_MESSAGE = `${PLUGIN_NAME}: 探测请求不合法（模型条目或推理级别取值越界）`

/** 「提供方 / 模型」二元组键（与 fill.ts、verifyKey 同口径） */
function targetKey(provider: string, model: string): string {
    return JSON.stringify([provider, model])
}

/** 顺序跑完一组的探测请求（组内零并发）：provider 级失败（含首个请求超时）短整组，额度耗尽 / 限流短到该模型的档位尾 */
const runProbeGroup: GroupRunner = async (
    llm: Pick<LlmRuntime, 'stream'>,
    group: ProviderProbeGroup,
    signal: AbortSignal,
    emitProbe: ProbeEmitter,
): Promise<ProviderProbeOutcome> => {
    const results: VerifyProbeResult[] = []
    // 已跑通至少一档的模型：判「档位不被支持」的第二条件对照
    const usable = new Set<string>()
    let blockedBy: ProviderBlockReason | undefined
    // 本组已发出的请求数：provider 级短路要区分「首个请求就超时」与「链路已跑通、只是这一次慢」
    let sent = 0
    for (let index = 0; index < group.probes.length; index++) {
        // 外部中止在此早停：后续请求带着已中止的信号只会跑出假失败
        if (signal.aborted) break
        const probe = group.probes[index]
        const verdict = await probeOnce(llm, probe, signal)
        sent += 1
        // 中止没有结论：不入明细也不发帧，不能进补全与剔除的输入
        if (verdict.outcome === 'aborted') continue
        if (verdict.outcome === 'usable') usable.add(probe.model)
        // 判「档位不被支持」：宿主判「参数不正确」且该模型已有更低档跑通（无基线，拿已跑通档顶替，见 docs/decisions-diagnose.md「探测」）
        const outcome = probe.effort !== undefined && usable.has(probe.model) && isEffortRejection(verdict.failure)
            ? 'unsupported-effort'
            : verdict.outcome
        results.push({
            provider: probe.provider,
            model: probe.model,
            effort: probe.effort,
            outcome,
            failure: verdict.failure,
        })
        // 算出两级短路的「剩余未发出条数」：provider 级断到组尾，模型级断到该模型的档位尾；被跳过的请求不进 results
        let skipped = 0
        const blockReason = providerBlockReason(outcome, sent === 1)
        if (blockReason !== undefined) {
            blockedBy = blockReason
            skipped = group.probes.length - index - 1
        } else if (shouldSkipModelTail(outcome, verdict.failure) || outcome === 'rate-limit') {
            // 限流是本功能自有的追加判据（超时不算），见 docs/decisions-diagnose.md「探测」
            skipped = sameModelTail(group.probes, index)
        }
        if (skipped > 0) index += skipped
        emitProbe(probe, { outcome, failure: verdict.failure }, {
            settled: 1 + skipped,
            ...(skipped === 0 ? {} : { skipped }),
        })
        if (blockedBy !== undefined) break
    }
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

/** 两个开关的取值：「自动写入」缺省开、「剔除不支持」缺省关；显式给了非布尔值按非法入参拒绝 */
function flagsOf(payload: unknown): { dropUnsupported: boolean; autoWrite: boolean } {
    if (!isPlainObject(payload)) throw new Error(PROBE_REJECT_MESSAGE)
    const read = (key: string, absent: boolean): boolean => {
        const value = payload[key]
        if (value === undefined) return absent
        if (typeof value !== 'boolean') throw new Error(PROBE_REJECT_MESSAGE)
        return value
    }
    return { dropUnsupported: read('dropUnsupported', false), autoWrite: read('autoWrite', true) }
}

/**
 * 收敛结论：逐模型算出最终档位表（只算不写）。
 * 生效闸：本轮被中止即**整轮**还原预声明之前的档位表；某模型请求没拿满（被短路连带）则只还原它。
 */
function convergeEntries(
    groups: readonly ProviderProbeGroup[],
    targets: readonly EffortApply[],
    preexisting: ReadonlyMap<string, readonly string[]>,
    summary: VerifySummary,
    dropUnsupported: boolean,
    aborted: boolean,
): EffortApply[] {
    const usable = new Map<string, Set<string>>()
    const unsupported = new Map<string, Set<string>>()
    const probed = new Map<string, number>()
    const planned = new Map<string, number>()
    for (const item of summary.usableEfforts) collect(usable, targetKey(item.provider, item.model), item.effort)
    for (const item of summary.unsupportedEfforts) collect(unsupported, targetKey(item.provider, item.model), item.effort)
    for (const item of summary.results) count(probed, targetKey(item.provider, item.model))
    for (const group of groups) for (const probe of group.probes) count(planned, targetKey(probe.provider, probe.model))
    const entries: EffortApply[] = []
    for (const target of targets) {
        const key = targetKey(target.provider, target.model)
        // 预声明时不在配置里的模型（探测期间被删掉）不被写回
        const before = preexisting.get(key)
        if (before === undefined) continue
        const keep = !aborted && (probed.get(key) ?? 0) >= (planned.get(key) ?? 0)
        entries.push({ provider: target.provider, model: target.model, levels: keep ? finalLevels(key, before, usable, unsupported, dropUnsupported) : before })
    }
    return entries
}

/**
 * 收敛结论若写入相对预声明之前的增删统计（「自动写入」关闭时供浏览器半汇报「可补全」）。
 * 口径与写回统计一致：档位表有变即计一个模型，逐级计增删。
 */
function plannedFillOf(
    entries: readonly EffortApply[],
    baseline: ReadonlyMap<string, readonly string[]>,
): NonNullable<VerifySummary['fill']> {
    let models = 0
    let added = 0
    let removed = 0
    for (const entry of entries) {
        const before = baseline.get(targetKey(entry.provider, entry.model))
        if (before === undefined) continue
        const after = new Set(entry.levels)
        let changed = false
        for (const level of after) if (!before.includes(level)) { added += 1; changed = true }
        for (const level of before) if (!after.has(level)) { removed += 1; changed = true }
        if (changed) models += 1
    }
    return { models, added, removed }
}

/** 收敛后的档位表：`可用 ∪ 原有`，开「剔除不支持」时再从原有里扣掉明确判不支持的那些；按 `EFFORT_LEVELS` 排序 */
function finalLevels(
    key: string,
    before: readonly string[],
    usable: ReadonlyMap<string, Set<string>>,
    unsupported: ReadonlyMap<string, Set<string>>,
    dropUnsupported: boolean,
): readonly string[] {
    const kept = new Set<string>()
    for (const level of before) {
        if (dropUnsupported && unsupported.get(key)?.has(level)) continue
        kept.add(level)
    }
    for (const level of usable.get(key) ?? []) kept.add(level)
    return EFFORT_LEVELS.filter((level) => kept.has(level))
}

function collect(target: Map<string, Set<string>>, key: string, value: string): void {
    const set = target.get(key)
    if (set === undefined) target.set(key, new Set([value]))
    else set.add(value)
}

function count(target: Map<string, number>, key: string): void {
    target.set(key, (target.get(key) ?? 0) + 1)
}

/**
 * 跑一轮探测档位：预声明 → 逐档探测 → 收敛写回 → 发终帧。
 * 两个开关随载荷走（与模型清单同为浏览器半的声明，入参校验一处收口）。
 * 事件流守卫**全程持有**（预声明到收敛不放开），否则中途改配置会触发 `fix` 还原预声明、后续请求被宿主拒。见 docs/decisions-diagnose.md「探测」。
 */
export async function probeAndFill(
    ctx: Context,
    llm: Pick<LlmRuntime, 'stream'>,
    payload: unknown,
    options: ProbeRunOptions = {},
): Promise<VerifySummary> {
    const flags = flagsOf(payload)
    const groups = planProbeGroups(payload, PROBE_LIMITS, PROBE_REJECT_MESSAGE)
    const targets: EffortApply[] = []
    const seen = new Set<string>()
    for (const group of groups) {
        for (const probe of group.probes) {
            const key = targetKey(probe.provider, probe.model)
            if (seen.has(key)) continue
            seen.add(key)
            targets.push({ provider: probe.provider, model: probe.model, levels: [] })
        }
    }
    startIgnoreAll()
    try {
        // 先存兜底备份再动配置：存不下即整轮中止（没有退路不动用户配置，见 probe-backup.ts）
        await saveProbeBackup(ctx, targets)
        const preexisting = await declareProbeEfforts(ctx, targets)
        const summary = await runProbeGroups(llm, groups, runProbeGroup, options)
        const entries = convergeEntries(groups, targets, preexisting, summary, flags.dropUnsupported, options.signal?.aborted === true)
        let fill: NonNullable<VerifySummary['fill']>
        if (flags.autoWrite) {
            const { models, added, removed } = await convergeProbeEfforts(ctx, entries, preexisting)
            fill = { models, added, removed }
        } else {
            // 「自动写入」关闭：只算不写，写回端整轮还原，统计交给 plannedFillOf
            fill = plannedFillOf(entries, preexisting)
            const restore: EffortApply[] = []
            for (const target of targets) {
                const before = preexisting.get(targetKey(target.provider, target.model))
                if (before !== undefined) restore.push({ provider: target.provider, model: target.model, levels: before })
            }
            await convergeProbeEfforts(ctx, restore, preexisting)
        }
        // 收敛已落盘即撤掉兜底备份；撤不掉只告警，不报成失败（见 docs/decisions-diagnose.md「探测」）
        await clearProbeBackup(ctx).catch((error: unknown) => {
            ctx.logger.warn(`${PLUGIN_NAME}: 探测兜底备份清理失败（下次启动会回退本轮补全）：${errorText(error)}`)
        })
        // 终帧最后发：消费方拿到 done 时写回已落盘。`fill` 两义见 `ProbeFillResult`
        const filled: VerifySummary = { ...summary, fill }
        finishRun(filled, options)
        return filled
    } finally {
        endIgnoreAll()
    }
}
