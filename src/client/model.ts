/**
 * 浏览器半纯映射层：`tikaflow-model-fix` 版本快照段 <-> 卡片配置（五组布尔 + excludes 列表）。
 * 跨半共享的常量、类型、解析函数单一来源在 `src/shared/`（经 client 纯度门禁放行，不引 Node 专属值）。
 * 本文件只保留 UI 层：组的行键表与渲染顺序、快照↔配置的 UI 派生、验证与探测候选的拍取与目标收敛。
 */

import type { PluginConfig } from '@/shared/types'
import { isPlainObject, providersOf } from '@/shared/types'
import { EFFORT_LEVELS } from '@/shared/constants'
import { CONFIG_VERSION, DEFAULT_CONFIG, FIELD_KEYS, COMPAT_KEYS, USER_EXPERIENCE_KEYS, BEHAVIOR_KEYS, parseSnapshot, versionKey } from '@/shared/config-schema'

/** 版本快照键 */
export const VERSION_KEY = versionKey(CONFIG_VERSION)

/** 瓦片对应的配置组：两个填充列 + 兼容性组 + UI 可见性组 + 用户体验组 */
export type Group = 'autoFill' | 'allowUpdate' | 'compat' | 'behavior' | 'userExperience'

/** 各组行键表（渲染顺序与总控共用） */
export const GROUP_KEYS: Record<Group, readonly RowKey[]> = {
    autoFill: FIELD_KEYS,
    allowUpdate: FIELD_KEYS,
    compat: COMPAT_KEYS,
    behavior: BEHAVIOR_KEYS,
    userExperience: USER_EXPERIENCE_KEYS,
}

/** 全部布尔配置组（脏检测遍历用，遍历顺序无关紧要；瓦片的渲染顺序另见 tile.tsx 的 TILE_ORDER——behavior 排在用户体验之后） */
const GROUPS: readonly Group[] = ['autoFill', 'allowUpdate', 'compat', 'behavior', 'userExperience']

/** 组内行键全集（词典键映射与各组行表的类型） */
export type RowKey =
    | (typeof FIELD_KEYS)[number]
    | (typeof COMPAT_KEYS)[number]
    | (typeof BEHAVIOR_KEYS)[number]
    | (typeof USER_EXPERIENCE_KEYS)[number]

/** 卡片侧消费的完整当前配置（与 PluginConfig 同形：四组布尔 + excludes + efforts） */
export type Flags = PluginConfig

/**
 * 解码命名空间整段：只读当前版本快照（键见上方 `VERSION_KEY`；Node 半迁移保证启动后段内必有，见 migrateConfig）；
 * 段非法、快照缺失或非法均回退默认。永不返回 undefined（返回 undefined 会让宿主 scope 永挂 loading）。
 */
export function decodeSection(section: unknown): Flags {
    return isPlainObject(section) ? parseSnapshot(section[VERSION_KEY]) ?? DEFAULT_CONFIG : DEFAULT_CONFIG
}

/** 组内布尔对象的视图：组的值类型是 union，类型收窄只在此处发生一次 */
function rowsOf(flags: Flags, group: Group): Record<string, boolean> {
    return flags[group] as unknown as Record<string, boolean>
}

/** 单格取值 */
export function groupValue(flags: Flags, group: Group, key: RowKey): boolean {
    return rowsOf(flags, group)[key] === true
}

/**
 * 某 UI 部件是否应当挂载：读 `behavior` 组对应开关，配置缺席（段未就绪）时按缺省全开处理。
 *
 * 与 `groupValue` 的差别只有缺省方向——配置读不到时若落 `false` 会让首屏凭空少一块界面，
 * 故此处缺省取「可见」。组内取值仍一律按严格布尔判。
 */
export function behaviorVisible(flags: Flags | undefined, key: (typeof BEHAVIOR_KEYS)[number]): boolean {
    if (flags === undefined) return true
    return rowsOf(flags, 'behavior')[key] !== false
}

