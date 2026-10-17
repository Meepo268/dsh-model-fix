/**
 * 推理档位自调（Node 半）：按 `userExperience.selfTune` 开关向宿主注入两枚工具与一段系统提示词，
 * 让 AI 按任务难度自主调节当前会话的推理档位。
 *
 * 设置走 UI 同款入口 `sessionController.selectModel`（与用户手动在模型选择器里选档完全同一条链路，
 * 宿主会做适配器元数据校验并落 `model/selection` 事件），不是改请求参数。查询走 `llm.resolveModelInfo`，
 * 全量提供方里的当前模型都能查（不限于本插件填充的 llm-pi-ai 模型）。档位值一律用 `efforts[].id` 的实际值。
 *
 * 插件零状态：档位状态全在宿主，开关切换只是装/卸注入面，HMR 无损。工具失败原样透传宿主文案，
 * 不分类不改写；「先查后设」与失败处理都靠提示词软指引而非硬校验。理由见 docs/decisions.md「档位自调」。
 */

import type { Context } from '@deepseek-ai/cordis'
import { getConfig } from '@/config'
import { errorText } from '@/shared/errors'
import { PLUGIN_NAME, PLUGIN_NS } from '@/shared/constants'

/**
 * 本模块用到的宿主契约——工具注册服务、系统提示词服务、会话控制器与投影服务的只读面，
 * **均按契约复制，不引宿主包类型**。
 *
 * 原因：`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-system-prompt` 不在 devDep 清单里，且
 * `dsh-tools` 的类型面会把 `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session` 的**包根**类型拉进
 * 整个 typecheck 程序，顶掉浏览器半 `ctx.sessions` 的 `ISessions` 增补（同 `src/subagent.ts` 的裁决，
 * 详见 [`docs/host-api.md`](docs/host-api.md)）。升级宿主时按该文档的对应条目复核。
 */

/** 宿主 `Agent` 的只读面（工具执行上下文里的调用方；同 `src/subagent.ts` 的 `SubagentHost` 裁决） */
interface ToolAgent {
    /** 会话 id（`selectModel` 的 `sessionId` 入参） */
    readonly id: string
    readonly session: {
        requestHeader(): { readonly config: ToolRoute; readonly adapterDefaults?: { readonly reasoningEffort?: unknown } } | undefined
    }
    /** 宿主 `AgentOptions` 的路由三项（尚无任何请求时的最后回落） */
    readonly options: { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string }
}

/** 一次路由（provider + model + 可选档位）；投影、请求头、工具出参与入参共用这一形态 */
interface ToolRoute {
    readonly provider?: string
    readonly model?: string
    readonly reasoningEffort?: string
}

/** 宿主 `ToolRuntime.register` 的契约复制（只声明实际用到的成员） */
interface HostToolsService {
    register(definition: {
        readonly name: string
        readonly description: string
        readonly parameters: Record<string, unknown>
        readonly output: {
            readonly schema: Record<string, unknown>
            readonly render: (args: unknown, value: unknown) => ReadonlyArray<{ type: 'text'; text: string }>
        }
        execute(args: unknown, exec: { readonly signal: AbortSignal; readonly agent?: ToolAgent }): Promise<unknown>
    }): () => void
}

/** 宿主 `SystemPrompt.section` 的契约复制（静态文本段） */
interface HostSystemPromptService {
    section(section: { readonly name: string; readonly order: number; readonly text: string }): () => void
}

/** 宿主 `SessionProjections` 的只读面（`modelSelection` 投影：`pending`/`lastUsed` 均可空） */
interface HostSessionProjections {
    stateOf(session: object, key: 'modelSelection'): { readonly pending: ToolRoute | null; readonly lastUsed: ToolRoute | null } | undefined
}

/** 宿主会话控制器的只读面（只用到 `selectModel`；失败抛 RemoteError，本模块不引其类型） */
interface HostSessionController {
    selectModel(request: {
        sessionId: string
        provider: string
        model: string
        reasoningEffort?: string
    }): Promise<{ selected: { provider: string; model: string; reasoningEffort?: string } }>
}

