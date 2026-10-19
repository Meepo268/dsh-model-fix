import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig, LlmCallConfigAdapterDefaults, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { getConfig } from '@/config'
import { errorText } from '@/shared/errors'
import { PLUGIN_NAME } from '@/shared/constants'

/** 子智能体推理级别的注入面：在宿主 `agent/request` 瀑布里改写子 Agent 本次请求的调用配置。
 * 子 Agent 无推理级别设置面，委派调用配置流经此瀑布；按 `followParent` 开关在 `next()` 后改写，宿主随后照常校验（不支持档位抛 `UNSUPPORTED_REASONING_EFFORT`，不预检不降级）。
 * 每请求现算不缓存（父档位与子实际模型可能变动）；取父会话「下一次请求该用的路由」：UI 待生效选择优先，其次请求头。裁决见 docs/decisions.md「子智能体」 */

/** 宿主契约（`Agent` 只读面、子智能体选模型设置服务、会话投影服务）——按契约复制，不引宿主包类型。
 * 原因：宿主富面 `Agent` 只在 `@deepseek-ai/dsh-agent` 包根导出（`/types` 只有 `{id}`），「允许选择模型」设置住在 `@deepseek-ai/dsh-tool-subagent/model-selection-settings`；这两个包都会把 `@deepseek-ai/dsh-session` 包根类型拉进程序，顶掉浏览器半 `ctx.sessions` 的增补（`ISessions` → `SessionStore`），`memory-listener.ts` 整片报类型错误。
 * 故只声明实际读取的成员；升级宿主按 `docs/host-api.md` 对应条目复核 */
interface SubagentHost {
    readonly session: {
        readonly header: { readonly origin?: string; readonly parentSession?: SessionId }
        requestHeader(): { readonly config: LlmCallConfig; readonly adapterDefaults?: LlmCallConfigAdapterDefaults } | undefined
    }
    /** 宿主 `AgentOptions` 的路由四项（provider/model 可缺，故逐项判后再用） */
    readonly options: { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: ReasoningEffortId; readonly maxTokens?: number }
}

/** 宿主 `AgentRegistry` 的只读面（按契约复制） */
interface HostAgentRegistry { get(id: SessionId): SubagentHost | undefined }

/** 宿主「允许 Agent 为子智能体选择模型」设置服务的只读面（只用到 `current().enabled`） */
interface HostSelectionService { current(): { enabled: boolean } }

/** 宿主 `ModelSelection` 投影状态的只读面（按契约复制）。`pending` 是 UI 换模型/换档位后、尚未被任何一次请求消费掉的选择；`lastUsed` 是最近一次请求用过的选择 */
interface HostModelSelectionState {
    readonly pending: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | null
}

/** 宿主会话投影服务的只读面（只用到 `stateOf`）。`modelSelection` 投影由会话控制器注册，未注册时该键返回 `undefined` */
interface HostSessionProjections {
    stateOf(session: SubagentHost['session'], key: 'modelSelection'): HostModelSelectionState | undefined
}

/** `agent/request` 瀑布监听签名（与宿主 `AgentEvents` 一致，见 [`docs/host-api.md`](docs/host-api.md)） */
type SubagentRequestListener = (
    payload: { agent: SubagentHost },
    next: () => Promise<LlmCallConfig>,
) => Promise<LlmCallConfig>

/** 装上「跟随父智能体」：单个 `agent/request` 监听覆盖全部 Agent（含 fork/workflow 等 `origin === 'subagent'` 会话），作用域随 ctx 销毁自动卸载。
 * 只服务 `followParent` 一个开关。三个宿主服务经 `ctx.inject` 子 fiber 注入：全就绪才注册，任一缺席 PENDING 静默。
 * 监听用 `prepend` 钉成最外层：监听者由外而内依次执行，最外层 `next()` 拿到的是宿主全部改写完成后的最终配置 */
export function installSubagentFollowParent(ctx: Context): void {
    ctx.inject(['agents', 'sessionProjections', 'subagentModelSelection'], (child) => {
        const agents = child.get('agents') as HostAgentRegistry
        const projections = child.get('sessionProjections') as HostSessionProjections
        const selectionService = child.get('subagentModelSelection') as HostSelectionService
        // 事件名与监听签名随 SubagentHost 一并按契约本地声明（引宿主包根会把 dsh-session 包根类型拉进 typecheck 程序、顶掉浏览器半的 ctx.sessions），故对 child.on 收窄断言；`this` 须是插件 ctx，故走 `.call`
        const on = child.on as unknown as (
            this: Context,
            name: string,
            listener: SubagentRequestListener,
            options?: { prepend?: boolean },
        ) => unknown
        on.call(child, 'agent/request', async (payload, next) => {
            const config = await next()
            try {
                return resolveRequest(agents, projections, selectionService, payload.agent, config)
            } catch (error) {
                // 读宿主设置/父 Agent 失败都不该拖垮子智能体的这一次请求：原样放行，交由宿主自身校验
                ctx.logger.warn(`${PLUGIN_NAME}: 子智能体推理级别未生效：${errorText(error)}`)
                return config
            }
        }, { prepend: true })
    })
}

