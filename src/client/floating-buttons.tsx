/** 悬浮按钮组容器：内容区（AppFrame 中心列）左下角的一组悬浮按钮。 */

import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { TIP_MAX_WIDTH } from '@/client/card-styles'
import type { FloatingButton } from '@/client/floating-button'
import { PLUGIN_NAME } from '@/shared/constants'

const CONTAINER_ID = 'tikaflow-model-fix-floating-buttons'
const CONTAINER_CLASS = CONTAINER_ID
const BUTTON_CLASS = 'tikaflow-model-fix-floating-button'
const BUTTON_ID_PREFIX = 'tikaflow-model-fix-floating-button-'
const STYLE_ID = 'tikaflow-model-fix-floating-buttons-css'

const EDGE_GAP = 16

const BUTTON_GAP = 8

/** 按钮数值照宿主 `ui-chat` 的 `.toBottom` */
const STYLE_TEXT = [
    `.${CONTAINER_CLASS}{position:absolute;left:${EDGE_GAP}px;bottom:${EDGE_GAP}px;z-index:999;display:flex;flex-direction:column-reverse;align-items:center;gap:${BUTTON_GAP}px}`,
    `.${BUTTON_CLASS}{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:34px;height:34px;padding:0;border:0;border-radius:100px;corner-shape:round;--dsw-elevation-stroke-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-button-floating-fill,#fff);box-shadow:var(--dsw-elevation-panel);cursor:pointer}`,
    `.${BUTTON_CLASS}:hover{background:var(--dsw-alias-button-floating-hover,#f5f6f7)}`,
    `.${BUTTON_CLASS}:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,rgb(65,118,230)));outline-offset:2px}`,
].join('\n')

/** 调用顺序 = 渲染顺序 */
export interface FloatingButtonGroup {
    addButton(button: FloatingButton): void
}

/** 幂等注入：宿主 HMR 按 data-plugin 摘旧节点，故只同步内容不重建 */
function ensureStyles(): void {
    if (typeof document === 'undefined') return
    let tag = document.getElementById(STYLE_ID)
    if (tag === null) {
        tag = document.createElement('style')
        tag.id = STYLE_ID
        tag.dataset.plugin = PLUGIN_NAME
        document.head.appendChild(tag)
    }
    if (tag.textContent !== STYLE_TEXT) tag.textContent = STYLE_TEXT
}

/** 宿主 CSS Module 类名随构建 hash 变化，故按 slot 锚点定位中心列 */
function centerColumn(): HTMLElement | null {
    const parent = document.querySelector('[data-slot="main"]')?.parentElement
    return parent instanceof HTMLElement ? parent : null
}

/** `active` 为假即不渲染，不占位不留 gap */
function FloatingButtonItem(props: { button: FloatingButton }): ReactNode {
    const state = useSyncExternalStore(props.button.subscribe, props.button.getSnapshot)
    if (!state.active) return null
    return (
        <Tooltip label={state.title} side="right" portal maxWidth={TIP_MAX_WIDTH}>
            <button
                type="button"
                id={`${BUTTON_ID_PREFIX}${props.button.id}`}
                className={BUTTON_CLASS}
                aria-label={state.title}
                onClick={state.onClick}
            >
                {state.icon}
            </button>
        </Tooltip>
    )
}

function FloatingButtons(props: { buttons: readonly FloatingButton[] }): ReactNode {
    return (
        <>
            {props.buttons.map((button) => (
                <FloatingButtonItem key={button.id} button={button} />
            ))}
        </>
    )
}

/**
 * 装上悬浮按钮组：容器常驻到插件卸载，按钮由 `addButton` 逐枚加入。
 * 中心列缺定位上下文，就地补一条 inline `position: relative`（宿主只由 className 渲染该元素，inline
 * 不被覆盖，卸载时还原原值）。
 */
export function applyFloatingButtons(ctx: ClientContext): FloatingButtonGroup {
    let buttons: readonly FloatingButton[] = []
    let root: { render(node: ReactNode): void; unmount(): void } | null = null
    let container: HTMLElement | null = null
    /** 中心列原 inline position 值（空串 = 原本没有） */
    let columnPosition = ''
    let column: HTMLElement | null = null

    const render = (): void => {
        try {
            root?.render(<FloatingButtons buttons={buttons} />)
        } catch (error) {
            // 渲染抛错会清空整棵子树且无痕迹
            ctx.logger.error(`${PLUGIN_NAME}: 悬浮按钮组渲染失败：${String(error)}`)
        }
    }

    const addButton = (button: FloatingButton): void => {
        buttons = [...buttons, button]
        render()
    }

    const ensureColumnContext = (target: HTMLElement): void => {
        if (column === target) return
        column = target
        columnPosition = target.style.position
        target.style.position = 'relative'
    }

    const restoreColumnContext = (): void => {
        if (column === null) return
        // 置空串即移除该 inline 声明
        column.style.position = columnPosition
        column = null
        columnPosition = ''
    }

    const mount = (): void => {
        if (container !== null) return
        const target = centerColumn()
        if (target === null) return
        ensureStyles()
        ensureColumnContext(target)
        container = document.createElement('div')
        container.id = CONTAINER_ID
        container.className = CONTAINER_CLASS
        target.appendChild(container)
        root = createRoot(container)
        render()
    }

    // 中心列属宿主 React 树，宿主重挂即换节点 ⇒ 容器跟着搬（React 根随节点走，不重建）
    const observer = new MutationObserver(() => {
        const target = centerColumn()
        if (target === null) return
        if (column !== target) {
            restoreColumnContext()
            ensureColumnContext(target)
        }
        if (container === null) {
            mount()
            return
        }
        if (container.parentElement !== target) target.appendChild(container)
    })
    observer.observe(document.body, { childList: true, subtree: true })

    mount()

    ctx.effect(() => () => {
        observer.disconnect()
        root?.unmount()
        root = null
        container?.remove()
        container = null
        restoreColumnContext()
    })

    return { addButton }
}
