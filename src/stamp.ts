/**
 * 参数指纹：判断某个模型参数是「本插件上次写进去的」还是「用户手改的」。
 *
 * 背景：`allowUpdate` 只是个总开关，打开就覆盖，用户手改过的值会被一起冲掉——这正是"允许更新"一直不敢开的原因。
 * 指纹把两者分开：每个模型记一条四字段指纹（档位 / 上下文窗口 / 输出上限 / 模态），逐字段比对，
 * 只有「现在这行还是插件上次写的那一版」的字段才允许被新的自动来源覆盖；手改过的字段按原样冻结。
 * 纯函数，零 ctx：写字节、比对、合并都在这里，`fix.ts` 只做编排。
 *
 * 存储形态（`written` 键，与 `efforts` 记忆同级）：
 * `{ provider: { model: '{"r":"…","c":1000000,"m":128000,"i":"text,image"}' } }`。
 * 故意用一条 JSON 字符串而不是嵌套对象：settings 段里的字面量越浅越好手改，也省掉一层解析。
 */
import type { PluginConfig, WrittenMap } from '@/shared/types'
import { isPlainObject } from '@/shared/types'

/** 单字段指纹：与原值同形的最简表示，缺省为 null */
export interface FieldStamps {
    /** 推理档位（键序归一后的 `级别=原值` 串） */
    r: string | null
    /** 上下文窗口 */
    c: number | null
    /** 输出上限 */
    m: number | null
    /** 输入模态（按声明顺序拼接，`text,image`） */
    i: string | null
    /** 各字段的写入来源：`u` 上游声明、`c` 目录。旧记录没有这一段，按「来源不明」处理（见 mayReplace） */
    s?: Partial<Record<StampField, StampSource>>
}

/** 指纹里的字段名 */
export type StampField = 'r' | 'c' | 'm' | 'i'

/** 写入来源：`u` 上游声明（端点自己报的），`c` 目录（models.dev 缓存） */
export type StampSource = 'u' | 'c'

/** 来源等级：上游 2 > 目录 1 > 来源不明 1（不明按目录级算——目录不许覆盖它，上游可以纠正它） */
function rankOf(source: StampSource | undefined): number {
    return source === 'u' ? 2 : 1
}

/** 新来源能否覆盖旧来源写下的字段：只有「等级更高」才允许。同级同源由调用方的 allowUpdate 决定，
 * 而「上游 → 目录」这一降级永不允许——上游端点一时连不上时，目录值不会再把网关声明顶掉 */
export function mayReplace(previous: StampSource | undefined, next: StampSource | undefined): boolean {
    if (next === undefined) return false
    return rankOf(next) > rankOf(previous)
}

/** 取某字段的来源（旧记录/坏值一律 undefined） */
export function stampSource(stamps: FieldStamps | undefined, field: StampField): StampSource | undefined {
    return stamps?.s?.[field]
}

/** 档位对象归一：只认字符串值，键排序，`off` 排最前（与宿主写回形状无关，只为可比） */
function stampEfforts(value: unknown): string | null {
    if (!isPlainObject(value)) return null
    const keys = Object.keys(value).sort()
    if (keys.length === 0) return null
    return keys.map((key) => `${key}=${String(value[key])}`).join(',')
}

/** 输入模态归一：只认字符串项，保序拼接 */
function stampInput(value: unknown): string | null {
    if (!Array.isArray(value)) return null
    const items = value.filter((item): item is string => typeof item === 'string')
    return items.length === 0 ? null : items.join(',')
}

/** 一行模型参数的四字段指纹（取本轮"已剔除空壳"的行）；`sources` 给出各字段的写入来源，缺省不记来源 */
export function fieldStampsOf(row: {
    reasoningEfforts?: unknown
    contextWindow?: unknown
    maxTokens?: unknown
    input?: unknown
}, sources?: Partial<Record<StampField, StampSource>>): FieldStamps {
    const stamps: FieldStamps = {
        r: stampEfforts(row.reasoningEfforts),
        c: typeof row.contextWindow === 'number' ? row.contextWindow : null,
        m: typeof row.maxTokens === 'number' ? row.maxTokens : null,
        i: stampInput(row.input),
    }
    if (sources !== undefined && Object.keys(sources).length > 0) stamps.s = { ...sources }
    return stamps
}