/** 按配置算出本次请求该用的调用配置；非子智能体 Agent 或开关不适用时原样返回入参 */
function resolveRequest(agents: HostAgentRegistry, projections: HostSessionProjections, selectionService: HostSelectionService, agent: SubagentHost | undefined, config: LlmCallConfig): LlmCallConfig {
    if (agent?.session.header.origin !== 'subagent') return config
    // 宿主开着「允许 Agent 为子智能体选择模型」时，路由由模型自己在授权范围内挑，不该由插件覆盖
    if (hostSelectionEnabled(selectionService)) return config
    if (!getConfig().userExperience.followParent) return config
    const follow = resolveFollow(agents, projections, agent)
    return follow === undefined ? config : applyFollow(config, follow)
}

/** 宿主是否开着「允许 Agent 为子智能体选择模型」——跟着关时跟随才生效。`current()` 因「已开启但授权表为空」抛错时，一律按关闭处理 */
function hostSelectionEnabled(service: HostSelectionService): boolean {
    try {
        return service.current().enabled === true
    } catch {
        return false
    }
}

/** 父 Agent 下一次请求该用的路由：先取父会话「待生效的选择」，没有才取会话日志的请求头，再无则回落 Agent 自身 options。设计裁决（路由回落链、adapterDefaults 标记、maxTokens 合并）见 docs/decisions.md「子智能体」 */
function resolveFollow(agents: HostAgentRegistry, projections: HostSessionProjections, agent: SubagentHost): FollowRoute | undefined {
    const parentId = agent.session.header.parentSession
    if (parentId === undefined) return undefined
    const parent = agents.get(parentId)
    if (!parent) return undefined
    return pendingFollow(projections, parent.session) ?? headerFollow(parent)
}

/** 父会话待生效的选择：UI 的每次切换都落一条 `model/selection` 事件，投影据此置 `pending`，直到匹配的那次请求把它消费掉。该投影未注册时读不到，按「没有待生效选择」处理 */
function pendingFollow(projections: HostSessionProjections, session: SubagentHost['session']): FollowRoute | undefined {
    const pending = projections.stateOf(session, 'modelSelection')?.pending
    if (pending === undefined || pending === null) return undefined
    if (typeof pending.provider !== 'string' || pending.provider === '') return undefined
    if (typeof pending.model !== 'string' || pending.model === '') return undefined
    return {
        provider: pending.provider,
        model: pending.model,
        ...pending.reasoningEffort === undefined ? {} : { reasoningEffort: pending.reasoningEffort as ReasoningEffortId },
    }
}

/** 父会话最近一次请求的配置；无请求头时回落 Agent 自身的 options。取不到即 undefined。 */
function headerFollow(parent: SubagentHost): FollowRoute | undefined {
    const header = parent.session.requestHeader()
    const source = header?.config ?? parent.options
    if (typeof source.provider !== 'string' || source.provider === '') return undefined
    if (typeof source.model !== 'string' || source.model === '') return undefined
    const effort = header?.adapterDefaults?.reasoningEffort === true ? undefined : source.reasoningEffort
    return {
        provider: source.provider,
        model: source.model,
        ...effort === undefined ? {} : { reasoningEffort: effort },
        ...typeof source.maxTokens === 'number' ? { maxTokens: source.maxTokens } : {},
    }
}

/** 跟随父 Agent 时取到的路由四件套（`reasoningEffort` / `maxTokens` 缺项表示父当前没有该值） */
interface FollowRoute {
    provider: string
    model: string
    reasoningEffort?: ReasoningEffortId
    maxTokens?: number
}

/** 继承值更大时只抬升差值的八成：既不被旧的小预算卡死，也不一步顶到新值 */
const BUDGET_SCALE = 0.8

/** 输出预算合并：继承值不大于现值取继承值；更大时只抬升差值八成（旧小预算卡发挥，但直接顶到新值部分端点拒绝）；缺项视作不限，只有一方给出即取那一方，两方都没有不写该键 */
function mergedBudget(current: number | undefined, inherited: number | undefined): number | undefined {
    if (current === undefined) return inherited
    if (inherited === undefined) return current
    if (inherited <= current) return inherited
    return Math.floor(current + (inherited - current) * BUDGET_SCALE)
}

/** 整条覆盖为父的路由：provider / model / 档位照父的来，输出预算按 `mergedBudget` 合并 */
function applyFollow(config: LlmCallConfig, follow: FollowRoute): LlmCallConfig {
    const budget = mergedBudget(config.maxTokens, follow.maxTokens)
    const next = { ...config }
    delete next.reasoningEffort
    delete next.maxTokens
    return {
        ...next,
        provider: follow.provider,
        model: follow.model,
        ...follow.reasoningEffort === undefined ? {} : { reasoningEffort: follow.reasoningEffort },
        ...budget === undefined ? {} : { maxTokens: budget },
    }
}
