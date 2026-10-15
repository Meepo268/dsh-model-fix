// self-tune.ts 测试：经 installSelfTune 全链驱动（桩 ctx + 桩宿主服务）——
// resolveCurrentRoute 回落链（投影 pending/lastUsed → 请求头 → options）、query/set 成败路径、
// 装载幂等与设置热更、卸载无痕、服务缺席时子 fiber 静默不激活
import type { Context } from '@deepseek-ai/cordis'
import { check, stable } from '@test/helper'
import { installSelfTune } from '@/self-tune'
import { setConfigSource } from '@/config'
import { DEFAULT_CONFIG } from '@/shared/config-schema'
import type { PluginConfig } from '@/shared/types'
import { PLUGIN_NS } from '@/shared/constants'

/** 工具定义（与 `src/self-tune.ts` 里 register 收到的形态同形，只取测试消费的成员） */
interface ToolDef {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
    readonly output: {
        readonly schema: Record<string, unknown>
        readonly render: (args: unknown, value: unknown) => ReadonlyArray<{ type: 'text'; text: string }>
    }
    execute(args: unknown, exec: { signal: AbortSignal; agent?: AgentStub }): Promise<unknown>
}

/** 提示词段（与 section 收到的形态同形） */
interface SectionDef {
    readonly name: string
    readonly order: number
    readonly text: string
}

/** 最小 Agent 桩——与 self-tune.ts 的契约复制同形 */
interface AgentStub {
    readonly id: string
    readonly session: {
        requestHeader(): { readonly config: RouteStub; readonly adapterDefaults?: { readonly reasoningEffort?: unknown } } | undefined
    }
    readonly options: { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string }
}

/** 路由桩（投影 pending/lastUsed、请求头 config 共用） */
interface RouteStub {
    readonly provider?: string
    readonly model?: string
    readonly reasoningEffort?: string
}

/** 会话控制器桩：selectModel 的可编程行为 */
interface SelectStub {
    (request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<unknown>
}

/** 宿主模型信息桩：resolveModelInfo 的返回（只声明工具消费的成员） */
interface ModelInfoStub {
    reasoning?: {
        efforts: ReadonlyArray<{ id: string; name: string }>
        defaultEffort?: string
    }
}

/** Agent 桩工厂：header 传 undefined 表示尚无任何请求 */
function makeAgent(init: {
    id?: string
    options?: { provider?: string; model?: string; reasoningEffort?: string }
    header?: { config: RouteStub; adapterDefaults?: { reasoningEffort?: unknown } } | undefined
}): AgentStub {
    return {
        id: init.id ?? 'session-1',
        session: { requestHeader: () => init.header },
        options: init.options ?? {},
    }
}

/** 桩 ctx：捕获 on / inject / get / effect / logger / llm，tools.register 与 systemPrompt.section 可追踪卸载；inject 仅当声明的服务全部可取时才执行回调（PENDING 语义） */
function makeCtx(init: {
    /** 四个宿主服务的缺席开关：缺一个即整体不激活（PENDING） */
    missing?: 'tools' | 'systemPrompt' | 'sessionController' | 'sessionProjections'
    /** 投影 stateOf 的返回：undefined 表示服务在但投影未注册 */
    projected?: { pending: RouteStub | null; lastUsed: RouteStub | null } | undefined
    select?: SelectStub
    resolve?: (provider: string, model: string, signal?: AbortSignal) => Promise<ModelInfoStub>
} = {}) {
    const warns: string[] = []
    let settingsListener: ((ns: string) => void) | undefined
    let cleanup: (() => void) | undefined
    /** 当前已注册且未卸载的工具（卸载即移出） */
    const tools: ToolDef[] = []
    const sections: SectionDef[] = []
    /** 卸载记录（断言「旧注入面被卸」用） */
    const disposed: string[] = []

    const ctx = {
        on(name: string, fn: (ns: string) => void) {
            if (name === 'settings/document-updated') settingsListener = fn
            return () => {}
        },
        inject(deps: readonly string[], callback: (child: Context) => void) {
            if (deps.every((name) => ctx.get(name) !== undefined)) callback(ctx as unknown as Context)
            return () => {}
        },
        get(name: string) {
            if (name === 'tools') {
                return init.missing === 'tools' ? undefined : {
                    register(def: ToolDef) {
                        tools.push(def)
                        return () => {
                            disposed.push(`tool:${def.name}`)
                            const at = tools.indexOf(def)
                            if (at >= 0) tools.splice(at, 1)
                        }
                    },
                }
            }
            if (name === 'systemPrompt') {
                return init.missing === 'systemPrompt' ? undefined : {
                    section(section: SectionDef) {
                        sections.push(section)
                        return () => {
                            disposed.push(`section:${section.name}`)
                            const at = sections.indexOf(section)
                            if (at >= 0) sections.splice(at, 1)
                        }
                    },
                }
            }
            if (name === 'sessionController') {
                return init.missing === 'sessionController' ? undefined : {
                    selectModel: async (request: Parameters<NonNullable<SelectStub>>[0]) =>
                        init.select === undefined
                            ? { selected: { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort } }
                            : await init.select(request),
                }
            }
            if (name === 'sessionProjections') {
                return init.missing === 'sessionProjections' ? undefined : {
                    stateOf: (_session: object, key: string) =>
                        key === 'modelSelection' ? init.projected : undefined,
                }
            }
            return undefined
        },
        effect(fn: () => () => void) {
            cleanup = fn()
            return cleanup
        },
        logger: { info() {}, warn(msg: string) { warns.push(msg) }, error() {} },
        llm: {
            resolveModelInfo: async (provider: string, model: string, signal?: AbortSignal) =>
                init.resolve === undefined
                    ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'medium' } }
                    : await init.resolve(provider, model, signal),
        },
    }
    return {
        ctx: ctx as unknown as Context,
        warns,
        tools,
        sections,
        disposed,
        /** 触发一次自有段变更事件（开关热更入口） */
        emitSettingsChange: (ns: string = PLUGIN_NS) => settingsListener?.(ns),
        /** 触发插件卸载（installSelfTune 的 effect 清理） */
        dispose: () => cleanup?.(),
    }
}