/**
 * 跟随**实际生效**的判据：插件开关开着且宿主「允许 Agent 为子智能体选择模型」那段设置未开启。
 * 宿主那段开启时子智能体自会按授权表选模型，跟随反而推翻宿主的合法选择，此时「跟随中」灯应呈灰态。
 *
 * `hostEnabled` 由浏览器半读宿主 `subagent-model-selection-settings` 段得出；段读不到记 `undefined`＝视为未开启
 * （缺席 ≠ 显式开启，与 Node 半 `subagent.ts` 的 try/catch 口径一致）。
 */
export function followingActive(flags: Flags, hostEnabled: boolean | undefined): boolean {
    return groupValue(flags, 'userExperience', 'followParent') && !hostEnabled
}

/** 组总控的当前显示值：组内全为开才显示开。判据取 every 而非 any——部分选中显示关，点击即整组补全为开；
 *  若取 any，部分选中会显示成开、点击反而把用户已勾的那几行抹掉。口径与验证弹层分组「全选」一致。 */
export function masterValue(flags: Flags, group: Group): boolean {
    return GROUP_KEYS[group].every((key) => groupValue(flags, group, key))
}

/** 整组同置：把 group 的全部行设为 value，返回新对象（不改入参） */
export function applyGroup(flags: Flags, group: Group, value: boolean): Flags {
    const rows: Record<string, boolean> = {}
    for (const key of GROUP_KEYS[group]) rows[key] = value
    return { ...flags, [group]: rows } as Flags
}

/** 单格取反：把 group.key 翻转，返回新对象（不改入参） */
export function toggleCell(flags: Flags, group: Group, key: RowKey): Flags {
    const rows = { ...rowsOf(flags, group) }
    rows[key] = !rows[key]
    return { ...flags, [group]: rows } as Flags
}

/**
 * 排除列表逐项比较（**顺序敏感**）：草稿只由已存值经增删派生，顺序不会自行漂移，
 * 故无需排序——插入顺序是用户意图的一部分。
 */
function sameIdList(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false
    return a.every((id, index) => id === b[index])
}

/** 布尔组 + 排除列表逐项比较，判断草稿相对已存配置是否有改动（`efforts` 是运行时记忆，不参与比较） */
export function isDirty(draft: Flags, saved: Flags): boolean {
    for (const group of GROUPS) {
        for (const key of GROUP_KEYS[group]) {
            if (groupValue(draft, group, key) !== groupValue(saved, group, key)) return true
        }
    }
    return !sameIdList(draft.excludes, saved.excludes)
}

/**
 * 从 `llm-pi-ai` 的 user 层取提供方 id（与 Node 半 fix 遍历的 `descriptor.user.providers` 同一事实源，
 * 故「命中」判定与本插件真实会跳过的集合零漂移）。非纯对象、无 providers 或 providers 非纯对象一律视为空。
 */
export function providerIdsOf(user: unknown): string[] {
    return Object.keys(providersOf(user) ?? {})
}

/** 命中的排除项集合：既决定标签的命中高亮，其 size 即 summary 徽标的命中数 */
export function resolveHits(excludes: readonly string[], providerIds: readonly string[]): ReadonlySet<string> {
    const live = new Set(providerIds)
    return new Set(excludes.filter((id) => live.has(id)))
}

/** 新增排除项：已存在则原样返回（调用方先行拦截重复，此处只保证幂等）；不改入参 */
export function addExclude(flags: Flags, id: string): Flags {
    if (flags.excludes.includes(id)) return flags
    return { ...flags, excludes: [...flags.excludes, id] }
}

/** 删除排除项：不存在的 id 原样返回；不改入参 */
export function removeExclude(flags: Flags, id: string): Flags {
    const index = flags.excludes.indexOf(id)
    if (index < 0) return flags
    const excludes = [...flags.excludes]
    excludes.splice(index, 1)
    return { ...flags, excludes }
}

