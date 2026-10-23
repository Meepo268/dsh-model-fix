/**
 * 「返回对话」悬浮按钮：点击回到主视图会话
 * （子智能体视图走 `ctx.uiWorkspace.openSession`；主视图不在对话页签时切对话页签；
 * 其余情况 `ctx.layout.selectPanel(null)`）。
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronLeftOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { UiSession } from '@deepseek-ai/dsh-client-ui-session/client'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CARD_NS } from '@/client/locale-keys'
import type { CardKey } from '@/client/locale-keys'
import { groupValue } from '@/client/model'
import type { Flags } from '@/client/model'
import type { DecodedScope } from '@/client/scope'
import { createFloatingButton } from '@/client/floating-button'
import type { FloatingButton } from '@/client/floating-button'

const CONVERSATION_TABS_SELECTOR = '[data-conversation-tabs]'
const CONVERSATION_TAB_SELECTOR = 'button[role="tab"]'
const CONVERSATION_STORE_KEY = 'dsh.conversation'
const CHAT_VIEW_ID = 'chat'

/** 子智能体目录投影的最小面（宿主 subagent 包的类型面会把 Node 侧 session 增补带进来，故复制契约） */
interface SubagentCatalogValues {
    readonly subagentCatalog?: readonly { readonly id: SessionId }[]
}

/** uiWorkspace 服务的最小面（同上） */
interface UiWorkspaceNav {
    openSession(sessionId: SessionId): void
}

/** 找宿主的「对话」页签按钮（页签条内首枚即「对话」） */
function findChatTab(): HTMLButtonElement | null {
    if (typeof document === 'undefined') return null
    const strip = document.querySelector(CONVERSATION_TABS_SELECTOR)
    if (strip === null) return null
    return strip.querySelector<HTMLButtonElement>(CONVERSATION_TAB_SELECTOR)
}

/** 读某 session 持久化的 view 偏好（宿主持有的真实 view id） */
function readStoredViewId(sessionId: SessionId): string | null {
    if (typeof localStorage === 'undefined') return null
    try {
        const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
        if (raw === null) return null
        const stored: unknown = JSON.parse(raw)
        if (typeof stored !== 'object' || stored === null) return null
        const view = (stored as { view?: unknown }).view
        return typeof view === 'string' ? view : null
    } catch {
        return null
    }
}

interface BackTarget {
    readonly id: SessionId
    readonly isChild: boolean
}

