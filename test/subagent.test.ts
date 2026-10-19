// subagent.ts 纯逻辑测试：agent/request 注入的跟随父路由（待生效选择优先，请求头回落）、父档位可得不与异常兜底
import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig, LlmCallConfigAdapterDefaults, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { check, stable } from '@test/helper'
import { installSubagentFollowParent } from '@/subagent'
import { setConfigSource } from '@/config'
import { DEFAULT_CONFIG } from '@/shared/config-schema'
import type { PluginConfig, UserExperienceRules } from '@/shared/types'

/** 最小 Agent 桩类型——与 `src/subagent.ts` 里那份契约复制同形。不引宿主 `@deepseek-ai/dsh-agent` 包根类型：它会把 `@deepseek-ai/dsh-session` 包根类型拉进整个 typecheck 程序，顶掉浏览器半 `ctx.sessions` 的 `ISessions` 增补（详见 `docs/host-api.md`） */
interface Agent {
    readonly session: {
        readonly header: { readonly origin?: string; readonly parentSession?: SessionId }
        requestHeader(): { readonly config: LlmCallConfig; readonly adapterDefaults?: LlmCallConfigAdapterDefaults } | undefined
    }
    readonly options: { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: ReasoningEffortId; readonly maxTokens?: number }
}

/** 瀑布监听签名（与宿主 `agent/request` 一致） */
type RequestListener = (payload: { agent: Agent }, next: () => Promise<LlmCallConfig>) => Promise<LlmCallConfig>

/** 最小 Agent 桩：中间件只读 `session.header`（origin / parentSession）、`session.requestHeader()` 与 `options` */
function makeAgent(init: {
    origin?: string
    parentSession?: string
    options?: { provider: string; model: string; reasoningEffort?: string; maxTokens?: number }
    header?: unknown
}): Agent {
    return {
        session: {
            header: { origin: init.origin, parentSession: init.parentSession },
            requestHeader: () => init.header,
        },
        options: init.options ?? { provider: 'p', model: 'm' },
    } as unknown as Agent
}

/** 最小 ctx 桩：支持 `inject` 子 fiber（deps 全就绪才激活回调，缺席则静默不激活） */
function makeCtx(init: {
    selection?: SelectionStub
    parentOf?: (id: string) => Agent | undefined
    projections?: ProjectionStub
    getThrows?: boolean
}) {
    const warns: string[] = []
    let listener: RequestListener | undefined
    let options: unknown
    const get = (name: string) => {
        if (init.getThrows === true) throw new Error('服务不可用')
        if (name === 'subagentModelSelection') return init.selection ?? { current: () => ({ enabled: false }) }
        if (name === 'agents') return { get: (id: string) => init.parentOf?.(id) }
        if (name === 'sessionProjections') return init.projections ?? { stateOf: () => undefined }
        return undefined
    }
    const ctx = {
        on(name: string, fn: RequestListener, opts?: unknown) {
            if (name === 'agent/request') {
                listener = fn
                options = opts
            }
            return () => {}
        },
        inject(deps: readonly string[], callback: (child: Context) => void) {
            try {
                if (deps.every((name) => get(name) !== undefined)) callback(ctx as unknown as Context)
            } catch {
                // deps unavailable, fiber stays PENDING
            }
            return () => {}
        },
        get,
        logger: { info() {}, warn(msg: string) { warns.push(msg) }, error() {} },
    }
    return {
        ctx: ctx as unknown as Context,
        warns,
        /** 取注册到的瀑布监听（未注册即 undefined，注册面本身的断言用） */
        listenerOf: () => listener,
        optionsOf: () => options,
    }
}

/** 宿主「允许 Agent 为子智能体选择模型」服务桩 */
interface SelectionStub {
    current(): { enabled: boolean }
}

/** 宿主 `modelSelection` 投影的待生效选择（用户在 UI 换模型/换档位后、尚未被请求消费的那份） */
interface PendingSelection {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
}

/** 宿主会话投影服务桩（只实现中间件消费的 `stateOf`） */
interface ProjectionStub {
    stateOf(session: Agent['session'], key: 'modelSelection'): { readonly pending: PendingSelection | null } | undefined
}

/** 投影服务桩：`pending` 传 undefined 表示该键未注册投影 */
function projectionsOf(pending: PendingSelection | null | undefined): ProjectionStub {
    return { stateOf: () => (pending === undefined ? undefined : { pending }) }
}

