/**
 * 推理档位自调（Node 半）：按 `userExperience.selfTune` 开关向宿主注入两枚工具与一段系统提示词，让 AI 按任务难度自主调节当前会话的推理档位。
 * 设置走 UI 同款入口 `sessionController.selectModel`，查询走 `llm.resolveModelInfo`；档位值一律用 `efforts[].id` 的实际值（理由见 docs/decisions-session.md「档位自调」）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { getConfig } from '@/config'
import { errorText } from '@/shared/errors'
import { PLUGIN_NAME, PLUGIN_NS } from '@/shared/constants'

/** 本模块用到的宿主契约**均按契约复制、不引宿主包类型**（同 `src/subagent.ts` 的裁决，见 docs/host/） */

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

/** 是否一条可用路由：provider / model 都是非空字符串（防御原始 register 无参数校验的边界） */
function isRouted(route: ToolRoute | null | undefined): route is { provider: string; model: string; reasoningEffort?: string } {
    return typeof route?.provider === 'string' && route.provider !== ''
        && typeof route.model === 'string' && route.model !== ''
}

/**
 * 当前会话「下一次请求该用的路由」：投影待生效选择 > `lastUsed` > 请求头 > Agent options。
 * `adapterDefaults.reasoningEffort === true` 是适配器兜底值而非用户所选，档位视作未选；
 * 取不到路由（含读宿主投影/请求头抛错）即 undefined：工具据此回 `no-route`，不让异常冒泡出 `execute`。
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

/** 工具出参的渲染：JSON 文本块 */
function renderJson(_args: unknown, value: unknown): ReadonlyArray<{ type: 'text'; text: string }> {
    return [{ type: 'text', text: JSON.stringify(value) }]
}

/** 系统提示词段：与两枚工具同装同卸 */
const EFFORT_PROMPT = `You have two tools for reasoning effort tuning:
- query_reasoning_efforts(): returns the current effort and the efforts available for the current model
- set_reasoning_effort({effort}): switches the current session's model to the given effort

Usage:
1. Call query_reasoning_efforts before any switch, so you know where you are and what is available.
2. Switch only by task difficulty: lower for mechanical execution, higher for deep exploration, design or complex reasoning.
3. Otherwise stay put; do not switch on every request.
4. If a switch fails, re-query and try once more; if it still fails, keep the current effort.`

/**
 * 装上「档位自调」：四个宿主服务**全部就绪**才注入（任一缺席子 fiber PENDING，静默）；
 * 按当前配置即刻装/卸，随后跟随自有段变更热更。
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
            if (promptDisposer) return
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
            // args 未校验（宿主原始 register 不做参数校验）：非字符串 effort 回业务失败而非抛错
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
                // 宿主错误文案原样透传，不分类不改写
                return { ok: false, provider: route.provider, model: route.model, effort, error: errorText(error) }
            }
        },
    }
}
