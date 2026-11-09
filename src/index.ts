import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readCache, setCatalog } from '@/catalog'
import { PLUGIN_NS, API_NS, PLUGIN_NAME } from '@/shared/constants'
import { errorText } from '@/shared/errors'
import { resolveConfig, setConfigSource } from '@/config'
import { setHmrExecuting } from '@/host'
import { migrateConfig, selfHealConfig } from '@/migrate'
import { cancelRefreshRetry, refreshIfStale } from '@/refresh'
import { installRpc } from '@/rpc'
import { fix } from '@/fix'
import { updateMemory } from '@/memory'
import { alive } from '@/lifecycle'
import { logLine } from '@/log'
import { isIgnoreAll } from '@/guard'
import { captureBackup } from '@/restore'
import { restoreProbeBackup } from '@/probe-backup'
import { installSubagentFollowParent } from '@/subagent'
import { installSelfTune } from '@/self-tune'
import { installOfficialFilter } from '@/official-filter'
import { installEffortNameLocale } from '@/effort-name'

export const name = PLUGIN_NAME
export const inject = ['settings', 'llm', 'credentials']

/** 宿主 Config schema 面：宽松任意值 + 根 `.volatile()`（宿主据此把整段作实时引用注入 apply 第二参） */
export const Config = z.any().volatile()

/** 吞掉 fix 写回失败的 rejection（失败日志已在 fix 内告警） */
const swallowFixError = (): void => {}

/** 吞掉记忆清理逃逸的 rejection（内部已逐条告警） */
const swallowMemoryError = (): void => {}

/** 触发一次记忆失效清理（与填充解耦，独立于 fix 调用） */
function pruneMemory(ctx: Context): void {
    void updateMemory(ctx).catch(swallowMemoryError)
}

/** 自有段变更：自愈 → 填充 → 记忆清理；守卫开启（插件写回期间）整链短路 */
function refillAfterOwnChange(ctx: Context): void {
    if (isIgnoreAll()) return
    void selfHealConfig(ctx)
        .catch((error: unknown) => {
            ctx.logger.warn(`${PLUGIN_NAME}: 排除列表自愈失败（不影响后续填充）：${errorText(error)}`)
        })
        .then(() => fix(ctx))
        .then(() => pruneMemory(ctx))
        .catch(swallowFixError)
}

/** llm-pi-ai 段变更：填充 → 保鲜窗口过期时拉取 → 再剪一次记忆；守卫同上 */
function refillAfterApiChange(ctx: Context): void {
    if (isIgnoreAll()) return
    fix(ctx)
        .finally(() => {
            if (!alive(ctx)) return
            refreshIfStale(ctx)
        })
        .then(() => {
            if (!alive(ctx)) return
            pruneMemory(ctx)
        })
        .catch(swallowFixError)
}

/** 探测档位的崩溃兜底：回退上一轮崩在「预声明」与「收敛」之间留下的备份，再补一轮 fill；无备份返回 0 */
async function recoverProbeBackup(ctx: Context): Promise<void> {
    try {
        const changed = await restoreProbeBackup(ctx)
        if (changed > 0 && alive(ctx)) await fix(ctx)
    } catch (error) {
        ctx.logger.warn(`${PLUGIN_NAME}: 探测档位的兜底回退失败（配置可能停在半截形态）：${errorText(error)}`)
    }
}

/** 解引用 volatile 包装：config 为引用时每次 .get() 取最新值 */
function readVolatile(config: unknown): unknown {
    const value = config as { get?: () => unknown }
    return typeof value?.get === 'function' ? value.get() : config
}

/** 首轮启动链：迁移（必须最先，旧格式快照会被按当前 schema 误解析）→ 读缓存 → 填充 → 探测兜底回退 → 异步刷新。
 * 每一跳都写一条文件日志（`logLine`）：这条链任何一处静默退出，现象都是「插件活着但什么都没做」，
 * 而没有日志时连它停在哪一跳都无从判断——0.38.5 之前正是如此 */
function runStartupChain(ctx: Context): void {
    const startedAt = Date.now()
    const since = (): number => Date.now() - startedAt
    logLine(`${PLUGIN_NAME}: 启动链开始`)
    void migrateConfig(ctx)
        .catch((error: unknown) => {
            logLine(`${PLUGIN_NAME}: 配置迁移失败（继续执行）：${errorText(error)}`)
            if (!alive(ctx)) return
            ctx.logger.warn(`${PLUGIN_NAME}: 配置迁移失败，使用当前生效配置继续：${errorText(error)}`)
        })
        .then(() => {
            logLine(`${PLUGIN_NAME}: 迁移结束（${since()}ms）`)
            if (!alive(ctx)) return
            return readCache((message) => ctx.logger.warn(message))
        })
        .then((cached) => {
            if (!alive(ctx)) return
            logLine(cached === undefined
                ? `${PLUGIN_NAME}: 读缓存无结果（${since()}ms）`
                : `${PLUGIN_NAME}: 读缓存成功（${cached.groups.size} 家提供方，${since()}ms）`)
            if (cached) setCatalog(cached, 'cache')
            fix(ctx)
                .then((changed) => {
                    logLine(`${PLUGIN_NAME}: 启动填充结束，覆盖 ${changed} 个模型（${since()}ms）`)
                })
                .then(() => recoverProbeBackup(ctx))
                .finally(() => {
                    if (!alive(ctx)) return
                    refreshIfStale(ctx)
                })
                .then(() => {
                    if (alive(ctx)) pruneMemory(ctx)
                })
                .catch((error: unknown) => {
                    logLine(`${PLUGIN_NAME}: 启动填充失败：${errorText(error)}`)
                    if (!alive(ctx)) return
                    ctx.logger.warn(`${PLUGIN_NAME}: 填充失败：${errorText(error)}`)
                })
        })
}

/** 入口：单一编排体（备份 → 配置源与段变更接线 → RPC → 启动链） */
export function apply(ctx: Context, config?: unknown): void {
    // hmr 事务感知：子 fiber 注入 hmr 执行上下文
    ctx.inject(['hmr'], (child) => {
        setHmrExecuting((child.get('hmr') as { executing?: unknown } | undefined)?.executing)
    })
    // 备份仅此一次且必须早于一切写回（接线即起异步 fix）
    captureBackup(ctx)
    // 配置源取 apply 第二参的实时引用（.get() 须在工厂内每次读）；段变更按 ns 分流
    setConfigSource(() => resolveConfig(readVolatile(config)))
    ctx.on('settings/document-updated', (ns) => {
        if (ns === PLUGIN_NS) refillAfterOwnChange(ctx)
        else if (ns === API_NS) refillAfterApiChange(ctx)
    })
    // provider 拓扑变化（宿主 commit 后发出）：记忆清理跟着它走
    ctx.on('llm/adapters-updated', () => pruneMemory(ctx))
    installSubagentFollowParent(ctx) // 「跟随父智能体」：agent/request 瀑布最外层，每请求现算
    installSelfTune(ctx) // 「自主调节档位」：按 userExperience.selfTune 装/卸工具与提示词段
    installOfficialFilter(ctx) // 「隐藏官方API」：判定实时现算，无事件接线
    installEffortNameLocale(ctx) // 「本地化推理级别」：判定实时现算，无事件接线
    installRpc(ctx) // 浏览器半三个写回端点的 RPC channel
    ctx.effect(() => {
        logLine(`${PLUGIN_NAME}: 插件装载完成，启动链入队`)
        runStartupChain(ctx)
        return () => cancelRefreshRetry() // 卸载后取消待触发的拉取重试
    })
}
