// src/probe-backup.ts 用例：探测前的整段兜底备份（编码/解码的收窄口径）与启动末尾的崩溃回退
import type { Context } from '@deepseek-ai/cordis'
import { decodeProbeBackup, encodeProbeBackup, restoreProbeBackup, saveProbeBackup } from '@/probe-backup'
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
                        // 预声明把七档写进来了，实际探测前只有 off+high
                        { id: 'm1', reasoningEfforts: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } },
                        // 探测期间用户新加的模型：回退口径不该动它
                        { id: 'm9', reasoningEfforts: { off: null } },
                    ],
                },
                // 备份里没有的提供方：整条跳过，一个字节都不碰
                gone: { models: [{ id: 'x' }] },
            },
        },
        plugin: withBackup === 'ok'
            ? {
                'version-7': { excludes: [] },
                probeBackup: encodeProbeBackup({
                    acme: { models: [{ id: 'm1', reasoningEfforts: { off: null, high: 'high' } }] },
                    // 只存在于备份里的提供方：探测期间被整删，不该被复活
                    dropped: { models: [{ id: 'y' }] },
                }),
            }
            : { 'version-7': { excludes: [] }, probeBackup: withBackup },
    })
    return ctx
}
/** 写回后的 acme 模型条目 */
const modelsOf = (ctx: ReturnType<typeof ctxOf>): Record<string, unknown>[] =>
    (ctx.userOf(API_NS).providers as Record<string, { models?: Record<string, unknown>[] }>).acme?.models ?? []
/** 只数模型配置段的写回（存/清备份走自有段，不算） */
const apiWrites = (ctx: ReturnType<typeof ctxOf>) => ctx.mutateCalls.filter((c) => c.ns === API_NS)
/** 备份键的存取 */
const backupWrites = (ctx: ReturnType<typeof ctxOf>) => ctx.mutateCalls.filter((c) => c.ops.some((op) => op.path[0] === 'probeBackup'))
const effortsOf = (ctx: ReturnType<typeof ctxOf>, id: string): unknown =>
    modelsOf(ctx).find((entry) => entry.id === id)?.reasoningEfforts

/** 执行本文件的全部用例 */
export async function run(): Promise<void> {
    // ---------- 编码：JSON → deflateRaw → base64，编解码同值 ----------
    {
        const providers = {
            acme: { models: [{ id: 'm1', reasoningEfforts: { off: null, high: 'high' }, input: { price: 1.5 } }] },
            lab: { models: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, reasoningEfforts: { off: null } })) },
        }
        const text = encodeProbeBackup(providers)
        check(
            '编解码同值（整段 providers 原样回来）',
            stable(decodeProbeBackup(text)) === stable(providers),
            decodeProbeBackup(text),
        )
        // 压缩的意义就在这：反复出现的长键名被 deflate 吃掉，压完应显著短于原文
        const raw = JSON.stringify(providers).length
        check(`压成字符串后显著更短（${raw} → ${text.length} 字符）`, text.length < raw / 2, { raw, packed: text.length })
    }
    {
        // 读取侧永不抛：非字符串、空串、坏 base64、解压后不是 JSON、解出来不是对象，一律 undefined
        const bad: unknown[] = [undefined, null, 42, '', '不是 base64 的乱码', Buffer.from('{}').toString('base64'), '[]']
        check(
            '解码对一切非预期输入都给 undefined 而不抛',
            bad.every((value) => decodeProbeBackup(value) === undefined),
            bad.map((value) => decodeProbeBackup(value)),
        )
    }

    // ---------- 存备份 ----------
    {
        const ctx = ctxOf('ok')
        await saveProbeBackup(ctx as unknown as Context)
        const stored = backupWrites(ctx)[0]?.ops[0]
        const text = stored?.op === 'set' ? stored.value : undefined
        check(
            '存备份：只写自有段的顶层键（与版本快照同级，不进快照）',
            backupWrites(ctx).length === 1 && stored?.op === 'set' && stable(stored.path) === stable(['probeBackup'])
            && typeof text === 'string',
            backupWrites(ctx).map((c) => c.ops),
        )
        check(
            '备份内容解出来就是当前整段 providers（含探测期间被删的提供方）',
            stable(decodeProbeBackup(text)) === stable(ctx.userOf(API_NS).providers),
            decodeProbeBackup(text),
        )
        check('存备份不动模型配置段', apiWrites(ctx).length === 0, ctx.mutateCalls)
    }
    {
        // 存不下就整轮中止（probeAndFill 依赖这一点保证「没有退路就不动用户配置」）
        const noPlugin = makeStubCtx({ api: { providers: { acme: { models: [{ id: 'm1' }] } } }, noPlugin: true })
        let message = ''
        try {
            await saveProbeBackup(noPlugin as unknown as Context)
        } catch (error) {
            message = error instanceof Error ? error.message : String(error)
        }
        check('自有段不可读：显式失败且零写入', message.includes('自有配置段') && noPlugin.mutateCalls.length === 0, message)

        const noProviders = makeStubCtx({ api: {}, plugin: {} })
        message = ''
        try {
            await saveProbeBackup(noProviders as unknown as Context)
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
            '崩溃回退：m1 回到探测前的 off+high（预声明的七档被撤回）',
            changed === 1 && stable(effortsOf(ctx, 'm1')) === stable({ off: null, high: 'high' }),
            { changed, m1: effortsOf(ctx, 'm1') },
        )
        const providers = ctx.userOf(API_NS).providers as Record<string, unknown>
        check(
            '回退口径：探测期间新增的 m9 原样保留；被删的 dropped provider 不复活，仍在的 gone provider 原样保留',
            stable(effortsOf(ctx, 'm9')) === stable({ off: null })
            && providers.dropped === undefined
            && stable(providers.gone) === stable({ models: [{ id: 'x' }] }),
            providers,
        )
        check(
            '回退成功才清备份：模型配置段写一次、备份键 unset 一次',
            apiWrites(ctx).length === 1 && backupWrites(ctx).length === 1
            && backupWrites(ctx)[0].ops[0]?.op === 'unset',
            ctx.mutateCalls.map((c) => `${c.ns}:${c.ops.map((op) => op.op).join('+')}`),
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
        const same = { acme: { models: [{ id: 'm1', reasoningEfforts: { off: null, high: 'high' } }] } }
        const ctx = makeStubCtx({
            api: { providers: { acme: { models: [{ id: 'm1', reasoningEfforts: { off: null, high: 'high' } }] } } },
            plugin: { 'version-7': { excludes: [] }, probeBackup: encodeProbeBackup(same) },
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
        const ctx = makeStubCtx({ api: {}, plugin: { probeBackup: encodeProbeBackup({ acme: { models: [{ id: 'm1' }] } }) } })
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
