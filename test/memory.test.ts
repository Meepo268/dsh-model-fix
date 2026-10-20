// src/memory.ts 测试：按全量模型列表剪枝记忆（缺席即删除 / 读失败不等于删除）+ 存活清单采集
import type { Context } from '@deepseek-ai/cordis'
import { collectLiveModels, planPruneMemory } from '@/memory'
import type { LiveModels } from '@/memory'
import type { EffortMemory } from '@/shared/types'
import { check, stable } from '@test/helper'

/** provider → 存活模型 id 集合（`null` = 在路由上但目录读失败） */
function live(...entries: [string, readonly string[] | null][]): LiveModels {
    return new Map(entries.map(([id, models]) => [id, models === null ? null : new Set(models)]))
}

/** 最小 ctx 替身：只提供 `collectLiveModels` 用到的两个 llm 方法 */
function llmCtx(
    providers: readonly string[],
    models: Record<string, readonly string[] | 'throw'>,
    calls: string[] = [],
): { ctx: Context; calls: string[] } {
    const ctx = {
        llm: {
            listProviders: () => providers.map((id) => ({ id, name: id })),
            listModels: async (provider: string) => {
                calls.push(provider)
                const entry = models[provider]
                if (entry === 'throw' || entry === undefined) throw new Error(`no catalog for ${provider}`)
                return entry.map((id) => ({ provider, id, name: id }))
            },
        },
    } as unknown as Context
    return { ctx, calls }
}

export async function run(): Promise<void> {
    const MEM: EffortMemory = { a: { m1: 'high', m2: 'low' }, b: { ghost: 'max' } }

    check('planPruneMemory 开关关闭不剪', planPruneMemory(MEM, live(['a', ['m1', 'm2']], ['b', ['ghost']]), false) === null)
    check('planPruneMemory 空记忆无变化', planPruneMemory({}, live(['a', []]), true) === null)
    check('planPruneMemory 全部存活无变化', planPruneMemory({ a: { m1: 'high' } }, live(['a', ['m1']]), true) === null)
    check(
        'planPruneMemory 组内已删模型清除、段随之折叠',
        stable(planPruneMemory(MEM, live(['a', ['m1']]), true)) === stable({ memory: { a: { m1: 'high' } }, removed: 2 }),
    )
    check(
        'planPruneMemory provider 无活路由即整段删',
        stable(planPruneMemory(MEM, live(['a', ['m1', 'm2']]), true)) === stable({ memory: { a: { m1: 'high', m2: 'low' } }, removed: 1 }),
    )
    check(
        'planPruneMemory 读失败（null）整段保留、其余照剪',
        stable(planPruneMemory({ a: { m1: 'high', gone: 'low' }, b: { m: 'max' } }, live(['a', ['m1']], ['b', null]), true))
        === stable({ memory: { a: { m1: 'high' }, b: { m: 'max' } }, removed: 1 }),
    )
    check(
        'planPruneMemory 全部剪光归零对象',
        stable(planPruneMemory({ a: { m1: 'high' } }, live(['a', []]), true)) === stable({ memory: {}, removed: 1 }),
    )
    check(
        'planPruneMemory 一视同仁：官方/插件 provider 同样参与',
        stable(planPruneMemory(
            { 'deepseek-account': { 'ds-m': 'high', 'ds-old': 'low' }, 'plugin-x': { 'x-m': 'max' } },
            live(['deepseek-account', ['ds-m']], ['plugin-x', ['x-m']]),
            true,
        )) === stable({ memory: { 'deepseek-account': { 'ds-m': 'high' }, 'plugin-x': { 'x-m': 'max' } }, removed: 1 }),
    )
    // 不改入参：结果与入参不共享嵌套对象（否则下次比较的是被就地改写过的记忆）
    const memIn: EffortMemory = { a: { m1: 'high', gone: 'low' } }
    const plan = planPruneMemory(memIn, live(['a', ['m1']]), true)
    check(
        'planPruneMemory 不改入参',
        stable(memIn) === stable({ a: { m1: 'high', gone: 'low' } }) && plan !== null && plan.memory.a !== memIn.a,
    )

    check('collectLiveModels 无任何活路由时不剪（退化读）', await collectLiveModels(llmCtx([], {}).ctx, ['a']) === null)
    // 清单摊平成 [provider, 模型数组 | null] 便于比较（Set 不能直接 JSON 化）
    const dump = async (ctx: Context, ids: readonly string[]): Promise<string> => stable(
        [...((await collectLiveModels(ctx, ids)) ?? new Map())].map(([id, models]) => [id, models === null ? null : [...models]]),
    )
    const only = llmCtx(['a'], { a: ['m1', 'm2'] })
    check(
        'collectLiveModels 未注册的 provider 不入清单（缺席即删除）',
        await dump(only.ctx, ['a', 'gone']) === stable([['a', ['m1', 'm2']]]),
    )
    check('collectLiveModels 只对有记忆条目的 provider 取目录', stable(only.calls) === stable(['a']))
    const failing = llmCtx(['a', 'b'], { a: 'throw', b: ['m1'] })
    check(
        'collectLiveModels 单个 provider 读失败标成未知、不影响其他',
        await dump(failing.ctx, ['a', 'b']) === stable([['a', null], ['b', ['m1']]]),
    )
    check(
        'collectLiveModels 读失败整段保留 ⇒ 该段不产生写回',
        planPruneMemory({ a: { m1: 'high', gone: 'low' } }, (await collectLiveModels(failing.ctx, ['a'])) ?? new Map(), true) === null,
    )
    const idle = llmCtx(['a'], { a: ['m1'] })
    await collectLiveModels(idle.ctx, [])
    check('collectLiveModels 无记忆条目时零请求', stable(idle.calls) === stable([]))
}
