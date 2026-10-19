import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { MAX_ATTEMPTS } from '@/constants'
import { PLUGIN_NAME, PLUGIN_NS } from '@/shared/constants'
import { CONFIG_VERSION, DEFAULT_CONFIG, MAX_OLD_SNAPSHOTS, MIN_SUPPORTED_VERSION, parseSnapshot, parseVersion, toStored, versionKey } from '@/shared/config-schema'
import { resolveConfig } from '@/config'
import { queueTask } from '@/host'
import type { PluginConfigSnapshot, VersionedSection } from '@/shared/types'
import { isPlainObject } from '@/shared/types'
import { descriptorOf, sectionOf } from '@/section'
import { upgradeConfig } from '@/upgrade'
import { errorText, isSettingsConflict } from '@/shared/errors'

/**
 * 自有配置段（`version-N` 快照映射）的当前版本侧：启动迁移、旧快照清理与 onChange 自愈。
 * 旧版本「升上来」交给 `src/upgrade.ts` 的冻结台阶链（选迁移源时调它）；落盘口都在 `CURRENT_KEY`，物化用 `toStored`。
 */

/** 全新用户的规范默认快照（与升级链对空输入的结果一致，由 test 守护） */
export const DEFAULT_STORED: PluginConfigSnapshot = toStored(DEFAULT_CONFIG)

/** 当前版本的快照键（当前为 `version-8`，N 取 `CONFIG_VERSION`），全文件的规范化/迁移/自愈写回共用 */
const CURRENT_KEY = versionKey(CONFIG_VERSION)

/** 收集段内合法版本号（升序）；不按最低支持过滤，低于最低支持的版本交由 pruneOps Phase A 清理 */
function collectVersions(section: VersionedSection | undefined): number[] {
    if (!section) return []
    const versions = new Set<number>()
    for (const key of Object.keys(section)) {
        const version = parseVersion(key)
        if (version !== undefined) versions.add(version)
    }
    return [...versions].sort((a, b) => a - b)
}

/**
 * 两阶段清理旧快照（versions 升序）：低于 MIN_SUPPORTED_VERSION 的不读不处理；
 * 低于当前版本且超出 MAX_OLD_SNAPSHOTS 上限的从最低起淘汰；等于或高于当前版本的始终保留（高版本供回退后无损读取）。
 * 参数默认取当前常量，测试可覆写。
 */
export function pruneOps(
    versions: number[],
    configVersion: number = CONFIG_VERSION,
    minSupported: number = MIN_SUPPORTED_VERSION,
    maxOld: number = MAX_OLD_SNAPSHOTS,
): SettingsPathOp[] {
    const ops: SettingsPathOp[] = []
    for (const version of versions) {
        if (version < minSupported) ops.push({ op: 'unset', path: [versionKey(version)] })
    }
    const olds = versions.filter((version) => version >= minSupported && version < configVersion)
    if (olds.length > maxOld) {
        for (const version of olds.slice(0, olds.length - maxOld)) {
            ops.push({ op: 'unset', path: [versionKey(version)] })
        }
    }
    return ops
}

/**
 * 当前版本快照的规范化 op：以「当前生效值」物化规范完整快照（`resolveConfig` → `toStored`），
 * 与盘上当前版本键逐键比较；不一致才产出 set op，幂等。仅 migrateConfig 的「当前版本已存在」分支调用。
 * 覆盖三类重写动因：**非法**（`parseSnapshot` 判 undefined）、**残缺**（缺失字段补默认会把只有 `efforts` 的段判为合法，须按规范化结果比对）、**多余键**（物化只保留已知键）。
 */
export function canonicalizeCurrentOp(section: VersionedSection | undefined): SettingsPathOp[] {
    if (!section) return []
    if (!(CURRENT_KEY in section)) return [] // 当前版本键不存在，交给迁移分支
    const onDisk = section[CURRENT_KEY]
    const canonical = toStored(resolveConfig(section))
    return deepEqualJson(onDisk, canonical) ? [] : [{ op: 'set', path: [CURRENT_KEY], value: canonical }]
}

/** NS 登记晚于 apply（宿主 Loader 异步）：迁移前先有界轮询等 `describe()` 含本 NS（dsh-settings 无注册事件 / ready promise） */
const MIGRATE_POLL_MS = 50
const MIGRATE_WAIT_MS = 2000
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 启动时配置迁移：
 * - 有当前版本快照 → 规范化校验（不一致即重写自愈），并两阶段清理旧快照
 * - 无当前版本 → 取段内 ≥ 最低支持版本中最高可解析快照：高版本降级解析、低版本走升级链；均不可解析视为全新用户，写默认快照
 * - 写回带 `SETTINGS_CONFLICT` 限次重试，且**重读描述并重算 op**、绝不回放（见 docs/decisions.md「写回端点」）
 */