interface SessionView {
    state: StateDotState
    titleKey: CardKey
    params?: Record<string, unknown>
    sessionTitle?: string
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

function BackToChatIcon(props: { base: ReactNode }): ReactNode {
    const [hovered, setHovered] = useState(false)
    return (
        <span
            style={{ width: '100%', alignSelf: 'stretch', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
        >
            {hovered ? IconChevronLeftOutlineRegular({ size: 14 }) : props.base}
        </span>
    )
}

/** 返回目标：子智能体视图取直接父（只看一层 ⇒ 每点一次向上一级），否则当前会话自己 */
function backTarget(list: SessionListState, currentId: SessionId): BackTarget {
    const row = list.byId[currentId]
    // fork 子会话也带 parentId 但 origin 不是 'subagent'；父目录未物化时 parentId 缺席
    const parentId = row?.origin === 'subagent' ? row.parentId : undefined
    return parentId === undefined ? { id: currentId, isChild: false } : { id: parentId, isChild: true }
}

/** 服务缺席 / 无当前会话时的展示 */
const IDLE_VIEW: SessionView = { state: 'idle', titleKey: 'backToChat' }

/** 返回目标及其状态：判定与宿主工作区会话行一致 */
function inspect(uiSession: UiSession, sessions: ISessions): { target: BackTarget | null; view: SessionView } {
    const currentId = uiSession.adapter.current.getSnapshot().props.sessionId as SessionId | undefined
    const list = sessions.list.getSnapshot()
    if (currentId === undefined) return { target: null, view: IDLE_VIEW }
    const target = backTarget(list, currentId)
    const statuses = uiSession.sessionStatus.getSnapshot()
    const status = statuses.get(target.id)
    const values = list.projectionsBySession[target.id]?.values as SubagentCatalogValues | undefined
    const subagents = (values?.subagentCatalog ?? []).filter(
        (child) => (statuses.get(child.id)?.running ?? list.byId[child.id]?.running) === true,
    ).length
    const pending = pendingTitleKey(status?.pendingInteraction?.kind)
    const sessionTitle = list.byId[target.id]?.displayTitle
    if (pending !== undefined) return { target, view: { state: 'warning', titleKey: pending, sessionTitle } }
    if (status?.running === true) return { target, view: { state: 'ongoing', ...runningTitle(subagents), sessionTitle } }
    if (subagents > 0) return { target, view: { state: 'ongoing', ...runningTitle(subagents), sessionTitle } }
    // 目标非主视图会话时宿主才置 completionUnread
    if (status?.completionUnread === true) {
        return { target, view: { state: 'done', titleKey: 'backToChatCompleted', sessionTitle } }
    }
    return { target, view: { state: 'idle', titleKey: 'backToChat', sessionTitle } }
}

export function applyBackToChat(ctx: ClientContext, scope: DecodedScope<Flags>): FloatingButton {
    const t = ctx.locale.bind(CARD_NS)
    let selectPanel: ((panelId: string | null) => void) | null = null
    let openSession: ((sessionId: SessionId) => void) | null = null
    let isMainView: (() => boolean) | null = null
    let target: BackTarget | null = null
    let uiSession: UiSession | null = null
    let sessions: ISessions | null = null

    const button = createFloatingButton('back-to-chat', {
        icon: <BackToChatIcon base={IconChevronLeftOutlineRegular({ size: 14 })} />,
        title: t('backToChat'),
        active: false,
        onClick: () => {
            // 1) 子智能体视图 → 回到父会话（切 workspace 选择）
            if (target !== null && target.isChild && openSession !== null) {
                openSession(target.id)
                return
            }
            // 2) 主视图 + 根智能体 + 当前不在对话页签 → 切到对话页签
            if (target !== null && !target.isChild
                && isMainView?.() === true
                && readStoredViewId(target.id) !== CHAT_VIEW_ID) {
                findChatTab()?.click()
                return
            }
            // 3) 其余情况 → 宿主面板 null（从插件管理器等全局面板回到会话主视图）
            selectPanel?.(null)
        },
    })

    const syncActive = (): void => {
        button.set({
            active: selectPanel !== null && groupValue(scope.getSnapshot().value, 'behavior', 'backToChat'),
        })
    }

    const syncStatus = (): void => {
        const { target: next, view } = uiSession === null || sessions === null
            ? { target: null, view: IDLE_VIEW }
            : inspect(uiSession, sessions)
        target = next
        const label = t(view.titleKey, view.params)
        const title = view.sessionTitle === undefined ? label : `${label} · ${view.sessionTitle}`
        if (view.state === 'idle') {
            button.set({ icon: <BackToChatIcon base={IconChevronLeftOutlineRegular({ size: 14 })} />, title })
            return
        }
        button.set({ icon: <BackToChatIcon base={<StateDot state={view.state} />} />, title })
    }

    // scope 订阅不推首值，先按当前快照补跑一次
    const unsubscribeScope = scope.subscribe(syncActive)
    const unsubscribeLocale = ctx.locale.subscribe(syncStatus)
    ctx.inject(['layout'], (child) => {
        const layout = child.get('layout')
        selectPanel = (panelId) => { layout.selectPanel(panelId) }
        isMainView = () => layout.panelInfo.getSnapshot().activePanelId === null
        syncActive()
    })
    syncActive()
    ctx.inject(['uiWorkspace'], (child) => {
        openSession = (sessionId) => { (child.get('uiWorkspace') as UiWorkspaceNav).openSession(sessionId) }
    })
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