/** 排除项 id 的合法性规则：逐字复制宿主 models 页新增提供方时的 route id 校验（同一权威规则，两侧不得自行放宽） */
export const EXCLUDE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * 一个待验证的「提供方 / 模型」：附带该模型在配置里声明的推理级别（`reasoningEfforts` 的键，
 * 按 `EFFORT_LEVELS` 由低到高排序去重；无该字段即 `[]`，表示不带档位探测）。
 */
export interface VerifyCandidate {
    provider: string
    model: string
    efforts: string[]
}

/** 选择键：模型 id 可含 '/'，故取二元组序列化而非字符串拼接（同一口径与 Node 半 `src/probe-report.ts` 的去重键一致） */
export function verifyKey(provider: string, model: string): string {
    return JSON.stringify([provider, model])
}

/**
 * 候选遍历的唯一实现：验证与探测式填充共用同一份事实源与同一套形状规则，
 * 两者只在「收哪些」上分岔（前者全收，后者按两个开关过滤）。
 * 保持录入顺序；提供方非对象、无 models 数组、模型无 id 的行一律跳过。
 */
function candidatesOf(user: unknown, keep: (provider: string, candidate: VerifyCandidate) => boolean): VerifyCandidate[] {
    const candidates: VerifyCandidate[] = []
    for (const [provider, entry] of Object.entries(providersOf(user) ?? {})) {
        if (!isPlainObject(entry) || !Array.isArray(entry.models)) continue
        for (const model of entry.models) {
            if (!isPlainObject(model) || typeof model.id !== 'string' || model.id === '') continue
            const declared = isPlainObject(model.reasoningEfforts) ? model.reasoningEfforts : undefined
            // 档位取配置里的**键**（即模型页送出、宿主校验的那个 id），并按规范次序归一
            const efforts = declared === undefined ? [] : EFFORT_LEVELS.filter((level) => Object.hasOwn(declared, level))
            const candidate: VerifyCandidate = { provider, model: model.id, efforts: [...efforts] }
            if (keep(provider, candidate)) candidates.push(candidate)
        }
    }
    return candidates
}

/**
 * 从 `llm-pi-ai` 的 user 层拍出验证候选（与 Node 半 fix 遍历同一事实源，故列表与实际会填充的模型零漂移）。
 * 不套用 `excludes`：验证是只读诊断，排除语义只约束插件对配置的写入。
 */export function verifyCandidatesOf(user: unknown): VerifyCandidate[] {
    return candidatesOf(user, () => true)
}

/** 探测式填充的两个开关：只影响「收哪些模型」，不影响请求本身 */
interface ProbeCandidateOptions {
    /** 排除提供方 id（取卡片上的当前值，与「命中」判定同源，故所见即所得） */
    excludes: readonly string[]
    /** 忽略排除：开则连被排除的提供方也一起探测（Node 半的两次写回同时放行，两处必须同一个开关） */
    ignoreExcludes: boolean
    /** 只收未填充的：该模型没有声明 `reasoningEfforts`，或该字段只有 `off` 一个档位 */
    unfilledOnly: boolean
}

/** 「未填充」判据：无档位声明，或只声明了 `off`（等同于「这个模型不推理」） */
function isUnfilled(efforts: readonly string[]): boolean {
    return efforts.length === 0 || efforts.every((effort) => effort === 'off')
}

/**
 * 探测式填充的候选：与验证候选同源同形，只按两个开关收窄。
 *
 * 「忽略排除」必须同时传给 Node 半的两次写回——两边共用同一个开关值（理由见 docs/decisions.md「探测式填充」）。
 */
export function probeCandidatesOf(user: unknown, options: ProbeCandidateOptions): VerifyCandidate[] {
    const excluded = new Set(options.excludes)
    return candidatesOf(user, (provider, candidate) => (options.ignoreExcludes || !excluded.has(provider))
        && (!options.unfilledOnly || isUnfilled(candidate.efforts)))
}