/** 当前生效路由：provider / model 必有，档位缺项表示当前未选（跟随模型默认） */
interface ResolvedRoute {
    provider: string
    model: string
    currentEffort?: string
}

/** 路由有效性：provider/model 都是非空字符串才算一条可用路由（宿主投影与请求头都按此校验过，此处防御原始 register 无参数校验的边界） */
function isRouted(route: ToolRoute | null | undefined): route is { provider: string; model: string; reasoningEffort?: string } {
    return typeof route?.provider === 'string' && route.provider !== ''
        && typeof route.model === 'string' && route.model !== ''
}

/**
 * 当前会话「下一次请求该用的路由」：投影的待生效选择优先（UI 换档后即刻可读，不必等请求消费），
 * 其次 `lastUsed`，再回落请求头（`adapterDefaults.reasoningEffort === true` 是适配器兜底值而非用户所选，
 * 档位视作未选），最后回落 Agent 自身 options。
 *
 * 取不到路由即 undefined，含读宿主投影/请求头抛错——两枚工具据此回 `no-route`，不让异常冒泡出 `execute`。
 */
function resolveCurrentRoute(agent: ToolAgent, projections: HostSessionProjections | undefined): ResolvedRoute | undefined {
    try {
        const state = projections?.stateOf(agent.session, 'modelSelection')
        const projected = state?.pending ?? state?.lastUsed
        if (isRouted(projected)) {
            return {
                provider: projected.provider,
                model: projected.model,
                ...projected.reasoningEffort === undefined ? {} : { currentEffort: projected.reasoningEffort },
            }
        }
        const header = agent.session.requestHeader()
        const source = header?.config ?? agent.options
        if (!isRouted(source)) return undefined
        const effort = header?.adapterDefaults?.reasoningEffort === true ? undefined : source.reasoningEffort
        return {
            provider: source.provider,
            model: source.model,
            ...effort === undefined ? {} : { currentEffort: effort },
        }
    } catch {
        return undefined
    }
}

/** 工具出参的渲染：JSON 文本块（出参本身就是给 AI 读的结构化结果） */
function renderJson(_args: unknown, value: unknown): ReadonlyArray<{ type: 'text'; text: string }> {
    return [{ type: 'text', text: JSON.stringify(value) }]
}

/** 系统提示词段：与两枚工具同装同卸；只保留必要语义（升/降 + 先查后设 + 失败处理） */
const EFFORT_PROMPT = `You have two tools for reasoning effort tuning:
- query_reasoning_efforts(): returns the current effort and the efforts available for the current model
- set_reasoning_effort({effort}): switches the current session's model to the given effort

Usage:
1. Call query_reasoning_efforts before any switch, so you know where you are and what is available.
2. Switch only by task difficulty: lower for mechanical execution, higher for deep exploration, design or complex reasoning.
3. Otherwise stay put; do not switch on every request.
4. If a switch fails, re-query and try once more; if it still fails, keep the current effort.`

/**
 * 装上「档位自调」：四个宿主服务经 `ctx.inject` 子 fiber 声明——四者**全部就绪**才执行回调，
 * 任一缺席时子 fiber PENDING（静默，不拖累插件其余功能）。激活后按当前配置即刻装/卸，随后跟随自有段变更热更。
 *
 * 工具与提示词的 disposer 挂在宿主服务自己的 ctx 上，子 fiber 卸载**不会**自动清理，必须经 `ctx.effect` 手动调。
 */
