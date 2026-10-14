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
import { isIgnoreAll } from '@/guard'
import { captureBackup } from '@/restore'
import { restoreProbeBackup } from '@/probe-backup'
import { installSubagentFollowParent } from '@/subagent'
import { installSelfTune } from '@/self-tune'
import { installOfficialFilter } from '@/official-filter'
import { installEffortNameLocale } from '@/effort-name'

export const name = PLUGIN_NAME
export const inject = ['settings', 'llm', 'credentials']

/**
 * 宿主 Config schema 面：宽松任意值（「比当前代码更新的版本快照」也能通过注册校验）+
 * 根 `.volatile()`（纯 schema 元数据）——后者使宿主把整段作为实时引用注入 apply 第二参（每次 `.get()` 取当前值）。
 */
export const Config = z.any().volatile()

/** 吞掉 fix 写回失败的 rejection（失败日志已在 fix 内告警，避免未处理拒绝） */
const swallowFixError = (): void => {}

/** 记忆剪枝的兜底吞错（`updateMemory` 内部已逐条告警，这里只防意外逃逸的 rejection） */
const swallowMemoryError = (): void => {}

/** 触发一次记忆失效清理：与填充解耦，故独立于 fix 调用 */
function pruneMemory(ctx: Context): void {
    void updateMemory(ctx).catch(swallowMemoryError)
}

/** 自有段变更：先自愈（排除列表去重，有重复才写，自愈写回再触发一轮零写入而收敛）再重新填充；
 * 插件写回（重置/恢复/强制更新）期间（守卫开启）整条链短路，防止把刚删的字段重新填回。
 * 用户改「用户体验」组（尤其实验性地开关 forgetRemoved）后在此补一次记忆整理：
 * 开关一旦转开，被删模型留下的记忆当场归零，不必等下一个模型列表变更事件。
 * 剪枝写回本身也走自有段，会再触发一轮——那轮整理已是零变更、不写回，故收敛。 */
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

/** llm-pi-ai 段变更：重新填充；距上次成功拉取超过保鲜窗口（如长期不重启）时再拉取（结算后再填充一次），无常驻定时器；守卫同上。
 * 填充写回会增删模型级条目，故结算后再按全量模型列表剪一次记忆（填充本身不碰记忆）。 */
function refillAfterApiChange(ctx: Context): void {
    if (isIgnoreAll()) return
    fix(ctx)
        .finally(() => {
            if (!ctx.fiber.store) return
            refreshIfStale(ctx)
        })
        .then(() => {
            if (!ctx.fiber.store) return
            pruneMemory(ctx)
        })
        .catch(swallowFixError)
}

/** 探测式填充的崩溃兜底：上一轮若崩在「预声明」与「收敛」之间（进程被杀、断电），
 * 自有段会留下整段兜底备份，配置里留着「声称支持七档」的半截形态。启动链末尾据此回退，
 * 回退后再补一轮 fill——否则被撤掉预声明的模型会停在未填充态，本插件的主功能就失效了。
 * 无备份时 restoreProbeBackup 直接返回 0，不做多余的写入与填充。 */
async function recoverProbeBackup(ctx: Context): Promise<void> {
    try {
        const changed = await restoreProbeBackup(ctx)
        if (changed > 0 && ctx.fiber.store) await fix(ctx)
    } catch (error) {
        ctx.logger.warn(`${PLUGIN_NAME}: 探测式填充的兜底回退失败（配置可能停在半截形态）：${errorText(error)}`)
    }
}

/** 实时取当前段：根 volatile 下 config 为引用包装，.get() 每次返回最新解析值 */
function readVolatile(config: unknown): unknown {
    const value = config as { get?: () => unknown }
    return typeof value?.get === 'function' ? value.get() : config
}

