/**
 * 「返回对话」悬浮按钮：内容区（AppFrame 中心列）左下角的一枚圆形按钮，点击即回到当前会话
 * （宿主 `ctx.layout.selectPanel(null)`）。
 */

import {IconChevronLeftOutlineRegular} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// ctx.locale 服务面
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { CARD_NS } from '@/client/locale-keys'
import { groupValue } from '@/client/model'
import type { Flags } from '@/client/model'
import type { DecodedScope } from '@/client/scope'
import { createFloatingButton } from '@/client/floating-button'
import type { FloatingButton } from '@/client/floating-button'

export function applyBackToChat(ctx: ClientContext, scope: DecodedScope<Flags>): FloatingButton {
    const t = ctx.locale.bind(CARD_NS)
    /** 宿主 layout 服务到位前按钮无从生效 */
    let selectPanel: ((panelId: string | null) => void) | null = null

    const button = createFloatingButton('back-to-chat', {
        icon: IconChevronLeftOutlineRegular({ size: 14 }),
        title: t('backToChat'),
        active: false,
        onClick: () => { selectPanel?.(null) },
    })

    const syncActive = (): void => {
        button.set({
            active: selectPanel !== null && groupValue(scope.getSnapshot().value, 'behavior', 'backToChat'),
        })
    }

    // scope 订阅不推首值，故先按当前快照补跑一次
    const unsubscribeScope = scope.subscribe(syncActive)
    const unsubscribeLocale = ctx.locale.subscribe(() => { button.set({ title: t('backToChat') }) })
    // 服务缺席则该 fiber 静默 PENDING（宿主不提供 ui-layout 的组合下按钮不出现）
    ctx.inject(['layout'], (child) => {
        const layout = child.get('layout')
        selectPanel = (panelId) => { layout.selectPanel(panelId) }
        syncActive()
    })
    syncActive()

    ctx.effect(() => () => {
        unsubscribeScope()
        unsubscribeLocale()
    })

    return button
}