export function installSelfTune(ctx: Context): void {
    ctx.inject(['tools', 'systemPrompt', 'sessionController', 'sessionProjections'], (child) => {
        const tools = (child.get as (name: string) => HostToolsService)('tools')
        const systemPrompt = (child.get as (name: string) => HostSystemPromptService)('systemPrompt')
        const sessionController = (child.get as (name: string) => HostSessionController)('sessionController')
        const projections = (child.get as (name: string) => HostSessionProjections)('sessionProjections')
        const toolDisposers: (() => void)[] = []
        let promptDisposer: (() => void) | null = null

        /** 卸载已注入的工具与提示词（重复调用安全：disposer 幂等） */
        function unload(): void {
            for (const dispose of toolDisposers.splice(0)) dispose()
            promptDisposer?.()
            promptDisposer = null
        }

        /** 装载注入面（已加载则幂等跳过）；注册中途抛错（如同名工具冲突）时回滚已注册部分 */
        function load(): void {
            if (promptDisposer) return // 已加载
            try {
                toolDisposers.push(tools.register(queryTool(ctx, projections)))
                toolDisposers.push(tools.register(setTool(sessionController, projections)))
                promptDisposer = systemPrompt.section({ name: 'model-fix:effort-tuning', order: 3200, text: EFFORT_PROMPT })
            } catch (error) {
                unload()
                ctx.logger.warn(`${PLUGIN_NAME}: 档位自调注入失败，功能未启用：${errorText(error)}`)
            }
        }

        if (getConfig().userExperience.selfTune) load()
        child.on('settings/document-updated', (ns: string) => {
            if (ns === PLUGIN_NS) {
                if (getConfig().userExperience.selfTune) load()
                else unload()
            }
        })
        child.effect(() => () => unload())
    })
}

/** 查询工具：当前模型可用推理级别（id 实际值）与当前生效档位 */
function queryTool(ctx: Context, projections: HostSessionProjections): Parameters<HostToolsService['register']>[0] {
    return {
        name: 'query_reasoning_efforts',
        description: 'Query the current model and its available reasoning effort levels, and the effort in effect. Call this before every set_reasoning_effort.',
        parameters: { type: 'object', properties: {} },
        output: {
            schema: { type: 'object' },
            render: renderJson,
        },
        async execute(_args, exec) {
            const route = exec.agent === undefined ? undefined : resolveCurrentRoute(exec.agent, projections)
            if (route === undefined) return { ok: false, error: 'no-route' }
            try {
                const info = await ctx.llm.resolveModelInfo(route.provider, route.model, exec.signal)
                const reasoning = info.reasoning
                return {
                    ok: true,
                    provider: route.provider,
                    model: route.model,
                    ...route.currentEffort === undefined ? {} : { currentEffort: route.currentEffort },
                    efforts: (reasoning?.efforts ?? []).map((effort) => effort.id),
                }
            } catch {
                return { ok: false, error: 'resolve-failed' }
            }
        },
    }
}

/** 设置工具：经 `sessionController.selectModel` 安装待生效选择（UI 同款入口），结果回传路由与新档位 */
function setTool(sessionController: HostSessionController, projections: HostSessionProjections): Parameters<HostToolsService['register']>[0] {
    return {
        name: 'set_reasoning_effort',
        description: 'Set the reasoning effort for the current session\'s model. Pass an effort id from query_reasoning_efforts.',
        parameters: {
            type: 'object',
            properties: { effort: { type: 'string', description: 'Reasoning effort id, exactly as returned in query_reasoning_efforts efforts' } },
            required: ['effort'],
        },
        output: {
            schema: { type: 'object' },
            render: renderJson,
        },
        async execute(args, exec) {
            // 原始 register 不做参数校验，args 是 unknown：非字符串 effort 回业务失败而非抛错
            const requested = (args as { effort?: unknown } | null | undefined)?.effort
            const effort = typeof requested === 'string' && requested !== '' ? requested : undefined
            if (effort === undefined) return { ok: false, effort: String(requested ?? ''), error: 'invalid-effort' }
            const agent = exec.agent
            const route = agent === undefined ? undefined : resolveCurrentRoute(agent, projections)
            if (agent === undefined || route === undefined) return { ok: false, effort, error: 'no-route' }
            try {
                const { selected } = await sessionController.selectModel({
                    sessionId: agent.id,
                    provider: route.provider,
                    model: route.model,
                    reasoningEffort: effort,
                })
                return {
                    ok: true,
                    provider: selected.provider,
                    model: selected.model,
                    ...selected.reasoningEffort === undefined ? {} : { effort: selected.reasoningEffort },
                }
            } catch (error) {
                // RemoteError（session/model-unavailable、subagent ownership 等）原样透传文案，不分类不改写
                return { ok: false, provider: route.provider, model: route.model, effort, error: errorText(error) }
            }
        },
    }
}