export async function migrateConfig(ctx: Context): Promise<void> {
    // 轮询等待 describe() 含本 NS；超时/卸载即放弃，按当前生效配置继续
    let descriptor = descriptorOf(ctx, PLUGIN_NS)
    let waited = 0
    while (!descriptor) {
        if (!ctx.fiber.store) return
        if (waited >= MIGRATE_WAIT_MS) {
            ctx.logger.warn(`${PLUGIN_NAME}: 等待 ${PLUGIN_NS} 命名空间注册超时（${MIGRATE_WAIT_MS}ms），跳过本次迁移/写回/清理`)
            return
        }
        await sleep(MIGRATE_POLL_MS)
        waited += MIGRATE_POLL_MS
        descriptor = descriptorOf(ctx, PLUGIN_NS)
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (!ctx.fiber.store) return
        // 首轮用轮询所得描述（此刻必已注册）；冲突重试时重读，取最新 revision 与段值
        const fence = attempt === 1 ? descriptor : descriptorOf(ctx, PLUGIN_NS)
        if (!fence) return
        const section = sectionOf(fence)
        const versions = collectVersions(section)
        let action: string | undefined
        let ops: SettingsPathOp[]
        if (versions.includes(CONFIG_VERSION)) {
            ops = [...canonicalizeCurrentOp(section)]
            if (ops.length > 0) {
                // 区分两类重写动因，便于排查：非法（parseSnapshot 判 undefined，如用户手改坏）vs 非规范（合法但字段残缺或含多余键）
                const onDisk = section?.[CURRENT_KEY]
                ctx.logger.warn(!parseSnapshot(onDisk)
                    ? `${PLUGIN_NAME}: ${CURRENT_KEY} 快照非法，已按当前生效配置重写`
                    : `${PLUGIN_NAME}: ${CURRENT_KEY} 快照非规范（字段残缺或含多余键），已规范化重写`)
            }
            ops.push(...pruneOps(versions))
        } else {
            // 迁移源：versions 升序，从高到低取首个可解析快照——高版本降级解析、低版本走升级链，全不可解析则落默认
            const candidates = versions.filter((v) => v >= MIN_SUPPORTED_VERSION)
            let stored: PluginConfigSnapshot = DEFAULT_STORED
            action = '写入默认配置'
            let resolved = false
            for (const v of candidates.toReversed()) {
                const entry = section?.[versionKey(v)]
                const parsed = parseSnapshot(entry)
                if (!parsed) continue
                stored = v > CONFIG_VERSION ? toStored(parsed) : upgradeConfig(entry, v)
                action = v > CONFIG_VERSION ? `从段内 ${versionKey(v)} 快照降级解析` : `从段内 ${versionKey(v)} 快照升级`
                resolved = true
                break
            }
            if (!resolved && versions.some((v) => v > CONFIG_VERSION)) {
                ctx.logger.warn(`${PLUGIN_NAME}: 检测到更高版本的配置快照但解析失败，已写入默认配置`)
            }
            ops = [
                { op: 'set', path: [CURRENT_KEY], value: stored },
                ...pruneOps(versions),
            ]
        }
        if (ops.length === 0) return
        try {
            await queueTask(() => ctx.settings.mutate(PLUGIN_NS, ops, fence.revision))
        } catch (error) {
            if (isSettingsConflict(error) && attempt < MAX_ATTEMPTS) continue
            throw error
        }
        if (action !== undefined) ctx.logger.info(`${PLUGIN_NAME}: ${action}，已写入 ${CURRENT_KEY} 快照`)
        return
    }
    // 不可达：循环内各路径均 return/throw，continue 仅在 attempt < MAX_ATTEMPTS 时发生；仅作类型收敛
}

/**
 * 从当前版本快照算出去重写回 op：仅当 `excludes` 存在重复项（保留首次出现）才产出；
 * 无重复返回 []（一个字节都不写——这是 onChange 自愈的终止条件，防反馈循环）；元素含非字符串即整段非法，同样返回 []。
 */
export function dedupeExcludesOp(snapshot: unknown): SettingsPathOp[] {
    if (!isPlainObject(snapshot)) return []
    const excludes = snapshot.excludes
    // parseSnapshot 口径：元素含非字符串即整段非法，不产出 op——处置权在 canonicalizeCurrentOp 的规范化重写与读取回退
    if (!Array.isArray(excludes) || excludes.some((e) => typeof e !== 'string')) return []
    const seen = new Set(excludes)
    if (seen.size === excludes.length) return []
    return [{ op: 'set', path: [CURRENT_KEY, 'excludes'], value: [...seen] }]
}

/** 自有配置的通用自愈入口（onChange 调用）：读 user 层当前版本快照，有 op 才写入。当前唯一规则：excludes 去重 */
export async function selfHealConfig(ctx: Context): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (!ctx.fiber.store) return
        const descriptor = descriptorOf(ctx, PLUGIN_NS)
        if (!descriptor) return
        const section = sectionOf(descriptor)
        const ops = dedupeExcludesOp(section?.[versionKey(CONFIG_VERSION)])
        if (ops.length === 0) return
        try {
            await queueTask(() => ctx.settings.mutate(PLUGIN_NS, ops, descriptor.revision))
        } catch (error) {
            if (isSettingsConflict(error) && attempt < MAX_ATTEMPTS) continue
            ctx.logger.warn(`${PLUGIN_NAME}: 排除列表去重写回失败（第 ${attempt}/${MAX_ATTEMPTS} 次）：${errorText(error)}`)
            throw error
        }
        ctx.logger.warn(`${PLUGIN_NAME}: 检测到排除列表存在重复项，已保留首次出现去重`)
        return
    }
    // 不可达：循环内各路径均 return/throw，continue 仅在 attempt < MAX_ATTEMPTS 时发生；仅作类型收敛
}