interface RunInit {
    /** 只覆盖「用户体验」组（本测试的判据只有 followParent 一项） */
    config?: Partial<UserExperienceRules>
    agent: Agent
    host?: LlmCallConfig
    selection?: SelectionStub
    parentOf?: (id: string) => Agent | undefined
    projections?: ProjectionStub
    getThrows?: boolean
}

/** 以指定配置装载插件并跑一次请求：返回宿主原始配置经中间件改写后的结果 */
async function runOnce(init: RunInit): Promise<{ result: LlmCallConfig; warns: string[]; listener: RequestListener | undefined; options: unknown }> {
    const config: PluginConfig = {
        ...DEFAULT_CONFIG,
        userExperience: { ...DEFAULT_CONFIG.userExperience, ...init.config },
    }
    setConfigSource(() => config)
    const stub = makeCtx({
        selection: init.selection,
        parentOf: init.parentOf,
        projections: init.projections,
        getThrows: init.getThrows,
    })
    installSubagentFollowParent(stub.ctx)
    const listener = stub.listenerOf()
    const host: LlmCallConfig = init.host ?? { provider: 'pi', model: 'dsr' }
    const result = listener === undefined ? host : await listener({ agent: init.agent }, () => Promise.resolve(host))
    return { result, warns: stub.warns, listener, options: stub.optionsOf() }
}

/** 关着「允许 Agent 为子智能体选择模型」的宿主服务 */
const OFF: SelectionStub = { current: () => ({ enabled: false }) }

