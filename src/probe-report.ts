import type { ProviderProbeOutcome, UnsupportedEffort, UsableEffort, VerifyProbeResult, VerifyProviderReport, VerifySummary } from '@/shared/verify-progress'

/**
 * 探测的汇报层：把一组的结论折成一份汇报，再把各组汇报折成一份全局汇总。
 *
 * 「折」这一步的口径与执行、判定都无关：请求已经发完、结论已经定了，剩下的只是数字怎么加、
 * 哪些失败有资格翻某个开关。摘出来单独成文件，是为了让它能脱离网络与 ctx 被直接测——
 * 计数口径（可用档位只计带档位的请求、可达与凭据取自全程而非首个）正是最容易随改动悄悄漂移的地方。
 * 纯函数、零 ctx、不触网。
 */

/**
 * 单组结论 -> 汇报：可用模型按「提供方 / 模型」去重；档位不可用单独计数，不与其它失败混计。
 * 可达 / 凭据取自**全程**结果（被验请求与基线探测一并计入）而非首个。
 *
 * **只认能否定整个提供方的失败**：端点不通翻 `reachable`，凭据无效翻 `keyValid`，额度耗尽两者都不翻
 * （它多半是按模型设的额度，属模型级事实）。理由见 docs/decisions.md「验证」。
 */
export function reportProvider(result: ProviderProbeOutcome): VerifyProviderReport {
    const usable = new Set<string>()
    let efforts = 0
    let unsupported = 0
    let unreachable = false
    let keyRejected = false
    for (const item of result.results) {
        if (item.outcome === 'usable') {
            // 可用**档位**数只计带档位的请求；不带档位的那条要么是对照（基线探测），要么本身即被验对象（计模型数）
            if (item.effort !== undefined) efforts++
            usable.add(JSON.stringify([item.provider, item.model]))
        } else if (item.outcome === 'unsupported-effort') {
            unsupported++
        } else if (item.outcome === 'unreachable') {
            unreachable = true
        } else if (item.outcome === 'credential') {
            keyRejected = true
        }
    }
    // 基线探测同样能证伪端点与凭据（它也是真发出去的一次请求），故一并纳入；只是它不产明细、不计任何计数
    for (const item of result.tests) {        if (item.outcome === 'unreachable') unreachable = true
        else if (item.outcome === 'credential') keyRejected = true
    }
    return {
        provider: result.provider,
        reachable: !unreachable,
        // 从未拿到 HTTP 响应时无从判断凭据，如实不报「有效」
        keyValid: !unreachable && !keyRejected,
        skipped: result.blockedBy !== undefined,
        blockedBy: result.blockedBy,
        tested: result.tested,
        models: usable.size,
        efforts,
        unsupported,
        planned: result.planned,
        plannedEfforts: result.plannedEfforts,
        probed: result.results.length,
    }
}

/** 全局汇总：各组汇报相加；明细按「组序 → 组内探测序」平铺，顺序稳定可重复消费 */
export function summarizeProviders(
    reports: readonly VerifyProviderReport[],
    results: readonly VerifyProbeResult[],
): VerifySummary {
    let models = 0
    let efforts = 0
    let unsupported = 0
    let planned = 0
    let plannedEfforts = 0
    let probed = 0
    let tested = 0
    for (const report of reports) {
        models += report.models
        efforts += report.efforts
        unsupported += report.unsupported
        planned += report.planned
        plannedEfforts += report.plannedEfforts
        probed += report.probed
        tested += report.tested
    }
    // 两种明确状态的档位明细（可用 / 不支持）：只认带档位的条目，且与上面的聚合同源、不另算一套口径。
    // 带档位的逐条明细才是要写回配置的那份——浏览器半不自己从 results 里重筛一遍（见共享层 `VerifySummary`）
    const usableEfforts: UsableEffort[] = []
    const unsupportedEfforts: UnsupportedEffort[] = []
    for (const item of results) {
        if (item.effort === undefined) continue
        if (item.outcome === 'usable') usableEfforts.push({ provider: item.provider, model: item.model, effort: item.effort })
        else if (item.outcome === 'unsupported-effort') unsupportedEfforts.push({ provider: item.provider, model: item.model, effort: item.effort })
    }
    return {
        providers: reports,
        results,
        unsupportedEfforts,
        usableEfforts,
        tested,
        models,
        efforts,
        unsupported,
        planned,
        plannedEfforts,
        probed,
    }
}
