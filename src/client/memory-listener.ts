/** 浏览器半的推理级别记忆监听：订阅会话的模型选择投影，把每次切换翻译成两件事——换模型时按记忆恢复级别，换级别时存回记忆（外加 `defaultHigh` 的自动设置）。
 * 这里只管记忆的存取，不管整理：失效清理在 Node 半按宿主的全量模型列表执行（`src/memory.ts`）。存取覆盖面与 UI 选型一致——宿主模型目录里的全部模型都参与。 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// ctx.sessions 服务面（ISessions 声明合并）
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// 一次模型选择与会话投影（宿主真类型，type-only）
import type { ModelSelection, ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
// ctx.modelDirectories 服务面（ModelDirectoryResolver 声明合并）+ 目录控制器类型
import type { ModelDirectory } from '@deepseek-ai/dsh-client-ui-model-selection/client'
// SessionId 品牌 id（sessions / modelDirectories 服务的键类型）
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DEFAULT_CONFIG } from '@/shared/config-schema'
import { MAX_ATTEMPTS } from '@/shared/constants'
import { VERSION_KEY } from '@/client/model'
import type { Flags } from '@/client/model'
import { applyEffort, classifyTransition, sameSelection } from '@/client/effort'
import type { DecodedScope } from '@/client/scope'
import { isSettingsConflict } from '@/shared/errors'

/** 挂上记忆监听子 fiber（宿主无 sessions/modelDirectories 时静默不启用） */
export function applyEffortMemoryListener(ctx: ClientContext, scope: DecodedScope<Flags>): void {
    // 记忆写入带三条护栏（理由见 docs/decisions.md「推理级别记忆」）：
    // 1. 段未 ready 放弃——ConfigForm loading 时 value 回落 DEFAULT_CONFIG（efforts={}），整段 set 等于清空全部记忆。
    // 2. expectedRevision 围栏——与 Node 半 updateMemory 对称。
    // 3. SETTINGS_CONFLICT 重读重算——按旧段回放会抹掉他方刚写入的记忆。
    const rememberEffort = (provider: string, model: string, effort: string | null): void => {
        void (async (): Promise<void> => {
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                const snap = scope.getSnapshot()
                if (snap.status !== 'ready' || snap.value === undefined || snap.revision === undefined) return
                const next = applyEffort(snap.value.efforts, provider, model, effort)
                try {
                    await scope.mutate([{ op: 'set', path: [VERSION_KEY, 'efforts'], value: next }], snap.revision)
                    return
                } catch (error) {
                    if (isSettingsConflict(error) && attempt < MAX_ATTEMPTS) continue
                    return // 记忆可丢，非冲突错误静默放过
                }
            }
        })()
    }

    // 记忆监听子 fiber（宿主无 sessions/modelDirectories 时静默不启用）：纯监听，只订阅会话投影；
    // 自动设置经宿主公开 directory.select，保存经自有 NS 的 settings scope 直写
    ctx.inject(['sessions', 'modelDirectories'], (subCtx) => {        const sessions = subCtx.sessions
        const modelDirectories = subCtx.modelDirectories

        subCtx.effect(() => {
            /** 每会话的追踪状态 */
            interface Tracked {
                retainUnsub: (() => void) | null
                projectionUnsub: (() => void) | null
                lastNext: ModelSelection | null
                pendingAutoSet: ModelSelection | null
            }
            const tracked = new Map<SessionId, Tracked>()

            /** 处理一次投影变化 */
            function handleProjection(id: SessionId, entry: Tracked, next: ModelSelection | null): void {
                // 守卫：跳过本次自动设置反向触发的投影变化（避免重复保存）
                if (entry.pendingAutoSet !== null) {
                    if (next !== null && sameSelection(entry.pendingAutoSet, next)) {
                        entry.pendingAutoSet = null
                        entry.lastNext = next
                        return
                    }
                    entry.pendingAutoSet = null
                }

                const prev = entry.lastNext
                entry.lastNext = next
                if (next === null) return

                let dir: ModelDirectory
                try {
                    dir = modelDirectories.directoryFor(id)
                } catch {
                    // 宿主对未知会话 fail loud（显式抛错），此处跳过本次变化即可
                    return
                }
                const dirState = dir.store.getSnapshot()
                // 开关仅门控「保存」；恢复用的记忆始终取真实 efforts。兜底取共享层默认（段值不可用时与「全新用户」行为一致）
                const flags = scope.getSnapshot().value
                const rememberEfforts = flags?.userExperience.rememberEfforts ?? DEFAULT_CONFIG.userExperience.rememberEfforts
                const defaultHigh = flags?.userExperience.defaultHigh ?? DEFAULT_CONFIG.userExperience.defaultHigh
                const memory = flags?.efforts ?? {}
                const transition = classifyTransition(prev, next, memory, dirState.groups, defaultHigh)

                if (transition.kind === 'model-change') {
                    if (transition.resolved.reasoningEffort !== next.reasoningEffort) {
                        entry.pendingAutoSet = transition.resolved
                        // select 拒绝时清掉守卫：残留会让后续恰好同值的投影变化被误吞（跳过记忆保存）
                        void dir.select(transition.resolved).catch(() => { entry.pendingAutoSet = null })
                    }
                } else if (transition.kind === 'effort-change' && rememberEfforts) {
                    void rememberEffort(next.provider, next.model, next.reasoningEffort ?? null)
                }
            }

            /** 对一个会话建立保留态 + 投影订阅 */
            function trackRetain(id: SessionId): void {
                let entry = tracked.get(id)
                if (!entry) {
                    entry = { retainUnsub: null, projectionUnsub: null, lastNext: null, pendingAutoSet: null }
                    tracked.set(id, entry)
                }
                const retainInfo = sessions.retainInfo(id)
                const syncRetain = (): void => {
                    if (retainInfo.getSnapshot().referenceCount <= 0) {
                        // retain 归零即解除投影订阅：未保留会话不应触发 handleProjection
                        entry.projectionUnsub?.()
                        entry.projectionUnsub = null
                        return
                    }
                    if (entry.projectionUnsub) return
                    const binding = sessions.binding(id)
                    if (!binding) return
                    const projection = binding.session.projections.faceOf('modelSelection')
                    const readNext = (): ModelSelection | null => (projection.getSnapshot() as ModelSelectionProjection | null)?.next ?? null
                    entry.projectionUnsub = projection.subscribe(() => handleProjection(id, entry, readNext()))
                    // 订阅时先按当前值跑一次，避免已选模型要等下一次变化才恢复记忆
                    handleProjection(id, entry, readNext())
                }
                entry.retainUnsub = retainInfo.subscribe(syncRetain)
                // subscribe 只订阅失效通知、不推首值：立即按当前快照补一遍
                syncRetain()
            }

            /** 解绑一个会话的所有订阅 */
            function untrack(id: SessionId): void {
                const entry = tracked.get(id)
                if (!entry) return
                entry.retainUnsub?.()
                entry.projectionUnsub?.()
                tracked.delete(id)
            }

            const syncList = (): void => {
                const ids = new Set(sessions.list.getSnapshot().ids)
                for (const id of [...tracked.keys()]) {
                    if (!ids.has(id)) untrack(id)
                }
                for (const id of ids) {
                    if (!tracked.has(id)) trackRetain(id)
                }
            }
            const listUnsub = sessions.list.subscribe(syncList)
            // 同 trackRetain：subscribe 只订阅失效通知、不推首值，立即按当前快照补一遍
            syncList()

            return () => {
                listUnsub()
                for (const id of [...tracked.keys()]) untrack(id)
                tracked.clear()
            }
        }, `${name}: effort memory listener`)
    })
}
