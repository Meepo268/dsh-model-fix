// src/probe.ts 与 src/fill.ts 用例：预声明 → 逐档探测 → 收敛写回的整条链（档位不支持的两条件判据、
// 与档位无关的失败短到模型尾而「参数不正确」不短、provider 级短路（含本组首个请求超时即短整组）、未跑完即还原、关自动写入整轮还原、剔除不支持、忽略排除、帧序列与终帧里的写回统计）
import type { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'
import { probeAndFill } from '@/probe'
import { planEffortApply, declaredEffortsOf } from '@/fill'
import { API_NS, EFFORT_LEVELS } from '@/shared/constants'
import type { PluginConfig } from '@/shared/types'
import type { VerifyProgressFrame } from '@/shared/verify-progress'
import { makeStubCtx } from '@test/ctx'
import { check, stable } from '@test/helper'

const BLOCK_START = { type: 'block-start', index: 0, blockType: 'text' }
const FINISH_STOP = { type: 'finish', reason: { kind: 'stop' } }
/** 终止即报错：kind=error + failure.code，分类只看 code */
const finishError = (code: string, status?: number): StreamChunk =>
    ({ type: 'finish', reason: { kind: 'error', failure: { code, message: '文案随便写', ...(status === undefined ? {} : { status }) } } }) as unknown as StreamChunk
const ok = (): readonly StreamChunk[] => [BLOCK_START as unknown as StreamChunk, FINISH_STOP as unknown as StreamChunk]

/** 探测的请求计划：一个模型 = 七档（与浏览器半 probeTargetsOf 同形） */
const target = (provider: unknown, model: unknown) => ({ provider, model, efforts: [...EFFORT_LEVELS], needTest: false })

/**
 * llm 桩：按「模型@档位 -> 分片序列」应答，未登记的组合默认成功；记录调用顺序。
 * `onCall` 供用例在中途触发中止。
 */
const stub = (script: Record<string, readonly StreamChunk[]>, onCall?: (callIndex: number) => void) => {
    const calls: string[] = []
    const stream = (options: {
        provider: string
        model: string
        reasoningEffort?: string
        messages: readonly { role: string; content: readonly { type: 'text'; text: string }[] }[]
    }): AsyncIterable<StreamChunk> => {
        const tag = `${options.model}${options.reasoningEffort === undefined ? '' : `@${options.reasoningEffort}`}`
        calls.push(`${options.provider}/${tag}`)
        onCall?.(calls.length)
        const chunks = script[tag] ?? ok()
        return (async function* () { for (const chunk of chunks) yield chunk })()
    }
    return { llm: { stream } as unknown as Pick<LlmRuntime, 'stream'>, calls }
}

/** 造一轮的 ctx 桩：acme 下三个模型（m1 未填充、m2 只声明 off+high、m3 声明 off+low+high），排除列表含 lab */
function ctxOf(api?: Record<string, unknown>, plugin?: Record<string, unknown>) {
    return makeStubCtx({
        api: api ?? {
            providers: {
                acme: {
                    models: [
                        { id: 'm1', contextWindow: 128000 },
                        { id: 'm2', reasoningEfforts: { off: null, high: 'high' } },
                        { id: 'm3', reasoningEfforts: { off: null, low: 'low', high: 'high' } },
                    ],
                },
                lab: { models: [{ id: 'n1' }] },
            },
        },
        plugin: plugin ?? { 'version-7': { excludes: ['lab'] } },
    })
}
/** 取写回后的模型条目 */
const modelsOf = (ctx: ReturnType<typeof ctxOf>, provider: string): Record<string, unknown>[] =>
    (ctx.userOf(API_NS).providers as Record<string, { models?: Record<string, unknown>[] }>)[provider]?.models ?? []
/** 只看 reasoningEfforts，避免其余字段（contextWindow 等）干扰断言 */
const effortsOf = (ctx: ReturnType<typeof ctxOf>, provider: string, model: string): unknown =>
    modelsOf(ctx, provider).find((entry) => entry.id === model)?.reasoningEfforts
/** 模型配置段（llm-pi-ai）的写回调用；探测还会在自有段存取兜底备份，计数须分开 */
const apiWrites = (ctx: ReturnType<typeof ctxOf>) => ctx.mutateCalls.filter((c) => c.ns === API_NS)
/** 兜底备份的存取（自有段顶层键） */
const backupWrites = (ctx: ReturnType<typeof ctxOf>) => ctx.mutateCalls.filter((c) => c.ops.some((op) => op.path[0] === 'probeBackup'))

/** 执行本文件的全部用例 */
export async function run(): Promise<void> {
    // ---------- 计划：逐档七条 + 两个开关的入参校验 ----------
    {
        const ctx = ctxOf()
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({})
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1')] }, { onProgress: (f) => { frames.push(f) } })
        check(
            '探测每模型发满七档（按 EFFORT_LEVELS 由低到高），opened.total 与实际发的一致',
            calls.length === 7 && stable(calls) === stable(EFFORT_LEVELS.map((level) => `acme/m1@${level}`)),
            calls,
        )
        check(
            '帧序列为 opened → 逐条 probed → done',
            frames[0].type === 'opened' && frames.at(-1)?.type === 'done'
            && frames.slice(1, -1).every((f) => f.type === 'probed') && frames.length === 9,
            frames.map((f) => f.type),
        )
        check(
            '全可用：可用档位明细七条逐条给出，统计为 7 档 / 1 模型',
            summary.usableEfforts.length === 7 && summary.efforts === 7 && summary.tested === 1
            && summary.plannedEfforts === 7 && summary.unsupported === 0,
            summary.usableEfforts,
        )
        // 预声明一次写回；七档全可用时算出的表与预声明完全一致 ⇒ 收敛零写入（幂等：反复重跑不该反复写）。
        // 只数 llm-pi-ai 段：兜底备份的存与清走自有段，不算模型配置写入
        check(
            '预声明写回一次，收敛零写入（模型配置段）',
            apiWrites(ctx).length === 1,
            ctx.mutateCalls.map((c) => `${c.ns}:${c.ops.length}`),
        )
        check(
            '兜底备份开跑前写进自有段、收敛后清掉（顶层键，与版本快照同级）',
            backupWrites(ctx).length === 2
            && backupWrites(ctx)[0].ops[0]?.op === 'set'
            && backupWrites(ctx)[1].ops[0]?.op === 'unset',
            backupWrites(ctx).map((c) => c.ops),
        )
        check(
            '未填充模型被补满七档（off 取 null，其余为档位名本身）',
            stable(effortsOf(ctx, 'acme', 'm1')) === stable({ off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }),
            effortsOf(ctx, 'acme', 'm1'),
        )
        check(
            '终帧带写回统计，且对齐用户视角的那份配置：本轮只探了 m1，补满七档即新增 7 条',
            stable(summary.fill) === stable({ models: 1, added: 7, removed: 0 }),
            summary.fill,
        )
        // 排除里的提供方：探测范围由浏览器半给，写回仍照旧尊重 excludes，故它一点没被动过
        check('被排除的提供方不预声明不写回（键整个不出现）', modelsOf(ctx, 'lab')[0].reasoningEfforts === undefined, modelsOf(ctx, 'lab'))
    }
    {
        // 剔除不支持：off 已跑通、low 被判参数不正确 ⇒ low 判「不支持」并**从原有档位里剔掉**。
        // 这正是两个开关的分野：关着时 low 只被记录，配置里原样保留
        const ctx = ctxOf()
        const { llm } = stub({ 'm3@low': [finishError('INVALID_REQUEST', 400)] })
        const summary = await probeAndFill(ctx as unknown as Context, llm, {
            models: [target('acme', 'm3')],
            dropUnsupported: true,
        })
        check(
            '剔除不支持：原有档位里被判不支持的 low 被去掉，其余（新增的与原有的）照留',
            stable(Object.keys(effortsOf(ctx, 'acme', 'm3') as Record<string, unknown>)) === stable(['off', 'minimal', 'medium', 'high', 'xhigh', 'max'])
            && summary.unsupported === 1 && summary.fill?.removed === 1,
            { efforts: effortsOf(ctx, 'acme', 'm3'), fill: summary.fill },
        )
        check(
            '不支持档位明细逐条给出',
            stable(summary.unsupportedEfforts) === stable([{ provider: 'acme', model: 'm3', effort: 'low' }]),
            summary.unsupportedEfforts,
        )
    }
    {
        // 关掉剔除不支持：档位表 = 可用 ∪ 原有，low 判不支持也只记录、不动配置
        const ctx = ctxOf()
        const { llm } = stub({ 'm3@low': [finishError('INVALID_REQUEST', 400)] })
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm3')] })
        check(
            '关剔除不支持：只增不减，被判不支持的 low 仍在表里',
            stable(Object.keys(effortsOf(ctx, 'acme', 'm3') as Record<string, unknown>)) === stable([...EFFORT_LEVELS])
            && summary.unsupported === 1 && summary.fill?.removed === 0,
            { efforts: effortsOf(ctx, 'acme', 'm3'), fill: summary.fill },
        )
    }
    {
        // 判「档位不支持」要两个条件：宿主判参数不正确 **且** 已有更低档跑通。
        // 第一档（off）就被判参数不正确时第二个条件不满足 —— 那更可能是模型本身的问题，
        // 判成「这一档不支持」会把一个其实能用的档位误判掉，故只记 other
        const ctx = ctxOf()
        const { llm, calls } = stub({ 'm1@off': [finishError('INVALID_REQUEST', 400)] })
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1')] })
        check(
            '第一档被参数错误拒绝时不判档位不支持（无更低档作对照），且参数不正确不参与模型级短路：七档照发',
            calls.length === 7 && summary.unsupported === 0 && summary.unsupportedEfforts.length === 0
            && summary.results[0].outcome === 'other',
            { calls, first: summary.results[0] },
        )
        check(
            '只有被拒的那一档不进档位表：其余六档验通了就照补',
            stable(Object.keys(effortsOf(ctx, 'acme', 'm1') as Record<string, unknown>)) === stable(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
            && summary.fill?.added === 6,
            { efforts: effortsOf(ctx, 'acme', 'm1'), fill: summary.fill },
        )
    }
    {
        // 一档都没验通 ⇒ 档位表算空 ⇒ 整个 reasoningEfforts 键删掉（回到未声明态，不留空壳）。
        // 顺带钉住判据：厂商侧拒绝（含上游 5xx）断不得「后续必然失败」，故七档一条不少地发完
        const ctx = ctxOf()
        const dead = Object.fromEntries(EFFORT_LEVELS.map((level) => [`m1@${level}`, [finishError('PI_AI_ERROR')]]))
        const { llm, calls } = stub(dead)
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1')] })
        check(
            '全档没跑通时档位表算空：字段整个删掉（等同未声明，不留空壳），且厂商侧拒绝不短档位尾',
            calls.length === 7 && effortsOf(ctx, 'acme', 'm1') === undefined && summary.usableEfforts.length === 0 && summary.fill?.models === 0,
            { calls, efforts: effortsOf(ctx, 'acme', 'm1'), fill: summary.fill },
        )
    }
    {
        // 瞬态（限流 / 超时）只否定这一次：不判不支持、也不短后续档位
        const ctx = ctxOf()
        const { llm, calls } = stub({ 'm1@low': [finishError('RATE_LIMIT', 429)] })
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1')] })
        check(
            '限流只记这一档、继续验后面的档位，且不进不支持明细',
            calls.length === 7 && summary.results[2].outcome === 'rate-limit' && summary.unsupported === 0
            && stable(summary.usableEfforts.map((item) => item.effort)) === stable(['off', 'minimal', 'medium', 'high', 'xhigh', 'max']),
            { calls, usable: summary.usableEfforts },
        )
    }
    {
        // 额度耗尽与档位无关：短到该模型自己的档位尾，别的模型照探
        const ctx = ctxOf()
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({ 'm1@off': [finishError('QUOTA', 429)] })
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1'), target('acme', 'm2')] }, {
            onProgress: (f) => { frames.push(f) },
        })
        check(
            '额度耗尽短到模型尾：m1 只发第一档（skipped 为该模型剩余六档），m2 照发满七档',
            calls.length === 8 && calls.filter((c) => c.startsWith('acme/m1')).length === 1
            && summary.probed === 8 && summary.planned === 14 && summary.providers[0].blockedBy === undefined,
            { calls, report: summary.providers[0] },
        )
        check(
            '被短的模型在记录区留下一条并交代还剩几条，别的提供方结论不受影响',
            frames.filter((f) => f.type === 'probed' && f.model === 'm1' && f.skipped === 6).length === 1
            && frames.filter((f) => f.type === 'probed' && f.model === 'm2').length === 7,
            frames.filter((f) => f.type === 'probed').map((f) => `${f.model}:${f.outcome}:${f.skipped ?? 0}`),
        )
        check(
            '额度耗尽的模型算「没跑完」：原样还原（m1 无字段），m2 照补满七档',
            effortsOf(ctx, 'acme', 'm1') === undefined
            && stable(Object.keys(effortsOf(ctx, 'acme', 'm2') as Record<string, unknown>)) === stable([...EFFORT_LEVELS]),
            { m1: effortsOf(ctx, 'acme', 'm1'), m2: effortsOf(ctx, 'acme', 'm2') },
        )
    }
    {
        // provider 级失败短路整组：该组剩余条数一条都不发，被短路的模型不产生可用结论
        const ctx = ctxOf()
        const { llm, calls } = stub({ 'm1@off': [finishError('TRANSPORT')] })
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1'), target('acme', 'm2')] })
        check(
            '端点不可达短路整组：只发第一条、skipped 为组内剩余、blockedBy 为 unreachable',
            calls.length === 1 && summary.probed === 1 && summary.planned === 14
            && summary.providers[0].blockedBy === 'unreachable' && !summary.providers[0].reachable,
            { calls, report: summary.providers[0] },
        )
        // 两个模型都没跑完 ⇒ 原样还原预声明之前的档位表（m1 无字段、m2 回到 off+high）
        check(
            '没跑完的模型原样还原：m1 字段不出现、m2 回到预声明之前的两档',
            effortsOf(ctx, 'acme', 'm1') === undefined
            && stable(effortsOf(ctx, 'acme', 'm2')) === stable({ off: null, high: 'high' }),
            { m1: effortsOf(ctx, 'acme', 'm1'), m2: effortsOf(ctx, 'acme', 'm2') },
        )
        check('全组被短路时零写入（还原后与原值相同）', summary.fill?.models === 0 && apiWrites(ctx).length === 2, summary.fill)
    }
    {
        // 本组首个请求就超时：成因在请求之外——url 不可达、端点服务中断、本地网络不通，
        // 再逐条等下去只是把同样的 30 秒乘上几十遍，故短整组（本功能没有基线，首个请求就是该模型的第一档）
        const ctx = ctxOf()
        const { llm, calls } = stub({ 'm1@off': [finishError('TIMEOUT')] })
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1'), target('acme', 'm2')] })
        check(
            '首个请求超时短整组：只发第一条、blockedBy 记 timeout',
            calls.length === 1 && summary.probed === 1 && summary.planned === 14
            // 理由记「超时」而非「不可达」，reachable 也不翻假：超时只是没等到受理，不是传输层失败的证据
            && summary.providers[0].blockedBy === 'timeout' && summary.providers[0].reachable,
            { calls, report: summary.providers[0] },
        )
        check(
            '首个超时的两个模型都算没跑完：原样还原（m1 无字段、m2 回到预声明之前的两档）',
            effortsOf(ctx, 'acme', 'm1') === undefined
            && stable(effortsOf(ctx, 'acme', 'm2')) === stable({ off: null, high: 'high' }),
            { m1: effortsOf(ctx, 'acme', 'm1'), m2: effortsOf(ctx, 'acme', 'm2') },
        )
    }
    {
        // 首个之后的超时：链路已经跑通过，只是这一次慢——照旧瞬态处理，不短整组也不短该模型的档位尾
        const ctx = ctxOf()
        const { llm, calls } = stub({ 'm1@minimal': [finishError('TIMEOUT')] })
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1'), target('acme', 'm2')] })
        check(
            '首个之后的超时不当不可达：整组照发满十四条，blockedBy 为空',
            calls.length === 14 && summary.probed === 14 && summary.planned === 14
            && summary.providers[0].blockedBy === undefined && summary.providers[0].reachable
            && summary.usableEfforts.length === 13,
            { calls, report: summary.providers[0] },
        )
        // 超时那一档算「这次没跑成」，既不算可用也不算不支持：不开剔除时档位表就是可用 ∪ 原有
        check(
            '超时那一档不补进档位表，其余六档照补',
            stable(Object.keys(effortsOf(ctx, 'acme', 'm1') as Record<string, unknown>)) === stable(EFFORT_LEVELS.filter((level) => level !== 'minimal')),
            effortsOf(ctx, 'acme', 'm1'),
        )
    }
    {
        // 中止：整轮还原——已跑完的那个模型也不补（必须完全跑完才谈补全），且中止不发 done 帧
        const ctx = ctxOf()
        const controller = new AbortController()
        const frames: VerifyProgressFrame[] = []
        const { llm } = stub({}, (index) => { if (index === 8) controller.abort() })
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1'), target('acme', 'm2')] }, {
            signal: controller.signal,
            onProgress: (f) => { frames.push(f) },
        })
        check('中止时不发 done 帧', frames.every((f) => f.type !== 'done'), frames.map((f) => f.type))
        check(
            '中止即整轮还原：连跑满七档的 m1 也回到未声明，m2 保持原有两档',
            effortsOf(ctx, 'acme', 'm1') === undefined
            && stable(effortsOf(ctx, 'acme', 'm2')) === stable({ off: null, high: 'high' }),
            { m1: effortsOf(ctx, 'acme', 'm1'), m2: effortsOf(ctx, 'acme', 'm2') },
        )
        check('中止时零写入（整轮还原后与原值相同）', summary.fill?.models === 0, summary.fill)
    }
    {
        // 关「自动写入」：探测照常预声明与执行，结论只算不写——全部模型原样还原预声明之前的
        // 档位表（与中止同一形态），终帧的 fill 是「可补全」假设统计，兜底备份照存照清
        const ctx = ctxOf()
        const frames: VerifyProgressFrame[] = []
        const { llm, calls } = stub({})
        const summary = await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1'), target('acme', 'm2')], autoWrite: false }, {
            onProgress: (f) => { frames.push(f) },
        })
        check('关自动写入：探测照常跑满且终帧照发', calls.length === 14 && frames.at(-1)?.type === 'done', { calls: calls.length, frames: frames.map((f) => f.type) })
        check(
            '关自动写入：整轮不落结论，m1 回到未声明、m2 回到原有两档（与中止同一形态）',
            effortsOf(ctx, 'acme', 'm1') === undefined
            && stable(effortsOf(ctx, 'acme', 'm2')) === stable({ off: null, high: 'high' }),
            { m1: effortsOf(ctx, 'acme', 'm1'), m2: effortsOf(ctx, 'acme', 'm2') },
        )
        check(
            '关自动写入：终帧带「可补全」假设统计（m1 全缺 +7、m2 缺五档 +5），兜底备份照存照清、还原照常写回',
            stable(summary.fill) === stable({ models: 2, added: 12, removed: 0 })
            && backupWrites(ctx).length === 2
            && backupWrites(ctx)[0].ops[0]?.op === 'set' && backupWrites(ctx)[1].ops[0]?.op === 'unset'
            && apiWrites(ctx).length === 2,
            { fill: summary.fill, backup: backupWrites(ctx).map((c) => c.ops), api: apiWrites(ctx).length },
        )
    }
    {
        // 忽略排除：同一个 ctx，开关开则被排除的提供方照常预声明与写回
        const ctx = ctxOf()
        const { llm, calls } = stub({})
        await probeAndFill(ctx as unknown as Context, llm, { models: [target('lab', 'n1')], ignoreExcludes: true })
        check(
            '忽略排除：被排除的提供方也探测并写入',
            calls.length === 7 && stable(Object.keys(effortsOf(ctx, 'lab', 'n1') as Record<string, unknown>)) === stable([...EFFORT_LEVELS]),
            { calls, efforts: effortsOf(ctx, 'lab', 'n1') },
        )
    }
    {
        // 开关必须是真的布尔：给了非布尔值按非法入参整轮拒绝，不替浏览器半猜语义
        const ctx = ctxOf()
        const { llm } = stub({})
        let message = ''
        try {
            await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1')], ignoreExcludes: 'yes' })
        } catch (error) {
            message = error instanceof Error ? error.message : String(error)
        }
        check('开关给非布尔值即拒绝且一个字都没写', message.includes('探测请求不合法') && ctx.mutateCalls.length === 0, { message, writes: ctx.mutateCalls.length })
        try {
            await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1')], autoWrite: 'yes' })
        } catch (error) {
            message = error instanceof Error ? error.message : String(error)
        }
        check('「自动写入」给非布尔值同样拒绝且一个字都没写', message.includes('探测请求不合法') && ctx.mutateCalls.length === 0, { message, writes: ctx.mutateCalls.length })
    }
    {
        // 配额：探测按模型展开（7×模型数），模型数封顶 200，超出整体拒绝而非静默截断
        const ctx = ctxOf()
        const { llm } = stub({})
        const many = Array.from({ length: 201 }, (_, i) => target('acme', `m${i}`))
        let message = ''
        try {
            await probeAndFill(ctx as unknown as Context, llm, { models: many })
        } catch (error) {
            message = error instanceof Error ? error.message : String(error)
        }
        check('超过模型数上限即整体拒绝，不截断也不写配置', message.includes('探测请求不合法') && ctx.mutateCalls.length === 0, message)
    }
    {
        // 档位不在支持取值内按非法入参拒绝（入参来自浏览器，仍按不可信输入校验）
        const ctx = ctxOf()
        const { llm } = stub({})
        let message = ''
        try {
            await probeAndFill(ctx as unknown as Context, llm, { models: [{ provider: 'acme', model: 'm1', efforts: ['turbo'], needTest: false }] })
        } catch (error) {
            message = error instanceof Error ? error.message : String(error)
        }
        check('档位越界即拒绝', message.includes('探测请求不合法') && ctx.mutateCalls.length === 0, message)
    }

    // ---------- 纯函数：planEffortApply 的两种口径与排除判定 ----------
    const base: PluginConfig = {
        autoFill: { reasoning: true, context: false, image: true },
        allowUpdate: { reasoning: false, context: true, image: false },
        compat: { disableDeveloper: true, disableStore: true },
        excludes: ['lab'],
        efforts: {},
        userExperience: { rememberEfforts: true, defaultHigh: false, forgetRemoved: true, followParent: false, selfTune: false },
    }
    const providers = {
        acme: {
            models: [
                { id: 'm1', reasoningEfforts: { off: null, high: 'high' }, contextWindow: 128000 },
                { id: 'm2', reasoningEfforts: { off: null, high: 'high' } },
                { id: 'plain' },
            ],
        },
        lab: { models: [{ id: 'n1' }] },
    }
    const apply = (entries: readonly { provider: string; model: string; levels: readonly string[] }[], ignore = false) =>
        planEffortApply(base, providers, entries, ignore)
    {
        // 算出的档位表与现有相同 ⇒ 零变更零 op（幂等：重跑一轮不该反复写）
        const same = apply([{ provider: 'acme', model: 'm2', levels: ['off', 'high'] }])
        check('档位表算出来与现有相同：零 op', same.modelOps.length === 0 && same.models === 0, same)
        // 同提供方多模型合并为一条整段 set，未命中的模型原样保留
        const two = apply([
            { provider: 'acme', model: 'm1', levels: ['off', 'low', 'high'] },
            { provider: 'acme', model: 'm2', levels: [] },
        ])
        const written = two.modelOps[0]?.op === 'set' ? two.modelOps[0].value : undefined
        check(
            '同提供方两个模型合并为一条整段 set，未命中的模型原样保留',
            two.modelOps.length === 1 && stable(written) === stable([
                { id: 'm1', reasoningEfforts: { off: null, low: 'low', high: 'high' }, contextWindow: 128000 },
                { id: 'm2' },
                { id: 'plain' },
            ]),
            two.modelOps,
        )
        // 空表即删键：不写空对象（空壳等同未声明，且会反复触发写入判定）
        check('空表删键时按原有档位表计删除条数（m2 原有两档）', two.models === 2 && two.added === 1 && two.removed === 2, two)
        // 排除命中：默认整组跳过
        const skipped = apply([{ provider: 'lab', model: 'n1', levels: ['off'] }])
        check('排除命中的提供方默认整组跳过', skipped.modelOps.length === 0 && skipped.models === 0, skipped)
        const forced = apply([{ provider: 'lab', model: 'n1', levels: ['off'] }], true)
        check('忽略排除时同一份目标照写', forced.modelOps.length === 1 && forced.models === 1, forced)
        // 模型 id 可含 '/'：键用二元组序列化，与 verifyKey / planPruneEfforts 同口径
        const slashed = planEffortApply(base, { acme: { models: [{ id: 'z-ai/glm-5' }] } }, [{ provider: 'acme', model: 'z-ai/glm-5', levels: ['off'] }], false)
        check('模型 id 含斜杠仍按二元组键命中', slashed.models === 1, slashed)
        // 原有档位表读取：只认纯对象的键并按规范次序排序，未声明即空表
        check(
            'declaredEffortsOf 只取键、按 EFFORT_LEVELS 排序、未声明即空表',
            stable([...declaredEffortsOf(providers, [{ provider: 'acme', model: 'm1', levels: [] }, { provider: 'acme', model: 'plain', levels: [] }]).values()]) === stable([['off', 'high'], []])
            && declaredEffortsOf(providers, [{ provider: 'lab', model: 'n1', levels: [] }]).get(JSON.stringify(['lab', 'n1']))?.length === 0,
            [...declaredEffortsOf(providers, [{ provider: 'acme', model: 'm1', levels: [] }]).values()],
        )
        // 补齐档位时保留已有键的线拼写（如 high:'ultra'），不为所有键重写默认值
        const customProviders = { acme: { models: [{ id: 'mc', reasoningEfforts: { off: 'none', high: 'ultra' } }] } }
        const customApply = planEffortApply(base, customProviders, [{ provider: 'acme', model: 'mc', levels: ['off', 'low', 'high', 'xhigh'] }], false)
        const customWritten = customApply.modelOps[0]?.op === 'set' ? customApply.modelOps[0].value : undefined
        check(
            '补齐档位时保留已有线拼写（off:none 与 high:ultra 原样保留，新补的取档位名）',
            stable(customWritten) === stable([{ id: 'mc', reasoningEfforts: { off: 'none', low: 'low', high: 'ultra', xhigh: 'xhigh' } }]),
            customApply.modelOps,
        )
    }
    {
        // 自有段缺失 ⇒ 无法确认排除列表 ⇒ 必须显式失败（回退默认会让 excludes 变空）
        const ctx = makeStubCtx({ api: { providers: { acme: { models: [{ id: 'm1' }] } } }, noPlugin: true })
        const { llm } = stub({})
        let message = ''
        try {
            await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1')] })
        } catch (error) {
            message = error instanceof Error ? error.message : String(error)
        }
        check('自有段不可读且未忽略排除：显式失败且零写入', message.includes('自有配置段') && ctx.mutateCalls.length === 0, message)
    }
    {
        // 自有段缺失 ⇒ 连兜底备份都无处可放，整轮中止（预声明一旦写下就可能来不及收回，没有退路就不动用户配置）。
        // 「忽略排除」豁免不了这一条：它只豁免读 excludes，不豁免「崩了怎么收场」
        const ctx = makeStubCtx({ api: { providers: { acme: { models: [{ id: 'm1' }] } } }, noPlugin: true })
        const { llm } = stub({})
        let message = ''
        try {
            await probeAndFill(ctx as unknown as Context, llm, { models: [target('acme', 'm1')], ignoreExcludes: true })
        } catch (error) {
            message = error instanceof Error ? error.message : String(error)
        }
        check(
            '自有段不可读即便忽略排除也中止：显式失败且模型配置一个字节都没动',
            message.includes('自有配置段') && apiWrites(ctx).length === 0,
            message,
        )
    }
}
