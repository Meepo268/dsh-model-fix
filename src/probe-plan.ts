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
 * 验证按用户勾选展开（档位累加），探测式填充按模型展开（至多 7 档/模型，off 仅已声明时才探测），量级差一个数量级，
 * 故两者各给一份配额；入参校验本身共用一份实现（`planProbes`），只有上限不同。
 */
export interface ProbeLimits {
    /** 真正会发出的请求数上限（含不带档位的基线探测） */
    maxProbes: number
    /** 计划模型数上限（按「提供方 / 模型」去重） */
    maxModels: number
}

/** 验证的配额：勾选展开，请求数封顶 200（超出即拒绝，用户可减少勾选重来） */
export const VERIFY_LIMITS: ProbeLimits = { maxProbes: 200, maxModels: Number.POSITIVE_INFINITY }
/** 探测式填充的配额：全量展开为「模型数 × 至多 7 档」（off 仅当模型已声明时才探测），故模型数封顶 200（至多 1400 次最小请求） */
export const PROBE_LIMITS: ProbeLimits = { maxProbes: 1400, maxModels: 200 }

/**
 * 校验并展开请求载荷为清单：按模型序遍历，每个模型带上它自己要试的那些档位。
 *
 * 清单里只有**被验对象**：每个档位一条请求；模型没有档位可验时，那一条不带 `reasoningEffort` 的请求
 * 本身就是被验对象。`needTest` 为真的模型另需一次不带档位的**基线探测**作对照（判「某档位不被支持」全靠它，
 * 上游对这类报错的格式千差万别），但基线不进清单——它在执行阶段按需现发，不被统计、也不产出记录。
 * 任何非法条目或超出 `limits` 一律拒绝（返回 undefined）。
 */
export function planProbes(payload: unknown, limits: ProbeLimits = VERIFY_LIMITS): VerifyProbe[] | undefined {
    if (!isPlainObject(payload)) return
    const models = payload.models
    if (!Array.isArray(models) || models.length === 0) return
    const probes: VerifyProbe[] = []
    for (const entry of models) {
        if (!isPlainObject(entry)) return
        const { provider, model, efforts, needTest } = entry
        if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return
        if (!Array.isArray(efforts) || typeof needTest !== 'boolean') return
        if (efforts.length === 0) {
            // 没有档位要验：这次请求就是被验对象，不存在「对照」一说，故 needTest 必假
            if (needTest) return
            probes.push({ provider, model, needTest })
            continue
        }
        for (const effort of efforts) {
            // 档位须落在 harness 支持的取值内：入参来自浏览器，而浏览器亦只从配置里取键，仍按不可信输入校验
            if (typeof effort !== 'string' || !LEVELS.has(effort)) return
            probes.push({ provider, model, effort, needTest })
        }
    }
    // 请求数算的是真正会发出的那些（含基线）：它约束的是烧掉的额度，清单长度只是它的一部分。
    // 基线每模型至多一条，故按模型去重后再计数（同一模型的若干档位只多算一条）
    const plannedModels = new Set<string>()
    let requests = probes.length
    for (const probe of probes) {
        const key = JSON.stringify([probe.provider, probe.model])
        if (plannedModels.has(key)) continue
        plannedModels.add(key)
        if (probe.needTest) requests++
    }
    return requests > limits.maxProbes || plannedModels.size > limits.maxModels ? undefined : probes
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
 * 与执行拆成两步是有原因的：`done` 帧必须等**整轮**结束才发，而探测式填充的「整轮」含收敛写回——
 * 写回结果要随终帧一起交回浏览器半，故计划得先交到调用方手里（它还要拿模型清单去写配置）。
 *
 * @param payload 未信任的请求载荷（浏览器半发的模型清单）
 * @param limits 本轮的两条硬闸（请求数 / 模型数），验证与探测式填充各用一份
 * @param rejectMessage 入参非法时的报错文案：两个功能说法不同，由调用方给出
 */
export function planProbeGroups(payload: unknown, limits: ProbeLimits, rejectMessage: string): ProviderProbeGroup[] {
    const probes = planProbes(payload, limits)
    if (probes === undefined) throw new Error(rejectMessage)
    return groupProbesByProvider(probes)
}
