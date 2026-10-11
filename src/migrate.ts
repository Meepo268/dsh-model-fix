import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { MAX_ATTEMPTS, MAX_OLD_SNAPSHOTS, MIN_SUPPORTED_VERSION } from '@/constants'
import { CONFIG_VERSION, PLUGIN_NAME, PLUGIN_NS } from '@/shared/constants'
import { resolveConfig } from '@/config'
import { queueTask } from '@/host'
import { DEFAULT_CONFIG, parseSnapshot, parseVersion, toStored, versionKey } from '@/shared/parse'
import type { PluginConfigSnapshot, VersionedSection } from '@/shared/types'
import { isPlainObject } from '@/shared/types'
import { descriptorOf, sectionOf } from '@/section'
import { upgradeConfig } from '@/upgrade'
import { isSettingsConflict } from '@/writeback'

/**
 * 自有配置段（`version-N` 快照映射）的当前版本侧：启动迁移、旧快照清理与 onChange 自愈。
 *
 * 与升级链的两条分工——本文件只处理**当前版本**与**段内多版本共存**，
 * 「把某个旧版本升上来」交给 `src/upgrade.ts` 的冻结台阶链（这里只在选迁移源时调它）；
 * 本文件与升级链共用的落盘口都在当前版本键 `CURRENT_KEY` 上，物化函数单一来源在 `src/shared/parse.ts` 的 `toStored`。
 */

/** 全新用户的规范默认快照（与升级链对空输入的结果一致，由 test 守护）；物化函数单一来源在 src/shared/parse.ts 的 `toStored` */
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
 * 两阶段清理旧快照（versions 升序）：
 * - Phase A：清理低于 MIN_SUPPORTED_VERSION 的快照（已失效，不读取不处理）
 * - Phase B：清理低于当前版本且超出 MAX_OLD_SNAPSHOTS 上限的 excess（从最低版本起淘汰）
 * 等于或高于当前版本的快照始终保留（当前在使用，高版本供回退后无损读取）。
 * configVersion/minSupported/maxOld 默认取当前常量，测试可覆写以覆盖更高版本台阶。
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
 * 与盘上当前版本键逐键比较；不一致才产出 set op，幂等——第二轮同值零写入即收敛。
 * 仅在 migrateConfig 的「当前版本已存在」分支调用（当前版本键缺失时由迁移分支直接写规范快照）。
 *
 * 覆盖三类重写动因：
 * - 非法：`parseSnapshot(onDisk)` 判 undefined（如用户手改坏、或快照为非对象）——`resolveConfig` 回落到段内最高可解析快照或默认；
 * - 残缺：`parseSnapshot` 对缺失字段一律补默认，会把只有 `efforts` 的 `{efforts:{…}}` 判为合法完整配置，
 *   单纯「非法才自愈」不足以保证盘上是规范完整快照；此处按规范化结果比对，残缺即重写（保留 efforts/excludes 现值，补齐四组默认与 configVersion）；
 * - 多余键：当前版本键含当前 schema 未知的键时，`toStored` 物化只保留已知键，比对不一致即剥离重写。
 */
export function canonicalizeCurrentOp(section: VersionedSection | undefined): SettingsPathOp[] {
    if (!section) return []
    if (!(CURRENT_KEY in section)) return [] // 当前版本键不存在 → 交给迁移分支，不在此产出
    const onDisk = section[CURRENT_KEY]
    const canonical = toStored(resolveConfig(section))
    return deepEqualJson(onDisk, canonical) ? [] : [{ op: 'set', path: [CURRENT_KEY], value: canonical }]
}

/**
 * 0.1.7 现代栈下本插件 Config schema 命名空间由宿主 Loader 异步登记，晚于 apply——启动时 describe() 可能尚未含本 NS。
 * 有界轮询等待其出现后再迁移（dsh-settings 无"命名空间注册"事件或 ready promise，settings/document-updated 只在 RAW 段变更时发、且 provider 首次 publish 早于本插件 apply 故监听器错过）。
 */
const MIGRATE_POLL_MS = 50
const MIGRATE_WAIT_MS = 2000
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 启动时配置迁移：
 * - 有当前版本快照 → 规范化校验：以当前生效值物化规范完整快照，与盘上当前版本键逐键比较；不一致（非法 / 字段残缺 / 含多余键）即重写自愈
 *   （幂等——第二轮同值零写入即收敛），两阶段清理低版本旧快照：先清低于最低支持版本，再清低于当前版本且超出上限的 excess（高版本快照保留）
 * - 无当前版本 → 段内所有 ≥ 最低支持版本中取最高可解析快照：高版本降级解析（按当前 schema，多余键忽略、efforts 宽松保留）、
 *   低版本走升级链；均不可解析或段内无版本则视为全新用户，直接写入规范默认快照，确保后续读取必有当前版本
 * - 写回带 `SETTINGS_CONFLICT` 限次重试：启动期自有段并非只有迁移链在写（浏览器半一连上记忆监听就可能直写 efforts、
 *   适配器拓扑事件触发的记忆剪枝同样写），冲突即本轮迁移写回丢失（新配置项不落盘，只剩一条难以察觉的 warn）。
 *   重试时**重读描述并重算 op**，绝不回放：按旧段算出的整段 set 若只换新 revision 回放，会盖掉并发写入者刚落的内容；
 *   重读后重算，他方已补齐的字段让 op 自然收敛为零
 */
export async function migrateConfig(ctx: Context, disposed: () => boolean = () => false): Promise<void> {
    // 轮询等待 describe() 含本 NS；超时/卸载即放弃，按当前生效配置继续
    let descriptor = descriptorOf(ctx, PLUGIN_NS)
    let waited = 0
    while (!descriptor) {
        if (disposed()) return
        if (waited >= MIGRATE_WAIT_MS) {
            ctx.logger.warn(`${PLUGIN_NAME}: 等待 ${PLUGIN_NS} 命名空间注册超时（${MIGRATE_WAIT_MS}ms），跳过本次迁移/写回/清理`)
            return
        }
        await sleep(MIGRATE_POLL_MS)
        waited += MIGRATE_POLL_MS
        descriptor = descriptorOf(ctx, PLUGIN_NS)
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
 * 从当前版本快照算出去重写回 op：仅当 `excludes` 经 Set 收窄后**变短**（即存在重复项）才产出，
 * 保留首次出现；无重复返回 []（一个字节都不写，这是 onChange 自愈的终止条件，防反馈循环）。
 * 元素含非字符串即整段非法，同样返回 []——parseSnapshot 口径为整段回退默认，不去洗半合法段。
 * 存储侧不做静默去重是 UI 录入端已拦截重复的前提下的兜底——重复只可能来自手改配置文件。
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

/**
 * 自有配置的通用自愈入口（onChange 调用）：读 user 层当前版本快照，逐条套用自愈规则，
 * 有 op 才写入（各规则的零写入条件即反馈循环的终止条件）。当前唯一规则：excludes 去重（手改兜底）。
 */
export async function selfHealConfig(ctx: Context): Promise<void> {
    const descriptor = descriptorOf(ctx, PLUGIN_NS)
    if (!descriptor) return
    const section = sectionOf(descriptor)
    const ops = dedupeExcludesOp(section?.[versionKey(CONFIG_VERSION)])
    if (ops.length === 0) return
    await queueTask( () => ctx.settings.mutate(PLUGIN_NS, ops, descriptor.revision))
    ctx.logger.warn(`${PLUGIN_NAME}: 检测到排除列表存在重复项，已保留首次出现去重`)
}
