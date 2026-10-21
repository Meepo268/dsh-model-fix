/**
 * 「返回对话」悬浮按钮：点击即回到当前会话
 * （宿主 `ctx.layout.selectPanel(null)`）。图标与提示跟随当前会话状态。
 */

import {IconChevronLeftOutlineRegular, StateDot} from '@deepseek-ai/dsh-client-ui-primitives'
import type {StateDotState} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// ctx.locale 服务面
import type {} from '@deepseek-ai/dsh-client-locale/client'
// ctx.uiSession 服务面（当前会话与会话状态，声明合并）
import type {UiSession} from '@deepseek-ai/dsh-client-ui-session/client'
// ctx.sessions 服务面（会话列表与投影，声明合并）
import type {ISessions} from '@deepseek-ai/dsh-api-session-controller/client'
// SessionId 品牌 id
import type {SessionId} from '@deepseek-ai/dsh-session/types'
import { CARD_NS } from '@/client/locale-keys'
import type { CardKey } from '@/client/locale-keys'
import { groupValue } from '@/client/model'
import type { Flags } from '@/client/model'
import type { DecodedScope } from '@/client/scope'
import { createFloatingButton } from '@/client/floating-button'
import type { FloatingButton } from '@/client/floating-button'

/** 子智能体目录投影的最小面：宿主 subagent 包的类型面会把 Node 侧 session 增补带进来，故按契约复制 */
interface SubagentCatalogValues {
    readonly subagentCatalog?: readonly { readonly id: SessionId }[]
}

/** 当前会话的展示状态 */
interface SessionView {
    state: StateDotState
    titleKey: CardKey
    params?: Record<string, unknown>
}

/** 宿主工作区只认这三种待交互 */
function pendingTitleKey(kind: string | undefined): CardKey | undefined {
    switch (kind) {
        case 'approval': return 'backToChatWaitingApproval'
        case 'plan-review': return 'backToChatPlanReview'
        case 'question': return 'backToChatWaitingAnswer'
        default: return undefined
    }
}

/** 进行中的提示：子智能体在跑时点态同为 ongoing，靠文案区分 */
function runningTitle(subagents: number): { titleKey: CardKey; params?: Record<string, unknown> } {
    if (subagents <= 0) return { titleKey: 'backToChatRunning' }
    return {
        titleKey: subagents === 1 ? 'backToChatSubagentsOne' : 'backToChatSubagentsOther',
        params: { n: subagents },
    }
}

/** 当前会话的状态：判定与宿主工作区会话行一致 */
function sessionView(uiSession: UiSession, sessions: ISessions): SessionView {
    const currentId = uiSession.adapter.current.getSnapshot().props.sessionId as SessionId | undefined
    if (currentId === undefined) return { state: 'idle', titleKey: 'backToChat' }
    const statuses = uiSession.sessionStatus.getSnapshot()
    const status = statuses.get(currentId)
    const list = sessions.list.getSnapshot()
    const values = list.projectionsBySession[currentId]?.values as SubagentCatalogValues | undefined
    const subagents = (values?.subagentCatalog ?? []).filter(
        (child) => (statuses.get(child.id)?.running ?? list.byId[child.id]?.running) === true,
    ).length
    const pending = pendingTitleKey(status?.pendingInteraction?.kind)
    if (pending !== undefined) return { state: 'warning', titleKey: pending }
    if (status?.running === true) return { state: 'ongoing', ...runningTitle(subagents) }
    if (subagents > 0) return { state: 'ongoing', ...runningTitle(subagents) }
    // 「已完成」态不做，理由见 docs/decisions.md
    return { state: 'idle', titleKey: 'backToChat' }
}

export function applyBackToChat(ctx: ClientContext, scope: DecodedScope<Flags>): FloatingButton {
    const t = ctx.locale.bind(CARD_NS)
    /** 宿主 layout 服务到位前按钮无从生效 */
    let selectPanel: ((panelId: string | null) => void) | null = null
    /** 宿主 uiSession / sessions 服务到位前按空闲显示 */
    let uiSession: UiSession | null = null
    let sessions: ISessions | null = null

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

    const syncStatus = (): void => {
        const view = uiSession === null || sessions === null
            ? { state: 'idle' as const, titleKey: 'backToChat' as const }
            : sessionView(uiSession, sessions)
        if (view.state === 'idle') {
            button.set({ icon: IconChevronLeftOutlineRegular({ size: 14 }), title: t(view.titleKey) })
            return
        }
        button.set({
            icon: <StateDot state={view.state} />,
            title: t(view.titleKey, view.params),
        })
    }

    // scope 订阅不推首值，故先按当前快照补跑一次
    const unsubscribeScope = scope.subscribe(syncActive)
    const unsubscribeLocale = ctx.locale.subscribe(syncStatus)
    // 服务缺席则该 fiber 静默 PENDING
    ctx.inject(['layout'], (child) => {
        const layout = child.get('layout')
        selectPanel = (panelId) => { layout.selectPanel(panelId) }
        syncActive()
    })
    syncActive()
    // 当前会话、各会话状态与列表都影响提示
    ctx.inject(['uiSession', 'sessions'], (child) => {
        uiSession = child.get('uiSession') as UiSession
        sessions = child.get('sessions') as ISessions
        const offCurrent = uiSession.adapter.current.subscribe(syncStatus)
        const offStatus = uiSession.sessionStatus.subscribe(syncStatus)
        const offList = sessions.list.subscribe(syncStatus)
        syncStatus()
        child.effect(() => () => {
            offCurrent()
            offStatus()
            offList()
        })
    })
    syncStatus()

    ctx.effect(() => () => {
        unsubscribeScope()
        unsubscribeLocale()
    })

    return button
}
