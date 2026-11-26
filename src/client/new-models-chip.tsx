/** 输入框工具行的「新模型」提醒 chip：上游声明里出现、但用户模型列表里还没有的条目，在这里常驻报数。
 *  与 `ComposerEntry` / `FollowLamp` 不同，本席**不受 `behavior` 开关支配**（`behavior.showInComposer` 默认关，
 *  而上新的提醒必须能看见）：没待上线条目时渲染 null，有才占位，故不会白占一行工具条  */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Flags } from '@/client/model'
import { ensureStyles, TIP_MAX_WIDTH } from '@/client/card-styles'
import { CardPanel } from '@/client/card-panel'
import type { CardProps } from '@/client/card'
import type { DecodedScope } from '@/client/scope'

/** 插槽入参：宿主 slot props + 本插件闭包进来的 scope / cardProps */
export interface NewModelsProps {
    scope: DecodedScope<Flags>
    providersScope: DecodedScope<readonly unknown[]>
    cardProps: Omit<CardProps, 't' | 'scope' | 'providersScope'>
}

type SlotProps = PropsRuntime<'conversation.input.left'> & PropsLocale<'settings.modelFix'>

/** 待上线条目总数：`pending` 是「提供方 → 模型 id → 条目」的两层表 */
export function pendingCount(flags: Pick<Flags, 'pending'>): number {
    let total = 0
    for (const byModel of Object.values(flags.pending)) total += Object.keys(byModel).length
    return total
}

export function NewModelsChip(props: SlotProps & NewModelsProps): ReactNode {
    const { t, scope, providersScope, cardProps } = props
    const [open, setOpen] = useState(false)

    // 幂等注入样式：卡片可能还没渲染过，但 chip 已经常驻输入框里了
    useEffect(() => { ensureStyles() }, [])

    const snap = useSyncExternalStore(scope.subscribe, scope.getSnapshot, scope.getSnapshot)
    const count = snap.status === 'ready' ? pendingCount(snap.value) : 0
    if (count === 0) return null

    return (
        <>
            <Tooltip label={t('tipNewModels', { count })} side="top" portal maxWidth={TIP_MAX_WIDTH}>
                <button
                    type="button"
                    className="dsh-mf-composerChip"
                    data-state="on"
                    onClick={() => { setOpen(true) }}
                >
                    {t('chipNewModels', { count })}
                </button>
            </Tooltip>
            <CardPanel
                open={open}
                onClose={() => { setOpen(false) }}
                t={t}
                cardProps={{ ...cardProps, scope, providersScope }}
            />
        </>
    )
}
