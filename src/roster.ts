/**
 * 上游模型清单的对账：把「这次抓到的完整清单」与「配置里的模型列表」比一次，得出
 * ① 哪些是**没见过的新模型**（进待上线清单，只提示，不写配置）
 * ② 哪些是**连续两次都缺席的已下架模型**（从列表移除）
 *
 * 口径是**精确 id**：网关接受的就是这串字符，改一个字符就等于旧模型下架 + 新模型上线，
 * 因此这里不做任何归一化或模糊匹配（见 docs/decisions-config.md「模型清单对账」）。
 *
 * 纯函数、零 ctx：所有输入都是一份快照，便于单测与「同一个 providers 对象被复用」的调用方。
 */
import { MAX_REMOVALS_PER_ROUND, PENDING_CAP, REMOVAL_STRIKES } from '@/shared/constants'
import { isPlainObject, type KnownMap, type MissMap, type PendingEntry, type PendingMap, type PluginConfig, type WrittenMap } from '@/shared/types'
import type { SnapshotMap } from '@/upstream'

/** 一次对账的产物：可直接喂给 `planFill`，也可原样落盘 */
export interface RosterPlan {
    /** 删过模型的 providers（没动过的提供方沿用原引用） */
    readonly providers: Record<string, unknown>
    /** provider → 本轮移除的 id（日志与提示用） */
    readonly removed: Map<string, string[]>
    /** provider → 本轮新发现的条目（id → 条目，含非对话；调用方据此决定提示文案） */
    readonly discovered: Map<string, Record<string, PendingEntry>>
    readonly known: KnownMap
    readonly pending: PendingMap
    readonly missing: MissMap
    /** 删除模型时一并剪掉它的参数指纹（`sources` pin 属于用户意图，保留） */
    readonly written: WrittenMap
    readonly changed: boolean
}

/** 从 providers 里取某个提供方的模型行数组（非数组即视为「这个提供方没写模型」） */
function rowsOf(provider: unknown): Record<string, unknown>[] | undefined {
    if (!isPlainObject(provider)) return undefined
    const models = provider.models
    if (!Array.isArray(models)) return undefined
    return models.filter((row): row is Record<string, unknown> => isPlainObject(row))
}

/** 行里的 id（非字符串/空串视为无效行） */
function idOf(row: Record<string, unknown>): string | undefined {
    const id = row.id
    return typeof id === 'string' && id !== '' ? id : undefined
}

/** 给一个提供方初始化账本：把「上游现有」与「配置里已有」一起记为见过。
 * 首次记账不产生任何提示——否则装上插件那一刻会把没勾选的模型全报成「上新」 */
function seed(declared: readonly string[], present: readonly string[]): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const id of [...declared, ...present]) {
        if (seen.has(id)) continue
        seen.add(id)
        result.push(id)
    }
    return result
}

