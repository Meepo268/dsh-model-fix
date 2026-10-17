// src/probe-backup.ts 用例：探测目标档位表兜底备份的采集/编解码，与启动末尾只撤预声明的回退
// （不复活被删的模型、不撤销用户在窗口内对其他字段与范围外模型的编辑；撤预声明与清备份的写回全程持守卫）
import type { Context } from '@deepseek-ai/cordis'
import { captureProbeBackup, decodeProbeBackup, encodeProbeBackup, restoreProbeBackup, saveProbeBackup } from '@/probe-backup'
import { API_NS, PLUGIN_NS } from '@/shared/constants'
import { isIgnoreAll } from '@/guard'
import { makeStubCtx } from '@test/ctx'
import { check, stable } from '@test/helper'

/** 造带一份「探测前备份」的 ctx：api 段已被预声明污染（模拟崩在收敛之前） */
function ctxOf(withBackup: unknown = 'ok') {
    const ctx = makeStubCtx({
        api: {
            providers: {
                acme: {
                    models: [
                        // 预声明把七档写进来了，实际探测前只有 off+high；用户还在窗口内改了上下文窗口
                        { id: 'm1', reasoningEfforts: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }, contextWindow: 999000 },
                        // 探测前没有档位表（备份记 null），预声明给它加了六档
                        { id: 'm3', reasoningEfforts: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } },
                        // 探测期间用户新加的模型：不在备份里，回退不得删它
                        { id: 'm9', reasoningEfforts: { off: null } },
                    ],
                },
                gone: { models: [{ id: 'x' }] },
            },
        },
        plugin: withBackup === 'ok'
            ? {
                'version-7': { excludes: [] },
                probeBackup: encodeProbeBackup({
                    acme: {
                        m1: { off: null, high: 'high' },
                        // 探测前没有该字段
                        m3: null,
                        // 探测期间被用户删掉的模型：不得复活
                        m2: { off: null, high: 'high' },
                    },
                }),
            }
            : { 'version-7': { excludes: [] }, probeBackup: withBackup },
    })
    return ctx
}
/** 写回后的模型条目 */
const modelsOf = (ctx: ReturnType<typeof ctxOf>): Record<string, unknown>[] =>
    (ctx.userOf(API_NS).providers as Record<string, { models?: Record<string, unknown>[] }>).acme?.models ?? []
/** 只数模型配置段的写回（存/清备份走自有段，不算） */
const apiWrites = (ctx: ReturnType<typeof ctxOf>) => ctx.mutateCalls.filter((c) => c.ns === API_NS)
/** 备份键的存取 */
const backupWrites = (ctx: ReturnType<typeof ctxOf>) => ctx.mutateCalls.filter((c) => c.ops.some((op) => op.path[0] === 'probeBackup'))
const modelOf = (ctx: ReturnType<typeof ctxOf>, id: string): Record<string, unknown> =>
    modelsOf(ctx).find((entry) => entry.id === id) ?? {}

const TARGETS = [
    { provider: 'acme', model: 'm1', levels: [] },
    { provider: 'acme', model: 'm2', levels: [] },
    { provider: 'acme', model: 'm3', levels: [] },
]