/** 配置源替换 + 结束时还原（config 模块是单例，不能污染后续测试文件；body 异步时先等其完成再还原） */
async function withConfig(selfTune: boolean, body: () => Promise<void> | void): Promise<void> {
    const config: PluginConfig = { ...DEFAULT_CONFIG, userExperience: { ...DEFAULT_CONFIG.userExperience, selfTune } }
    setConfigSource(() => config)
    try {
        await body()
    } finally {
        setConfigSource(() => DEFAULT_CONFIG)
    }
}

/** exec 桩 */
function execOf(agent: AgentStub | undefined): { signal: AbortSignal; agent?: AgentStub } {
    return { signal: new AbortController().signal, ...(agent === undefined ? {} : { agent }) }
}

export async function run(): Promise<void> {
    await withConfig(false, () => {
        // ===== 启动：默认关闭不注入、开启注入 2 工具 + 1 提示词段 =====
        {
            const t = makeCtx()
            installSelfTune(t.ctx)
            check('install: 默认关闭不注册任何工具', t.tools.length === 0)
            check('install: 默认关闭不注册提示词段', t.sections.length === 0)
            check('install: 默认关闭不告警', t.warns.length === 0)
        }
    })

    await withConfig(true, async () => {
        // ===== 启动：开启注入 =====
        const t = makeCtx()
        installSelfTune(t.ctx)
        check('install: 注入两枚工具', t.tools.length === 2 && t.tools[0].name === 'query_reasoning_efforts' && t.tools[1].name === 'set_reasoning_effort')
        check('install: 注入一段提示词', t.sections.length === 1 && t.sections[0].name === 'model-fix:effort-tuning' && t.sections[0].order === 3200)
        check('install: 提示词引用两枚工具名', t.sections[0].text.includes('query_reasoning_efforts') && t.sections[0].text.includes('set_reasoning_effort'))
        check('install: 工具声明了 description 与参数 schema', t.tools.every((tool) => tool.description !== '' && tool.parameters.type === 'object'))
        check('install: 工具 output.schema 为最小 object', t.tools.every((tool) => stable(tool.output.schema) === '{"type":"object"}'))

        // render：JSON 文本块
        const rendered = t.tools[0].output.render({}, { ok: true })
        check('render: 单个 text 块且为 JSON 字面量', rendered.length === 1 && rendered[0].type === 'text' && rendered[0].text === '{"ok":true}')

        // ===== 设置热更：无关命名空间不动；已加载时自有段变更无操作（load 幂等，不卸旧重装） =====
        t.emitSettingsChange('llm-pi-ai')
        check('热更: 无关注入面不受其他段变更影响', t.tools.length === 2 && t.disposed.length === 0)
        t.emitSettingsChange()
        check('热更: 已加载时自有段变更无操作', t.tools.length === 2 && t.sections.length === 1 && t.disposed.length === 0)

        // ===== 卸载：插件 effect 清理全部注入 =====
        t.dispose()
        check('卸载: effect 清理工具与提示词段', t.tools.length === 0 && t.sections.length === 0)
        check('卸载: 卸载记录仅清理轮三条', t.disposed.length === 3)

        // ===== 服务缺席：子 fiber PENDING 静默（框架注入语义，主功能不受影响） =====
        for (const missing of ['tools', 'systemPrompt', 'sessionController', 'sessionProjections'] as const) {
            const m = makeCtx({ missing })
            installSelfTune(m.ctx)
            check(`降级: ${missing} 缺席时零注入且不告警`, m.tools.length === 0 && m.sections.length === 0 && m.warns.length === 0)
            m.dispose()
            check(`降级: ${missing} 缺席时卸载无痕`, m.disposed.length === 0)
        }
    })

    await withConfig(true, async () => {
        // ===== 设置热更：开关转关即卸 =====
        const t = makeCtx()
        installSelfTune(t.ctx)
        const config: PluginConfig = { ...DEFAULT_CONFIG, userExperience: { ...DEFAULT_CONFIG.userExperience, selfTune: false } }
        setConfigSource(() => config)
        t.emitSettingsChange()
        check('热更: 转关后工具与提示词段全卸', t.tools.length === 0 && t.sections.length === 0)
        check('热更: 转关后卸载记录三条', t.disposed.length === 3)
        setConfigSource(() => DEFAULT_CONFIG)
        t.dispose()
    })

    // ===== resolveCurrentRoute 回落链（经 query 工具出参断言） =====
    const queryOf = async (init: Parameters<typeof makeCtx>[0], agent?: AgentStub): Promise<Record<string, unknown>> => {
        const t = makeCtx(init)
        installSelfTune(t.ctx)
        const query = t.tools[0]
        return (await query.execute({}, execOf(agent))) as Record<string, unknown>
    }

    await withConfig(true, async () => {
        // 投影 pending 优先
        const pending = await queryOf({ projected: { pending: { provider: 'p1', model: 'm1', reasoningEffort: 'low' }, lastUsed: { provider: 'p9', model: 'm9' } } }, makeAgent({}))
        check('回落链: pending 优先且带当前档位', stable(pending) === stable({ ok: true, provider: 'p1', model: 'm1', currentEffort: 'low', efforts: ['low', 'high'] }))

        // pending 空回落 lastUsed
        const lastUsed = await queryOf({ projected: { pending: null, lastUsed: { provider: 'p1', model: 'm1', reasoningEffort: 'xhigh' } } }, makeAgent({}))
        check('回落链: pending 空回落 lastUsed', stable(lastUsed) === stable({ ok: true, provider: 'p1', model: 'm1', currentEffort: 'xhigh', efforts: ['low', 'high'] }))

        // 投影未注册回落请求头；adapterDefaults 标记的档位视作未选
        const header = await queryOf({ projected: undefined }, makeAgent({ header: { config: { provider: 'p2', model: 'm2', reasoningEffort: 'medium' } } }))
        check('回落链: 投影未注册回落请求头', stable(header) === stable({ ok: true, provider: 'p2', model: 'm2', currentEffort: 'medium', efforts: ['low', 'high'] }))
        const adapterDefault = await queryOf({ projected: undefined }, makeAgent({ header: { config: { provider: 'p2', model: 'm2', reasoningEffort: 'high' }, adapterDefaults: { reasoningEffort: true } } }))
        check('回落链: 适配器兜底档位视作未选（键省略）', stable(adapterDefault) === stable({ ok: true, provider: 'p2', model: 'm2', efforts: ['low', 'high'] }))

        // 无请求头回落 Agent options
        const options = await queryOf({ projected: undefined }, makeAgent({ options: { provider: 'p3', model: 'm3', reasoningEffort: 'max' } }))
        check('回落链: 无请求头回落 options', stable(options) === stable({ ok: true, provider: 'p3', model: 'm3', currentEffort: 'max', efforts: ['low', 'high'] }))

        // 全链为空：no-route
        const noRoute = await queryOf({ projected: undefined }, makeAgent({}))
        check('回落链: 全空为 no-route', stable(noRoute) === stable({ ok: false, error: 'no-route' }))

        // 无 agent（防御边界）
        const noAgent = await queryOf({})
        check('query: 无 agent 为 no-route', stable(noAgent) === stable({ ok: false, error: 'no-route' }))

        // resolveModelInfo 抛错：resolve-failed；入参核对 provider/model/signal
        let resolveArgs: { provider: string; model: string; hasSignal: boolean } | undefined
        const failed = await queryOf({
            projected: { pending: { provider: 'p1', model: 'm1' }, lastUsed: null },
            resolve: async (provider, model, signal) => {
                resolveArgs = { provider, model, hasSignal: signal instanceof AbortSignal }
                throw new Error('NO_ADAPTER')
            },
        }, makeAgent({}))
        check('query: 解析失败回 resolve-failed', stable(failed) === stable({ ok: false, error: 'resolve-failed' }))
        check('query: resolveModelInfo 收到路由与信号', stable(resolveArgs) === stable({ provider: 'p1', model: 'm1', hasSignal: true }))

        // 模型无档位面：efforts 空数组、defaultEffort 键省略
        const noReasoning = await queryOf({ resolve: async () => ({}) }, makeAgent({ header: { config: { provider: 'p', model: 'm' } } }))
        check('query: 无档位面时 efforts 为空数组', stable(noReasoning) === stable({ ok: true, provider: 'p', model: 'm', efforts: [] }))
    })

    await withConfig(true, async () => {
        // ===== set 工具：成功路径（selectModel 入参与出参） =====
        const t = makeCtx()
        installSelfTune(t.ctx)
        const set = t.tools[1]
        let selectRequest: unknown
        const agent = makeAgent({ id: 'session-9', header: { config: { provider: 'p1', model: 'm1' } } })
        const ok = await set.execute({ effort: 'high' }, execOf(agent)) as Record<string, unknown>
        check('set: 成功回路由与新档位', stable(ok) === stable({ ok: true, provider: 'p1', model: 'm1', effort: 'high' }))
        // selectModel 的入参在桩里捕获（经 t.ctx 桩的 select 默认行为无法拦截，重跑一次带 select 桩）
        const t2 = makeCtx({
            select: async (request) => {
                selectRequest = request
                return { selected: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } }
            },
        })
        installSelfTune(t2.ctx)
        await t2.tools[1].execute({ effort: 'high' }, execOf(agent))
        check('set: selectModel 收到会话 id 与路由', stable(selectRequest) === stable({ sessionId: 'session-9', provider: 'p1', model: 'm1', reasoningEffort: 'high' }))

        // selected 无档位：省略 effort 键
        const t3 = makeCtx({ select: async () => ({ selected: { provider: 'p1', model: 'm1' } }) })
        installSelfTune(t3.ctx)
        const offResult = await t3.tools[1].execute({ effort: 'off' }, execOf(agent)) as Record<string, unknown>
        check('set: selected 无档位时省略 effort 键', stable(offResult) === stable({ ok: true, provider: 'p1', model: 'm1' }))

        // ===== set 工具：失败路径 =====
        const invalid = await set.execute({}, execOf(agent)) as Record<string, unknown>
        check('set: 缺 effort 回 invalid-effort', stable(invalid) === stable({ ok: false, effort: '', error: 'invalid-effort' }))
        const nonString = await set.execute({ effort: 42 }, execOf(agent)) as Record<string, unknown>
        check('set: 非字符串 effort 回 invalid-effort', stable(nonString) === stable({ ok: false, effort: '42', error: 'invalid-effort' }))
        const empty = await set.execute({ effort: '' }, execOf(agent)) as Record<string, unknown>
        check('set: 空 effort 回 invalid-effort', stable(empty) === stable({ ok: false, effort: '', error: 'invalid-effort' }))
        const noRoute = await set.execute({ effort: 'low' }, execOf(undefined)) as Record<string, unknown>
        check('set: 无 agent 回 no-route', stable(noRoute) === stable({ ok: false, effort: 'low', error: 'no-route' }))
        const noRouteEmpty = await set.execute({ effort: 'low' }, execOf(makeAgent({}))) as Record<string, unknown>
        check('set: 路由全空回 no-route', stable(noRouteEmpty) === stable({ ok: false, effort: 'low', error: 'no-route' }))

        // selectModel 抛错：文案原样透传（含 RemoteError 文案与子智能体 ownership 拒绝）
        const ownership = makeCtx({ select: async () => { throw new Error('session "s" is owned by subagent routing') } })
        installSelfTune(ownership.ctx)
        const owned = await ownership.tools[1].execute({ effort: 'high' }, execOf(agent)) as Record<string, unknown>
        check('set: 子智能体 ownership 拒绝原样透传', stable(owned) === stable({ ok: false, provider: 'p1', model: 'm1', effort: 'high', error: 'session "s" is owned by subagent routing' }))
        const unsupported = makeCtx({ select: async () => { throw new Error('session/model-unavailable: model does not support "ultra"') } })
        installSelfTune(unsupported.ctx)
        const unsupportedResult = await unsupported.tools[1].execute({ effort: 'ultra' }, execOf(agent)) as Record<string, unknown>
        check('set: 档位不支持原样透传', stable(unsupportedResult) === stable({ ok: false, provider: 'p1', model: 'm1', effort: 'ultra', error: 'session/model-unavailable: model does not support "ultra"' }))

        // 清理（withConfig 外层的 setConfigSource 已还原，此处只卸注入面）
        for (const ctx of [t, t2, t3, ownership, unsupported]) ctx.dispose()
    })
}