export async function run(): Promise<void> {
    // ---------- installSubagentFollowParent：注册面与作用域 ----------
    const subagent = makeAgent({ origin: 'subagent', parentSession: 'p1' })
    const mounted = await runOnce({ agent: subagent })
    check('installSubagentFollowParent: 监听注册在 agent/request 且 prepend 为真',
        mounted.listener !== undefined && stable(mounted.options) === stable({ prepend: true }))

    // ---------- 非子智能体会话原样放行 ----------
    const top = await runOnce({
        agent: makeAgent({ origin: undefined, parentSession: 'p1' }),
        config: { followParent: true },
        parentOf: () => makeAgent({ options: { provider: 'pi', model: 'parent-model', reasoningEffort: 'high' } }),
    })
    check('resolveRequest: 非子智能体会话原样放行（跟随开关不碰主 Agent）',
        stable(top.result) === stable({ provider: 'pi', model: 'dsr' }))

    // ---------- 宿主开关关闭：跟随父 Agent 的当前路由（输出预算另按合并规则处理） ----------
    const offIdle = await runOnce({
        agent: subagent,
        config: { followParent: false },
        selection: OFF,
        parentOf: () => makeAgent({ options: { provider: 'pi', model: 'parent-model' } }),
    })
    check('resolveRequest: 宿主开关关闭且未开跟随 → 原样',
        stable(offIdle.result) === stable({ provider: 'pi', model: 'dsr' }))

    const offFollow = await runOnce({
        agent: subagent,
        config: { followParent: true },
        selection: OFF,
        parentOf: () => makeAgent({
            header: { config: { provider: 'pi', model: 'parent-model', reasoningEffort: 'high' } },
        }),
        host: { provider: 'pi', model: 'dsr', reasoningEffort: 'low', maxTokens: 4096 } as LlmCallConfig,
    })
    check('resolveRequest: 开跟随 → 整条覆盖为父当前生效的路由（档位照父的来，其余字段原样保留）',
        stable(offFollow.result) === stable({ provider: 'pi', model: 'parent-model', reasoningEffort: 'high', maxTokens: 4096 }))

    const offParentTighter = await runOnce({
        agent: subagent,
        config: { followParent: true },
        selection: OFF,
        parentOf: () => makeAgent({
            header: { config: { provider: 'pi', model: 'parent-model', reasoningEffort: 'high', maxTokens: 2048 } },
        }),
        host: { provider: 'pi', model: 'dsr', maxTokens: 4096 } as LlmCallConfig,
    })
    check('resolveRequest: 父的输出预算比子智能体自带的小 → 取父的（跟随即收缩）',
        stable(offParentTighter.result) === stable({ provider: 'pi', model: 'parent-model', reasoningEffort: 'high', maxTokens: 2048 }))

    const offParentLooser = await runOnce({
        agent: subagent,
        config: { followParent: true },
        selection: OFF,
        parentOf: () => makeAgent({
            header: { config: { provider: 'pi', model: 'parent-model', reasoningEffort: 'high', maxTokens: 8192 } },
        }),
        host: { provider: 'pi', model: 'dsr', maxTokens: 4096 } as LlmCallConfig,
    })
    check('resolveRequest: 父的输出预算比子智能体自带的大 → 抬升差值的八成（4096 + 4096×0.8 = 7372.8 取整 7372）',
        stable(offParentLooser.result) === stable({ provider: 'pi', model: 'parent-model', reasoningEffort: 'high', maxTokens: 7372 }))

    const offNoBudget = await runOnce({
        agent: subagent,
        config: { followParent: true },
        selection: OFF,
        parentOf: () => makeAgent({
            header: { config: { provider: 'pi', model: 'parent-model', reasoningEffort: 'high' } },
        }),
        host: { provider: 'pi', model: 'dsr' } as LlmCallConfig,
    })
    check('resolveRequest: 父与子都没有输出预算 → 不写该键，由子智能体的模型自己解析',
        stable(offNoBudget.result) === stable({ provider: 'pi', model: 'parent-model', reasoningEffort: 'high' }))

    const offAdapterDefault = await runOnce({
        agent: subagent,
        config: { followParent: true },
        selection: OFF,
        parentOf: () => makeAgent({
            header: {
                config: { provider: 'pi', model: 'parent-model', reasoningEffort: 'low' },
                adapterDefaults: { reasoningEffort: true },
            },
        }),
    })
    check('resolveRequest: 父的档位被 adapterDefaults 标为兜底 → 当作未选档位而丢弃该键',
        stable(offAdapterDefault.result) === stable({ provider: 'pi', model: 'parent-model' }))

    const offNoHeader = await runOnce({
        agent: subagent,
        config: { followParent: true },
        selection: OFF,
        parentOf: () => makeAgent({ options: { provider: 'pi', model: 'parent-model', reasoningEffort: 'medium', maxTokens: 2048 } }),
    })
    check('resolveRequest: 父尚无请求头 → 回落父 Agent 自身的 options（输出预算同样跟过来）',
        stable(offNoHeader.result) === stable({ provider: 'pi', model: 'parent-model', reasoningEffort: 'medium', maxTokens: 2048 }))

    // ---------- 父会话待生效的选择优先：UI 换模型/换档位后，子智能体的下一次请求就用新值 ----------
    const pending = await runOnce({
        agent: subagent,
        config: { followParent: true },
        selection: OFF,
        projections: projectionsOf({ provider: 'pi', model: 'switched', reasoningEffort: 'high' }),
        parentOf: () => makeAgent({
            header: { config: { provider: 'pi', model: 'parent-model', reasoningEffort: 'low', maxTokens: 2048 } },
        }),
        host: { provider: 'pi', model: 'dsr', maxTokens: 4096 } as LlmCallConfig,
    })
    check('resolveFollow: 父有待生效选择 → 用它而非最近一次请求头的旧路由（切换后下一次请求即生效；待生效选择无输出预算，保持子智能体自己那份）',
        stable(pending.result) === stable({ provider: 'pi', model: 'switched', reasoningEffort: 'high', maxTokens: 4096 }))

    const pendingNoEffort = await runOnce({
        agent: subagent,
        config: { followParent: true },
        selection: OFF,
        projections: projectionsOf({ provider: 'pi', model: 'switched' }),
        parentOf: () => makeAgent({ header: { config: { provider: 'pi', model: 'parent-model', reasoningEffort: 'low' } } }),
    })
    check('pendingFollow: 待生效选择里没有档位 → 删掉 reasoningEffort 键（父此刻就是「选了模型未选档位」）',
        stable(pendingNoEffort.result) === stable({ provider: 'pi', model: 'switched' }))

    const consumed = await runOnce({
        agent: subagent,
        config: { followParent: true },
        selection: OFF,
        projections: projectionsOf(null),
        parentOf: () => makeAgent({ header: { config: { provider: 'pi', model: 'parent-model', reasoningEffort: 'high' } } }),
    })
    const unregistered = await runOnce({
        agent: subagent,
        config: { followParent: true },
        selection: OFF,
        projections: projectionsOf(undefined),
        parentOf: () => makeAgent({ header: { config: { provider: 'pi', model: 'parent-model', reasoningEffort: 'high' } } }),
    })
    check('pendingFollow: 待生效选择已被请求消费掉，或该键未注册投影 → 回落最近一次请求头',
        stable(consumed.result) === stable({ provider: 'pi', model: 'parent-model', reasoningEffort: 'high' })
        && stable(unregistered.result) === stable({ provider: 'pi', model: 'parent-model', reasoningEffort: 'high' }))

    const blankProvider = await runOnce({
        agent: subagent,
        config: { followParent: true },
        selection: OFF,
        projections: projectionsOf({ provider: '', model: 'switched' }),
        parentOf: () => makeAgent({ header: { config: { provider: 'pi', model: 'parent-model', reasoningEffort: 'high' } } }),
    })
    const blankModel = await runOnce({
        agent: subagent,
        config: { followParent: true },
        selection: OFF,
        projections: projectionsOf({ provider: 'pi', model: '' }),
        parentOf: () => makeAgent({ header: { config: { provider: 'pi', model: 'parent-model', reasoningEffort: 'high' } } }),
    })
    check('pendingFollow: 待生效选择缺 provider 或 model → 当作没有该选择，回落请求头',
        stable(blankProvider.result) === stable({ provider: 'pi', model: 'parent-model', reasoningEffort: 'high' })
        && stable(blankModel.result) === stable({ provider: 'pi', model: 'parent-model', reasoningEffort: 'high' }))

    const projThrows = await runOnce({
        agent: subagent,
        config: { followParent: true },
        selection: OFF,
        projections: { stateOf() { throw new Error('投影未初始化') } },
        parentOf: () => makeAgent({ header: { config: { provider: 'pi', model: 'parent-model' } } }),
    })
    check('pendingFollow: 读投影抛错 → 记一条 warn 并原样放行，不拖垮子智能体这一请求',
        stable(projThrows.result) === stable({ provider: 'pi', model: 'dsr' })
        && projThrows.warns.length === 1
        && projThrows.warns[0].includes('子智能体推理级别未生效'))

    const noParentId = await runOnce({ agent: subagent, config: { followParent: true }, selection: OFF })
    const orphan = await runOnce({
        agent: makeAgent({ origin: 'subagent' }),
        config: { followParent: true },
        selection: OFF,
    })
    const missingParent = await runOnce({
        agent: subagent,
        config: { followParent: true },
        selection: OFF,
        parentOf: () => undefined,
    })
    check('resolveRequest: 父不可得（无 parentSession / 查不到该会话）→ 原样',
        stable(noParentId.result) === stable({ provider: 'pi', model: 'dsr' })
        && stable(orphan.result) === stable({ provider: 'pi', model: 'dsr' })
        && stable(missingParent.result) === stable({ provider: 'pi', model: 'dsr' }))

    // ---------- 宿主服务缺席或抛错 ----------
    const noService = await runOnce({
        agent: subagent,
        config: { followParent: true },
        parentOf: () => makeAgent({ options: { provider: 'pi', model: 'parent-model' } }),
    })
    check('hostSelectionEnabled: 宿主开关关闭 → 跟随父 Agent 的当前路由',
        stable(noService.result) === stable({ provider: 'pi', model: 'parent-model' }))

    const throwing: SelectionStub = {
        current() { throw new Error('已开启但授权表为空') },
    }
    const onThrow = await runOnce({
        agent: subagent,
        config: { followParent: true },
        selection: throwing,
        parentOf: () => makeAgent({ options: { provider: 'pi', model: 'parent-model' } }),
    })
    check('hostSelectionEnabled: current() 抛错（已开启但授权表为空）按关闭处理',
        stable(onThrow.result) === stable({ provider: 'pi', model: 'parent-model' }) && onThrow.warns.length === 0)

    // ---------- 服务不可得：fiber 静默不激活，监听不注册 ----------
    const broken = await runOnce({
        agent: subagent,
        config: { followParent: true },
        selection: OFF,
        getThrows: true,
    })
    check('installSubagentFollowParent: 宿主服务不可得 → 子 fiber PENDING 静默（监听不注册，不拖垮子智能体）',
        broken.listener === undefined
        && broken.warns.length === 0)

    // 收尾把配置源放回默认，避免影响其余模块
    setConfigSource(() => DEFAULT_CONFIG)
}