/** 执行本文件的全部用例 */
export async function run(): Promise<void> {
    // ---------- 采集与编解码 ----------
    {
        // 采集只认探测目标：范围外的模型一个键都不留，原值逐字保留
        const providers = {
            acme: {
                models: [
                    { id: 'm1', reasoningEfforts: { off: null, high: 'ultra' } },
                    { id: 'm2', reasoningEfforts: { off: null } },
                ],
            },
        }
        const backup = captureProbeBackup(providers, [{ provider: 'acme', model: 'm1', levels: [] }])
        check(
            '采集只认探测目标，原值逐字保留（含用户自己的 wire 拼写）',
            stable(backup) === stable({ acme: { m1: { off: null, high: 'ultra' } } }),
            backup,
        )
        check(
            '目标模型原本没有 reasoningEfforts：记 null 哨兵，回退时删键',
            stable(captureProbeBackup({ acme: { models: [{ id: 'm3' }] } }, [{ provider: 'acme', model: 'm3', levels: [] }])) === stable({ acme: { m3: null } }),
            captureProbeBackup({ acme: { models: [{ id: 'm3' }] } }, [{ provider: 'acme', model: 'm3', levels: [] }]),
        )
        check('编解码同值', stable(decodeProbeBackup(encodeProbeBackup(backup))) === stable(backup), decodeProbeBackup(encodeProbeBackup(backup)))
        // 只编码不压缩：自有段里存的是一行 base64 纯文本，配置里不会出现大段转义 JSON
        const text = encodeProbeBackup(backup)
        check(
            '编码结果是单行 base64（不含引号与换行，避免配置里出现大段转义 JSON）',
            /^[A-Za-z0-9+/]+={0,2}$/.test(text),
            text,
        )
    }
    {
        // 读取侧永不抛：非字符串、空串、base64 解出不是合法 JSON、解出来不是对象、某 provider 的模型层不是对象，一律 undefined
        const bad: unknown[] = [undefined, null, 42, '', '不是 base64 的乱码', '[]', '{"acme":42}', '{"acme":{"m1":42}}']
        const decoded = bad.map((value) => decodeProbeBackup(value))
        check(
            '解码对一切非预期输入都给 undefined 而不抛',
            decoded.every((value) => value === undefined),
            decoded,
        )
    }

    // ---------- 存备份 ----------
    {
        const ctx = ctxOf('ok')
        await saveProbeBackup(ctx as unknown as Context, TARGETS)
        const stored = backupWrites(ctx)[0]?.ops[0]
        const text = stored?.op === 'set' ? stored.value : undefined
        check(
            '存备份：只写自有段的顶层键（与版本快照同级，不进快照）',
            backupWrites(ctx).length === 1 && stored?.op === 'set' && stable(stored.path) === stable(['probeBackup'])
            && typeof text === 'string',
            backupWrites(ctx).map((c) => c.ops),
        )
        check(
            '备份内容就是探测目标的档位表原值（探测期间才出现的 m9 与 gone 一概不在内）',
            stable(decodeProbeBackup(text)) === stable({ acme: { m1: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }, m3: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } } }),
            decodeProbeBackup(text),
        )
        check('存备份不动模型配置段', apiWrites(ctx).length === 0, ctx.mutateCalls)
    }
    {
        // 存不下就整轮中止（probeAndFill 依赖这一点保证「没有退路就不动用户配置」）
        const noPlugin = makeStubCtx({ api: { providers: { acme: { models: [{ id: 'm1' }] } } }, noPlugin: true })
        let message = ''
        try {
            await saveProbeBackup(noPlugin as unknown as Context, TARGETS)
        } catch (error) {
            message = error instanceof Error ? error.message : String(error)
        }
        check('自有段不可读：显式失败且零写入', message.includes('自有配置段') && noPlugin.mutateCalls.length === 0, message)

        const noProviders = makeStubCtx({ api: {}, plugin: {} })
        message = ''
        try {
            await saveProbeBackup(noProviders as unknown as Context, TARGETS)
        } catch (error) {
            message = error instanceof Error ? error.message : String(error)
        }
        check('模型配置段无 providers：显式失败', message.includes('无法生成探测前的兜底备份'), message)
    }

    // ---------- 启动末尾的回退 ----------
    {
        const ctx = ctxOf('ok')
        const changed = await restoreProbeBackup(ctx as unknown as Context)
        check(
            '崩溃回退：m1 回到探测前的 off+high，m3 的档位表整个撤掉（原本没有该字段）',
            changed === 2
            && stable(modelOf(ctx, 'm1').reasoningEfforts) === stable({ off: null, high: 'high' })
            && modelOf(ctx, 'm3').reasoningEfforts === undefined,
            { changed, m1: modelOf(ctx, 'm1'), m3: modelOf(ctx, 'm3') },
        )
        check(
            '回退只动档位表：窗口内改的 contextWindow 原样保留，被删的 m2 不复活，新增的 m9 不动',
            modelOf(ctx, 'm1').contextWindow === 999000
            && modelsOf(ctx).some((entry) => entry.id === 'm2') === false
            && stable(modelOf(ctx, 'm9').reasoningEfforts) === stable({ off: null }),
            { m1: modelOf(ctx, 'm1'), m9: modelOf(ctx, 'm9') },
        )
        const providers = ctx.userOf(API_NS).providers as Record<string, unknown>
        check(
            '备份外的提供方一个字节都不碰',
            stable(providers.gone) === stable({ models: [{ id: 'x' }] }),
            providers,
        )
        check(
            '回退成功才清备份：模型配置段写一次、备份键 unset 一次',
            apiWrites(ctx).length === 1 && backupWrites(ctx).length === 1
            && backupWrites(ctx)[0].ops[0]?.op === 'unset',
            ctx.mutateCalls.map((c) => `${c.ns}:${c.ops.map((op) => op.op).join('+')}`),
        )
        check(
            '回退期间每一次写回都在事件流守卫内',
            ctx.mutateCalls.every((c) => c.guard),
            ctx.mutateCalls.map((c) => `${c.ns}:${c.guard}`),
        )
        check('回退期间持事件流守卫，结束后已释放', isIgnoreAll() === false, isIgnoreAll())
        check(
            '回退后自有段里不再有备份键（再调一次即无事可做、零写入）',
            (await restoreProbeBackup(ctx as unknown as Context)) === 0
            && ctx.mutateCalls.length === 2,
            ctx.mutateCalls.length,
        )
    }
    {
        // 备份已解不出内容：丢弃并清掉，绝不拿一份不可信的配置去覆盖用户当前配置
        const ctx = ctxOf('乱码')
        const changed = await restoreProbeBackup(ctx as unknown as Context)
        check(
            '备份不可解码：回退 0 个模型、模型配置段零写入、备份键被清掉',
            changed === 0 && apiWrites(ctx).length === 0 && backupWrites(ctx).length === 1
            && (ctx.userOf(PLUGIN_NS).probeBackup === undefined),
            { changed, writes: ctx.mutateCalls.map((c) => c.ns) },
        )
        check(
            '清备份的写回也在事件流守卫内',
            backupWrites(ctx)[0]?.guard === true,
            ctx.mutateCalls.map((c) => `${c.ns}:${c.guard}`),
        )
    }
    {
        // 本轮没探测过：段里没有该键即返回 0，一个字节都不写
        const ctx = makeStubCtx({ api: { providers: { acme: { models: [{ id: 'm1' }] } } }, plugin: { 'version-7': { excludes: [] } } })
        const changed = await restoreProbeBackup(ctx as unknown as Context)
        check('无备份：返回 0 且零写入', changed === 0 && ctx.mutateCalls.length === 0, ctx.mutateCalls.length)
    }
    {
        // 备份与当前值本就一致（如收敛已落盘、只死在清备份之前）：零 op、零变更，
        // 但备份键仍要清掉，否则每次启动都白跑一遍
        const ctx = makeStubCtx({
            api: { providers: { acme: { models: [{ id: 'm1', reasoningEfforts: { off: null, high: 'high' } }] } } },
            plugin: { 'version-7': { excludes: [] }, probeBackup: encodeProbeBackup({ acme: { m1: { off: null, high: 'high' } } }) },
        })
        const changed = await restoreProbeBackup(ctx as unknown as Context)
        check(
            '本就一致：回退 0、模型配置段零写入、备份键仍被清掉',
            changed === 0 && apiWrites(ctx).length === 0 && backupWrites(ctx).length === 1,
            ctx.mutateCalls.map((c) => c.ns),
        )
    }
    {
        // 模型配置段不可读 ⇒ 显式失败（返回 0 会被调用方当成「本就一致」而静默吞掉真故障）
        const ctx = makeStubCtx({ api: {}, plugin: { probeBackup: encodeProbeBackup({ acme: { m1: null } }) } })
        let message = ''
        try {
            await restoreProbeBackup(ctx as unknown as Context)
        } catch (error) {
            message = error instanceof Error ? error.message : String(error)
        }
        check('模型配置段不可读：显式失败', message.includes('无法回退'), message)
        check('失败后事件流守卫已释放', isIgnoreAll() === false, isIgnoreAll())
    }
}