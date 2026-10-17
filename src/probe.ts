/**
 * 「探测式填充」的 Node 半执行器：把候选档位**临时预声明**进模型配置 → 逐档各发一次最小请求 →
 * 按结论**收敛**成最终档位表并写回。全过程只由用户主动发起，且在途全程持有事件流守卫。
 *
 * 设计裁决（预声明必要性、收敛口径、两级短路判据、中止整轮还原、配额、兜底备份）见 docs/decisions.md「探测式填充」。
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

/** 顺序跑完一组的探测请求（组内零并发）：逐档各发一次，provider 级失败（含首个请求超时）短整组、其余按共用判据（额度耗尽）加本功能自有的限流短到模型尾 */
const runProbeGroup: GroupRunner = async (
    llm: Pick<LlmRuntime, 'stream'>,
    group: ProviderProbeGroup,
    signal: AbortSignal,
    emitProbe: ProbeEmitter,
): Promise<ProviderProbeOutcome> => {
    const results: VerifyProbeResult[] = []
    // 已跑通至少一档的模型：判「某档不被支持」的第二条件用它替代验证那边的基线对照
    const usable = new Set<string>()
    let blockedBy: ProviderBlockReason | undefined
    // 本组已发出的请求数：provider 级短路要区分「首个请求就超时」与「链路已跑通、只是这一次慢」
    let sent = 0
    for (let index = 0; index < group.probes.length; index++) {
        // 外部中止在此早停：只断在途请求而不停循环，后续请求会带着已中止的信号跑出一串假失败
        if (signal.aborted) break
        const probe = group.probes[index]
        const verdict = await probeOnce(llm, probe, signal)
        sent += 1
        // 中止没有结论：不入明细也不发帧，不能进补全与剔除的输入
        if (verdict.outcome === 'aborted') continue
        if (verdict.outcome === 'usable') usable.add(probe.model)
        // 判「这一档不被支持」要两个条件：宿主判为「参数不正确」，且该模型已有更低档跑通
        // （本功能没有基线对照，故拿已跑通的更低档顶替，见 docs/decisions.md「探测式填充」）
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
        // 两级短路的「剩余未发出的条数」在此一并算出：provider 级断到组尾，模型级只断到该模型自己的档位尾。
        // 被跳过的请求不进 results，故该模型的 probed 少于 planned（口径见共享层 `VerifySummary`）
        let skipped = 0
        const blockReason = providerBlockReason(outcome, sent === 1)
        if (blockReason !== undefined) {
            blockedBy = blockReason
            skipped = group.probes.length - index - 1
        } else if (shouldSkipModelTail(outcome, verdict.failure) || outcome === 'rate-limit') {
            // 额度耗尽共用判据；限流是本功能自有的追加判据（超时不算，见 docs/decisions.md「探测式填充」）
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
        // 本功能没有基线探测，故无「非被验对象的那一次请求」
        tests: [],
        blockedBy,
        planned: group.probes.length,
        plannedEfforts,
        tested: models.size,
    }
}

/** 两个开关的取值：「自动写入」缺省为开（不带该键的旧前端行为不变），「剔除不支持」缺省为关；显式给了却不是布尔值按非法入参拒绝（Node 半不替浏览器半反推语义）。
 * 「忽略排除」照此校验却不取用：它只决定浏览器半点开弹层时冻结的候选清单含不含被排除的提供方，两次写回一律按那份清单走，不再读 excludes */
function flagsOf(payload: unknown): { dropUnsupported: boolean; autoWrite: boolean } {
    if (!isPlainObject(payload)) throw new Error(PROBE_REJECT_MESSAGE)
    const read = (key: string, absent: boolean): boolean => {
        const value = payload[key]
        if (value === undefined) return absent
        if (typeof value !== 'boolean') throw new Error(PROBE_REJECT_MESSAGE)
        return value
    }
    read('ignoreExcludes', false)
    return { dropUnsupported: read('dropUnsupported', false), autoWrite: read('autoWrite', true) }
}

/**
 * 收敛结论：逐模型算出最终档位表（只算不写，是否落盘由 probeAndFill 按「自动写入」决定）。
 *
 * 结论是否生效有两道闸，任一不过即原样还原预声明之前的档位表——半截结论不足以动用户配置：
 * 1. 本轮被中止（`aborted`）：**整轮**还原，不按模型逐个判。
 * 2. 该模型自己的请求没拿满（被 provider 级或模型级短路连带）：只还原它，其余模型照常收敛。
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
        // 预声明时不在配置里的模型（探测期间被用户删掉）不在原有档位表里，也不该被写回
        const before = preexisting.get(key)
        if (before === undefined) continue
        const keep = !aborted && (probed.get(key) ?? 0) >= (planned.get(key) ?? 0)
        entries.push({ provider: target.provider, model: target.model, levels: keep ? finalLevels(key, before, usable, unsupported, dropUnsupported) : before })
    }
    return entries
}

/**
 * 收敛结论若写入相对预声明之前的增删统计（「自动写入」关闭时结论只算不写，供浏览器半汇报「可补全」）。
 * 口径与 `planEffortApply` 的写回统计一致：档位表（集合）有变即计一个模型，逐级计增删。
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

/** 往「模型 → 集合」里加一项 */
function collect(target: Map<string, Set<string>>, key: string, value: string): void {
    const set = target.get(key)
    if (set === undefined) target.set(key, new Set([value]))
    else set.add(value)
}

/** 往「模型 → 条数」里加一 */
function count(target: Map<string, number>, key: string): void {
    target.set(key, (target.get(key) ?? 0) + 1)
}

/**
 * 跑一轮探测式填充：预声明 → 逐档探测 → 收敛写回 → 发终帧。
 *
 * 三个开关（`ignoreExcludes` / `dropUnsupported` / `autoWrite`）随载荷走而不走参数：它们与模型清单同为
 * 浏览器半的声明，走载荷才与「入参按不可信输入校验」同一处收口。
 *
 * 事件流守卫**全程持有**（预声明到收敛之间不放开）：放开的话，中途改一次配置就会触发 `fix` 把预声明
 * 改回去，探测剩余的请求会被宿主本地拒绝、结论全错。理由与代价见 docs/decisions.md「探测式填充」。
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
        // 先把探测目标的档位表原值落进自有段再动配置：崩了也不至于把预声明留在用户配置里（详见 probe-backup.ts）。
        // 存不下就整轮中止——没有退路就不动用户配置
        await saveProbeBackup(ctx, targets)
        const preexisting = await declareProbeEfforts(ctx, targets)
        const summary = await runProbeGroups(llm, groups, runProbeGroup, options)
        const entries = convergeEntries(groups, targets, preexisting, summary, flags.dropUnsupported, options.signal?.aborted === true)
        let fill: NonNullable<VerifySummary['fill']>
        if (flags.autoWrite) {
            const { models, added, removed } = await convergeProbeEfforts(ctx, entries, preexisting)
            fill = { models, added, removed }
        } else {
            // 「自动写入」关闭：结论只算不写——写回端走整轮还原（与中止同一形态），统计交给 plannedFillOf
            fill = plannedFillOf(entries, preexisting)
            const restore: EffortApply[] = []
            for (const target of targets) {
                const before = preexisting.get(targetKey(target.provider, target.model))
                if (before !== undefined) restore.push({ provider: target.provider, model: target.model, levels: before })
            }
            await convergeProbeEfforts(ctx, restore, preexisting)
        }
        // 收敛已落盘即可撤掉兜底备份；撤不掉只告警，不把已成功的补全报成失败（见 docs/decisions.md「探测式填充」）
        await clearProbeBackup(ctx).catch((error: unknown) => {
            ctx.logger.warn(`${PLUGIN_NAME}: 探测兜底备份清理失败（下次启动会回退本轮补全）：${errorText(error)}`)
        })
        // 终帧最后发：写回已经落盘，消费方拿到 done 时看到的已是最终配置。`fill` 两义见 `ProbeFillResult`
        const filled: VerifySummary = { ...summary, fill }
        finishRun(filled, options)
        return filled
    } finally {
        endIgnoreAll()
    }
}