/**
 * 首轮启动链：迁移 → 读缓存 → 填充 → 探测兜底回退 → 异步刷新。
 *
 * 迁移必须最先：否则旧格式的 `version-N` 快照会被填充按当前 schema 误解析。
 * 填充分两步走：先用缓存即刻生效，再异步刷新目录（`refreshIfStale` 的 ts 初始 0 必过期 ⇒ 启动必拉取），
 * 与事件路径同构（fix → refreshIfStale → 拉取结算后再 fix）。每个续体前都判一次 `isDisposed`：
 * 卸载后不读缓存、不触碰已销毁上下文。
 */
function runStartupChain(ctx: Context): void {
    void migrateConfig(ctx)
        .catch((error: unknown) => {
            if (!ctx.fiber.store) return
            ctx.logger.warn(`${PLUGIN_NAME}: 配置迁移失败，使用当前生效配置继续：${errorText(error)}`)
        })
        .then(() => {
            if (!ctx.fiber.store) return
            return readCache()
        })
        .then((cached) => {
            if (!ctx.fiber.store) return
            if (cached) setCatalog(cached)
            fix(ctx)
                .then(() => recoverProbeBackup(ctx))
                .finally(() => {
                    if (!ctx.fiber.store) return
                    refreshIfStale(ctx)
                })
                .then(() => {
                    if (ctx.fiber.store) pruneMemory(ctx)
                })
                .catch((error: unknown) => {
                    if (!ctx.fiber.store) return
                    ctx.logger.warn(`${PLUGIN_NAME}: 填充失败：${errorText(error)}`)
                })
        })
}

/** 入口：单一编排体（备份 → 配置源与段变更接线 → RPC → 启动链） */
export function apply(ctx: Context, config?: unknown): void {
    // hmr 事务感知：子 fiber 注入 hmr 执行上下文（缺席时降级为裸 task()，不影响任何功能）
    ctx.inject(['hmr'], (child) => {
        setHmrExecuting((child.get('hmr') as { executing?: unknown } | undefined)?.executing)
    })
    // 备份仅此一次，且必须早于一切写回（接线即起异步 fix）——晚了备份的就是被填充过的内容；
    // 此刻注册与文档装载都先于 apply，describe() 已含 API_NS，必可读
    captureBackup(ctx)
    // 配置源取 apply 第二参的实时引用——.get() 必须在工厂内、不得在 apply 时刻取走，
    // 否则卡片保存后的新值读不进来；段变更走 settings/document-updated（0.1.7 唯一段级事件），按 ns 分流
    setConfigSource(() => resolveConfig(readVolatile(config)))
    ctx.on('settings/document-updated', (ns) => {
        if (ns === PLUGIN_NS) refillAfterOwnChange(ctx)
        else if (ns === API_NS) refillAfterApiChange(ctx)
    })
    // provider 拓扑变化（adapter 注册/注销/替换、configurable-provider 目录增减）——宿主在 commit
    // 之后统一发出，故此处读到的活路由已是最新；记忆失效清理跟着它走，与会话无关故不进子 fiber
    ctx.on('llm/adapters-updated', () => pruneMemory(ctx))
    // 「跟随父智能体」（agent/request 瀑布最外层；每请求现算，只读 userExperience.followParent）
    installSubagentFollowParent(ctx)
    // 「让 AI 自主调节档位」（按 userExperience.selfTune 装/卸两枚工具与提示词段；设置热更跟随下方事件）
    installSelfTune(ctx)
    // 「隐藏官方API」（按 userExperience.hideOfficial 在模型目录生成处过滤未配密钥的官方提供方；判定实时现算，无事件接线）
    installOfficialFilter(ctx)
    // 「本地化推理级别」（按开关 + 界面语言在 resolveModelInfo 处换档位显示名；判定实时现算，无事件接线）
    installEffortNameLocale(ctx)
    // 浏览器半「强制更新 / 重置推理级别 / 恢复备份」RPC channel（结果经 ConnectionRpcResult 回传卡片）
    installRpc(ctx)
    ctx.effect(() => {
        runStartupChain(ctx)
        return () => {
            // 取消待触发的拉取重试定时器（闭包持有 ctx，卸载后不应再触发）
            cancelRefreshRetry()
        }
    })
}