export function reconcile(
    cfg: PluginConfig,
    providers: Record<string, unknown>,
    snapshots: SnapshotMap,
): RosterPlan {
    const excludes = new Set(cfg.excludes)
    const known: KnownMap = { ...cfg.known }
    const pending: PendingMap = { ...cfg.pending }
    const missing: MissMap = { ...cfg.missing }
    let written: WrittenMap = cfg.written
    const removed = new Map<string, string[]>()
    const discovered = new Map<string, Record<string, PendingEntry>>()
    let changed = false
    let nextProviders = providers

    for (const [providerId, snapshot] of snapshots) {
        if (excludes.has(providerId)) continue
        // 抓取失败 = 这次没问到，什么都不改（既不能判上新，也不能判下架）
        if (!snapshot.ok) continue
        const provider = providers[providerId]
        const rows = rowsOf(provider)
        const declaredMap = snapshot.roster
        const declaredIds = [...declaredMap.keys()]

        const present: string[] = []
        const rowIndex = new Map<string, number>()
        rows?.forEach((row, index) => {
            const id = idOf(row)
            if (id === undefined || rowIndex.has(id)) return
            rowIndex.set(id, index)
            present.push(id)
        })

        const previous = known[providerId]
        if (previous === undefined) {
            // 首次记账：只播种，不提示
            known[providerId] = seed(declaredIds, present)
            changed = true
        } else {
            const seen = new Set(previous)
            const fresh: Record<string, PendingEntry> = {}
            for (const id of declaredIds) {
                if (seen.has(id) || rowIndex.has(id)) continue
                const entry = declaredMap.get(id)
                fresh[id] = entry?.name === undefined ? { kind: entry?.kind ?? 'chat' } : { kind: entry?.kind ?? 'chat', name: entry.name }
            }
            if (Object.keys(fresh).length > 0) {
                const merged: Record<string, PendingEntry> = { ...pending[providerId], ...fresh }
                // 上限只防「网关一夜之间上架几百个」把配置撑爆，超出部分丢弃（下次抓取会重新发现）
                const ids = Object.keys(merged)
                pending[providerId] = ids.length <= PENDING_CAP
                    ? merged
                    : Object.fromEntries(ids.slice(ids.length - PENDING_CAP).map((id) => [id, merged[id]]))
                discovered.set(providerId, fresh)
                changed = true
            }
            if (declaredIds.some((id) => !seen.has(id))) {
                const merged = new Set(previous)
                for (const id of declaredIds) merged.add(id)
                known[providerId] = [...merged]
                changed = true
            }
        }

        // 待上线清单：上游已撤下的条目、以及用户已经手动加进列表的条目都不该再留着
        const currentPending = pending[providerId]
        if (currentPending !== undefined) {
            const kept: Record<string, PendingEntry> = {}
            for (const [id, entry] of Object.entries(currentPending)) {
                if (!declaredMap.has(id) || rowIndex.has(id)) continue
                kept[id] = entry
            }
            if (Object.keys(kept).length !== Object.keys(currentPending).length) {
                if (Object.keys(kept).length === 0) delete pending[providerId]
                else pending[providerId] = kept
                changed = true
            }
        }

        // 下架判定：只在开关打开时累计缺席次数
        const declaredSet = new Set(declaredIds)
        const miss = { ...missing[providerId] }
        let touched = false
        for (const id of present) {
            if (!declaredSet.has(id)) continue
            if (miss[id] !== undefined) {
                delete miss[id]
                touched = true
            }
        }
        for (const id of Object.keys(miss)) {
            if (!rowIndex.has(id)) {
                delete miss[id]
                touched = true
            }
        }
        if (cfg.userExperience.autoRemoveModels) {
            const victims: string[] = []
            for (const id of present) {
                if (declaredSet.has(id)) continue
                if (victims.length >= MAX_REMOVALS_PER_ROUND) break
                const count = (miss[id] ?? 0) + 1
                if (count >= REMOVAL_STRIKES) {
                    victims.push(id)
                    delete miss[id]
                } else {
                    miss[id] = count
                }
                touched = true
            }
            if (victims.length > 0) {
                const victimsSet = new Set(victims)
                const nextRows = (rows ?? []).filter((row) => {
                    const id = idOf(row)
                    return id === undefined || !victimsSet.has(id)
                })
                nextProviders = { ...nextProviders, [providerId]: { ...(provider as Record<string, unknown>), models: nextRows } }
                removed.set(providerId, victims)
                // 指纹跟着删；`sources` 是用户意图，留着（模型若回归仍按原 pin 取参数）
                const stamps = written[providerId]
                if (stamps !== undefined) {
                    const kept = { ...stamps }
                    for (const id of victims) delete kept[id]
                    written = { ...written, [providerId]: kept }
                }
                changed = true
            }
        }
        // 缺席计数本身也是一次账本变化：不置 changed 的话调用方会走「本轮无事可做」的提前返回，
        // strike 永远落不了盘，也就永远等不到第二次缺席（实测：上游删了模型、刷新多次仍在列表里）
        if (touched) changed = true
        if (touched && Object.keys(miss).length === 0) delete missing[providerId]
        else if (touched) missing[providerId] = miss
    }

    // 提供方已被删掉：它的三本账一并丢弃，免得删了再加回来时沿用旧账本（新 id 会一直「不算新面孔」）
    const live = new Set(Object.keys(providers))
    for (const table of [known, pending, missing] as Record<string, unknown>[]) {
        for (const providerId of Object.keys(table)) {
            if (live.has(providerId)) continue
            delete table[providerId]
            changed = true
        }
    }

    return { providers: nextProviders, removed, discovered, known, pending, missing, written, changed }
}
