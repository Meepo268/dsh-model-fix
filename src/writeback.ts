/** `llm-pi-ai` 段写回的统一外壳：读最新段 → 纯函数出计划 → 经 `queueTask` 写回 → 冲突重读重算限次；
 * 各端点只给「段不可读怎么办 / 计划怎么算 / 日志报什么」。`src/fix.ts` 与 `src/probe-backup.ts` 的写回刻意留在原处不套壳，只复用本模块的 `isSettingsConflict` */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { MAX_ATTEMPTS } from '@/constants'
import { API_NS, PLUGIN_NAME } from '@/shared/constants'
import { errorText, isSettingsConflict } from '@/shared/errors'
import { providersOf } from '@/shared/types'
import { endIgnoreAll, startIgnoreAll } from '@/guard'
import { queueTask } from '@/host'
import { descriptorOf } from '@/section'

/** 写回计划的共同形状（各端点自带统计字段，形状不动以免波及纯函数单测） */
interface ApiWritebackPlan {
    readonly modelOps: readonly SettingsPathOp[]
}

/** 出计划时的当前取值 */
interface ApiWritebackInput {
    providers: Record<string, unknown>
    /** 段 revision（写回围栏；读不到段时为 0，与无围栏同义） */
    revision: number
}

/** 骨架的四个可变量 */
interface ApiWritebackSpec<R extends ApiWritebackPlan> {
    /** 动作名（中文）：拼进失败告警与「重试耗尽」文案 */
    label: string
    /** 段不可读时的处置：抛错即显式失败，返回零计划即静默早退 */
    unreadableProviders(): R
    /** 出本轮计划；每次重试重读重算，须为纯函数（可对任意一次快照求值） */
    plan(input: ApiWritebackInput): R
    /** 零变更（不出 op）时的 info 文案 */
    noChange: string
    /** 写回成功后的 info 文案 */
    done(result: R): string
}

/** 读最新段 → 出计划 → 经 `queueTask` 写回 `llm-pi-ai`；`SETTINGS_CONFLICT` 重读重算（限次）。
 * 调用方须已置位事件流守卫，或改用 {@link guardedWritebackApi} */
export async function writebackApi<R extends ApiWritebackPlan>(ctx: Context, spec: ApiWritebackSpec<R>): Promise<R> {
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