/** 指纹序列化（写进 `written` 键的字符串） */
export function serializeStamps(stamps: FieldStamps): string {
    return JSON.stringify(stamps)
}

/** 指纹反序列化：坏值（手改、截断、旧格式）一律返回 undefined，等价于「不知道是谁写的」→ 按手改处理 */
export function parseStamps(value: unknown): FieldStamps | undefined {
    if (typeof value !== 'string') return
    let parsed: unknown
    try {
        parsed = JSON.parse(value)
    } catch {
        return
    }
    if (!isPlainObject(parsed)) return
    const { r, c, m, i, s } = parsed
    const stamps: FieldStamps = {
        r: typeof r === 'string' ? r : null,
        c: typeof c === 'number' ? c : null,
        m: typeof m === 'number' ? m : null,
        i: typeof i === 'string' ? i : null,
    }
    if (isPlainObject(s)) {
        const sources: Partial<Record<StampField, StampSource>> = {}
        for (const field of ['r', 'c', 'm', 'i'] as const) {
            const source = s[field]
            if (source === 'u' || source === 'c') sources[field] = source
        }
        if (Object.keys(sources).length > 0) stamps.s = sources
    }
    return stamps
}

/** 本轮补写后的指纹：本轮真正写过的字段换成新值 + 新来源，没写过的字段保留旧记录。
 * 旧记录为 null 或缺失的字段保持 null——它当时不是插件写的，之后也不许被自动来源当成自己的。 */
export function stampPatched(
    previous: FieldStamps | undefined,
    patched: { reasoningEfforts?: unknown; contextWindow?: unknown; maxTokens?: unknown; input?: unknown },
    writtenFields: Partial<Record<StampField, StampSource>>,
): FieldStamps {
    const fresh = fieldStampsOf(patched)
    const next: FieldStamps = previous === undefined
        ? { r: null, c: null, m: null, i: null }
        : { r: previous.r, c: previous.c, m: previous.m, i: previous.i }
    const sources: Partial<Record<StampField, StampSource>> = { ...previous?.s }
    const values = next as Record<StampField, string | number | null>
    const freshValues = fresh as Record<StampField, string | number | null>
    for (const field of ['r', 'c', 'm', 'i'] as const) {
        if (!(field in writtenFields)) continue
        values[field] = freshValues[field]
        const source = writtenFields[field]
        if (source === undefined) delete sources[field]
        else sources[field] = source
    }
    if (Object.keys(sources).length > 0) next.s = sources
    return next
}

/** 取某模型上次写入的指纹（原始字符串，未解析） */
export function writtenOf(written: WrittenMap, provider: string, model: string): string | undefined {
    return written[provider]?.[model]
}

/**
 * 某字段是否仍是插件上次写的那一版：没有记录（从未写过 / 记录损坏）一律 false（按手改处理，宁可不动）。
 * 字段为 undefined（插件当时没写这个字段）时同样 false——当前值只能是别人写的。
 */
export function isPluginWritten(
    written: WrittenMap,
    provider: string,
    model: string,
    field: StampField,
    stamps: FieldStamps,
): boolean {
    const stored = parseStamps(writtenOf(written, provider, model))
    if (!stored) return false
    const current = stamps[field]
    return current !== null && stored[field] === current
}

/** 合并一条指纹记录：只写有变化的模型；返回原引用表示无变化（供 `deepEqualJson` 之外的最省路径） */
export function withStamps(
    written: WrittenMap,
    provider: string,
    model: string,
    stamps: FieldStamps,
): WrittenMap {
    const serialized = serializeStamps(stamps)
    if (written[provider]?.[model] === serialized) return written
    return {
        ...written,
        [provider]: { ...written[provider], [model]: serialized },
    }
}

/** 取当前生效的 `written` 记录（配置缺项时给空表，调用方无需判空） */
export function writtenMapOf(cfg: PluginConfig): WrittenMap {
    return cfg.written
}