/**
 * 探测式填充的**请求计划**：每个模型按 `EFFORT_LEVELS` 由低到高各试一档；**off 仅当模型已声明时才探测**
 * （未声明 off 的模型不补 off——"能通"不等于"能关"）。
 *
 * `needTest` 恒假：本功能没有「不带档位的基线对照」——Node 半会先把候选档位临时预声明进配置（见 `src/probe.ts`），
 * 预声明本身就是那次对照。
 */
export function probeTargetsOf(candidates: readonly VerifyCandidate[]): VerifyTarget[] {
    return candidates.map((candidate) => ({
        ...candidate,
        efforts: EFFORT_LEVELS.filter((level) => level !== 'off' || candidate.efforts.includes('off')),
        needTest: false,
    }))
}

/**
 * 一次验证的**请求计划**里的一条：一个待验的「提供方 / 模型」+ 它的档位 + 是否需要先探测一次。
 * `efforts` 为空数组的模型两者相同，但「空数组」在两种语境下含义不同（列表里是「该模型没声明档位」，
 * 计划里是「这次不带档位验」）。
 */
export interface VerifyTarget extends VerifyCandidate {
    /**
     * 是否需要先发一次不带 `reasoningEffort` 的**探测**作对照。
     *
     * 判「某档位不被支持」只能靠这个对照，故有档位可验时必为真；而两种情形为假——
     * 关掉档位开关时全部请求本就不带参数，以及模型没有声明任何档位时——
     * 此时那一次不带档位的请求**本身就是被验对象**，再补一条探测纯属白烧额度。
     */
    needTest: boolean
}

/**
 * 从勾选的候选算出请求计划：`allEfforts` 为真时逐个验该模型**声明的全部**推理级别，否则一律不带档位。
 *
 * 「不带档位」而不是挑一个最低档位：不带参数并不等于端点不会推理——端点可能有自己的默认推理级别，
 * 那种情况下发 `off` 验的不是用户实际会走的那条路径。两种模式下未声明档位的模型都产出空数组，
 * 即一次不带 `reasoningEffort` 的请求（开档位模式对它没有可验的档位，与关档位模式同形），
 * 并且 `needTest` 为假——那一请求就是被验对象，不是对照。
 */
export function verifyTargets(
    candidates: readonly VerifyCandidate[],
    keys: ReadonlySet<string>,
    allEfforts: boolean,
): VerifyTarget[] {
    return candidates
        .filter((candidate) => keys.has(verifyKey(candidate.provider, candidate.model)))
        .map((candidate) => {
            const efforts = allEfforts ? candidate.efforts : []
            return { ...candidate, efforts: [...efforts], needTest: efforts.length > 0 }
        })
}

/**
 * 该组是否已全选：判据取 `every` 而非 `any`——部分选中时仍显示「全选」，全选中才翻成「取消全选」，
 * 与官方 `allVisibleCandidatesPicked` 同语义。
 *
 * **按钮文案与点击方向必须共用本函数**：两处各写一遍 `every` 一旦不同步，就会出现
 * 「文案显示取消全选、点击却是全选」的反直觉行为且不报错。
 */
export function groupAllPicked(picked: ReadonlySet<string>, models: readonly VerifyCandidate[]): boolean {
    return models.every((candidate) => picked.has(verifyKey(candidate.provider, candidate.model)))
}

/** 分组「全选 / 取消全选」：已全选则整组移出，否则整组加入。返回新集合（不改入参、只动本组的键） */
export function toggleGroupPicks(picked: ReadonlySet<string>, models: readonly VerifyCandidate[]): ReadonlySet<string> {
    const next = new Set(picked)
    const remove = groupAllPicked(next, models)
    for (const candidate of models) {
        const key = verifyKey(candidate.provider, candidate.model)
        if (remove) next.delete(key)
        else next.add(key)
    }
    return next
}
