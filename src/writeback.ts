/**
 * `llm-pi-ai` 段写回的统一外壳：三个写回端点（重置 / 恢复备份 /
 * 探测档位的两次写回）的骨架完全同形——读最新段 → 纯函数出计划 → 经 `queueTask` 写回 →
 * `SETTINGS_CONFLICT` 时重读重算、限次重试。这里只放这段骨架，各端点只给三件事：
 * 段不可读时怎么办、计划怎么算、日志报什么。
 *
 * `src/fix.ts` 与 `src/probe-backup.ts` 的两处写回刻意留在原处不套壳（前者守卫不由它托管、
 * 变更数要返回给 RPC；后者刻意不打逐次日志），两者只复用本模块的 `isSettingsConflict`。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { MAX_ATTEMPTS } from '@/constants'
import { API_NS, PLUGIN_NAME } from '@/shared/constants'
import { errorText, isSettingsConflict } from '@/shared/errors'
import { providersOf } from '@/shared/types'
import { endIgnoreAll, startIgnoreAll } from '@/guard'
import { queueTask } from '@/host'
import { descriptorOf } from '@/section'

/** 写回计划的共同形状：整段 `models` 的 op（各端点自带统计字段，形状不动以免波及纯函数的单测） */
interface ApiWritebackPlan {
    readonly modelOps: readonly SettingsPathOp[]
}

/** 出计划时拿到的当前取值：`llm-pi-ai` 段的 providers 与写回围栏用的 revision */
interface ApiWritebackInput {
    /** 该段 user 层的 providers（已收窄为普通对象，故此处不会是 undefined） */
    providers: Record<string, unknown>
    /** 读取时的段 revision，即写回的围栏（读不到段时为 0，与「无围栏」同义） */
    revision: number
}

/** 骨架的四个可变量 */
interface ApiWritebackSpec<R extends ApiWritebackPlan> {
    /** 动作名（中文）：失败告警与「重试耗尽」两条文案由它拼出 */
    label: string
    /** 段不可读时的处置：抛错即显式失败（文案自定），返回零计划即静默早退 */
    unreadableProviders(): R
    /** 读自有段并出本轮计划；每次重试都重读重算，故必须是纯函数、可对任意一次快照求值 */
    plan(input: ApiWritebackInput): R
    /** 零变更（计划不出 op）时的 info 文案 */
    noChange: string
    /** 写回成功后的 info 文案 */
    done(result: R): string
}

/**
 * 读最新段 → 出计划 → 经 `queueTask` 写回 `llm-pi-ai` 段；`SETTINGS_CONFLICT` 时重读重算（限次）。
 *
 * **调用方须已置位事件流守卫**（探测档位那种守卫持有整轮的）或改用 {@link guardedWritebackApi}。
 * 重试之所以安全：各端点的计划函数都是纯函数且幂等，重读后重算出的 op 与统计只覆盖增量。
 */export async function writebackApi<R extends ApiWritebackPlan>(ctx: Context, spec: ApiWritebackSpec<R>): Promise<R> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (!ctx.fiber.store) return spec.unreadableProviders()
        const descriptor = descriptorOf(ctx, API_NS)
        const revision = descriptor?.revision || 0
        const providers = providersOf(descriptor?.user)
        if (!providers) return spec.unreadableProviders()
        const result = spec.plan({ providers, revision })
        if (result.modelOps.length === 0) {
            ctx.logger.info(`${PLUGIN_NAME}: ${spec.noChange}`)
            return result
        }
        try {
            await queueTask(() => ctx.settings.mutate(API_NS, result.modelOps, revision))
            ctx.logger.info(`${PLUGIN_NAME}: ${spec.done(result)}`)
            return result
        } catch (error) {
            if (isSettingsConflict(error) && attempt < MAX_ATTEMPTS) continue
            ctx.logger.warn(`${PLUGIN_NAME}: ${spec.label}失败（第 ${attempt}/${MAX_ATTEMPTS} 次）：${errorText(error)}`)
            throw error
        }
    }
    // 不可达：循环内各出口都是 return 或 throw，continue 仅在还剩次数时发生；仅作类型收敛
    throw new Error(`${PLUGIN_NAME}: ${spec.label}冲突重试耗尽`)
}

/** {@link writebackApi} 自带事件流守卫的版本：守卫持有到本轮写回返回为止 */
export async function guardedWritebackApi<R extends ApiWritebackPlan>(
    ctx: Context,
    spec: ApiWritebackSpec<R>,
): Promise<R> {
    startIgnoreAll()
    try {
        return await writebackApi(ctx, spec)
    } finally {
        endIgnoreAll()
    }
}
