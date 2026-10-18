import { LEVELS } from '@/constants'
import type { VerifyProbe } from '@/shared/verify-progress'
import { isPlainObject } from '@/shared/types'

/**
 * 探测的计划层：把浏览器半发来的未信任载荷，校验并展开成「按提供方分组的待跑清单」。
 *
 * 入参来自网络，一律按不可信输入校验——校验与展开都在这里，收在一处，两个功能不各写一份；
 * 「能发多少」的两条硬闸也在这里，且两个功能各给一份配额（见 `ProbeLimits`）。
 * 纯函数、零 ctx、不触网，故计划可以被单独测到条目粒度。
 */

/** 一个提供方的探测组：组内顺序执行即「每 provider 单并发」的结构保证 */
export interface ProviderProbeGroup {
    provider: string
    /** 各探测在原数组中的下标（结果按此回填，汇总与顺序无关） */
    indexes: number[]
    probes: VerifyProbe[]
}

/**
 * 一轮请求的两条硬闸：真正会发出的**请求数**与计划里的**模型数**。
 *
 * 上限约束的是烧掉的额度，故超出即拒绝而非静默截断——截断会让用户以为「全查过了」。
 * 两个功能各给一份配额（量级差一个数量级），入参校验共用一份实现（`planProbes`），只有上限不同。
 */
interface ProbeLimits {
    /** 真正会发出的请求数上限（计划条目一条即一次请求） */
    maxProbes: number
    /** 计划模型数上限（按「提供方 / 模型」去重） */
    maxModels: number
}

/** 验证的配额：每模型一条请求（不带档位参数），请求数即勾选模型数，封顶 200（超出即拒绝，用户可减少勾选重来） */
export const VERIFY_LIMITS: ProbeLimits = { maxProbes: 200, maxModels: Number.POSITIVE_INFINITY }
/** 探测档位的配额：全量展开为「模型数 × 至多 7 档」（off 仅当模型已声明时才探测），故模型数封顶 200（至多 1400 次最小请求） */
export const PROBE_LIMITS: ProbeLimits = { maxProbes: 1400, maxModels: 200 }

/**
 * 校验并展开请求载荷为清单：按模型序遍历。
 *
 * 条目不带 `efforts`（或给空数组）即一条不带 `reasoningEffort` 的请求——验证的每个模型都长这样；
 * 带 `efforts` 的条目（探测档位）按档位逐条展开。任何非法条目或超出 `limits` 一律拒绝（返回 undefined）。
 */
export function planProbes(payload: unknown, limits: ProbeLimits = VERIFY_LIMITS): VerifyProbe[] | undefined {
    if (!isPlainObject(payload)) return
    const models = payload.models
    if (!Array.isArray(models) || models.length === 0) return
    const probes: VerifyProbe[] = []
    for (const entry of models) {
        if (!isPlainObject(entry)) return
        const { provider, model, efforts } = entry
        if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return
        if (efforts === undefined || (Array.isArray(efforts) && efforts.length === 0)) {
            // 没有档位要试：这条不带档位的请求本身就是被验对象
            probes.push({ provider, model })
            continue
        }
        if (!Array.isArray(efforts)) return
        for (const effort of efforts) {
            // 档位须落在 harness 支持的取值内：入参来自浏览器，而浏览器亦只从配置里取键，仍按不可信输入校验
            if (typeof effort !== 'string' || !LEVELS.has(effort)) return
            probes.push({ provider, model, effort })
        }
    }
    // 清单一条即一次真实请求，故请求数取清单长度；模型数另按「提供方 / 模型」去重计
    const plannedModels = new Set<string>()
    for (const probe of probes) {
        plannedModels.add(JSON.stringify([probe.provider, probe.model]))
    }
    return probes.length > limits.maxProbes || plannedModels.size > limits.maxModels ? undefined : probes
}

/** 按 provider 分组，组内保持探测原序；组序为提供方首次出现序 */
export function groupProbesByProvider(probes: readonly VerifyProbe[]): ProviderProbeGroup[] {
    const byProvider = new Map<string, ProviderProbeGroup>()
    probes.forEach((probe, index) => {
        let group = byProvider.get(probe.provider)
        if (group === undefined) {
            group = { provider: probe.provider, indexes: [], probes: [] }
            byProvider.set(probe.provider, group)
        }
        group.indexes.push(index)
        group.probes.push(probe)
    })
    return [...byProvider.values()]
}

/**
 * 校验并展开未信任载荷，按提供方分组返回待跑清单；入参非法即抛出。
 *
 * 与执行拆成两步：`done` 帧必须等**整轮**结束才发，而探测档位的「整轮」含收敛写回，
 * 故计划得先交到调用方手里（它还要拿模型清单去写配置）。
 *
 * @param payload 未信任的请求载荷（浏览器半发的模型清单）
 * @param limits 本轮的两条硬闸（请求数 / 模型数），验证与探测档位各用一份
 * @param rejectMessage 入参非法时的报错文案：两个功能说法不同，由调用方给出
 */
export function planProbeGroups(payload: unknown, limits: ProbeLimits, rejectMessage: string): ProviderProbeGroup[] {
    const probes = planProbes(payload, limits)
    if (probes === undefined) throw new Error(rejectMessage)
    return groupProbesByProvider(probes)
}
