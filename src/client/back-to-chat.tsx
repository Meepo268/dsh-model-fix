/**
 * 「返回对话」悬浮按钮：内容区（AppFrame 中心列）左下角的一枚圆形按钮，点击即回到当前会话
 * （宿主 `ctx.layout.selectPanel(null)`）。
 *
 * 按钮要悬浮在中心列左下角（与宿主「回到底部」同一视觉层级），不落在任何渲染席位的树里，
 * 故直插 DOM 而不走 slot。视觉逐条照宿主 `ui-chat` 的 `.toBottom`，图标用宿主 `ui-primitives`
 * 导出的 `IconChevronLeftOutlineRegular`（官方有导出组件就用同一组件，见 docs/ui-fusion.md）。
 *
 * `ctx.layout` 的类型面见 docs/host-api.md「宿主类型导入清单」：宿主 `ui-layout` 包不引，
 * 只按契约复制 `selectPanel` 一个成员（同 `src/subagent.ts` 的做法）。
 */

import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { createRoot } from 'react-dom/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CARD_NS } from '@/client/locale-keys'
import { groupValue } from '@/client/model'
import type { Flags } from '@/client/model'
import type { DecodedScope } from '@/client/scope'
import { PLUGIN_NAME } from '@/shared/constants'

/** 宿主 `ctx.layout` 的最小只读面（按契约复制，不引宿主包类型） */
interface HostLayout {
    /** 选中全局面板；`null` 即回到会话界面、不改当前会话 */
    selectPanel(panelId: string | null): void
}

declare module '@deepseek-ai/cordis' {
    interface Context {
        /** 宿主布局服务面（ui-layout 提供） */
        layout: HostLayout
    }
}

const CONTAINER_ID = 'tikaflow-model-fix-back-to-chat-slot'
const CONTAINER_CLASS = CONTAINER_ID
const BUTTON_ID = 'tikaflow-model-fix-back-to-chat'
const BUTTON_CLASS = BUTTON_ID
const STYLE_ID = 'tikaflow-model-fix-back-to-chat-css'

/** 距容器边缘（下、左）的间距（px） */
const EDGE_GAP = 16

/** 按钮数值全部照宿主 `ui-chat` 的 `.toBottom`；色值只用 --dsw-alias-* 令牌，字面量仅作浅色守卫 */
const STYLE_TEXT = [
    `.${CONTAINER_CLASS}{position:absolute;left:${EDGE_GAP}px;bottom:${EDGE_GAP}px;z-index:999;display:flex}`,
    `.${BUTTON_CLASS}{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:34px;height:34px;padding:0;border:0;border-radius:100px;corner-shape:round;--dsw-elevation-stroke-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-button-floating-fill,#fff);box-shadow:var(--dsw-elevation-panel);cursor:pointer}`,
    `.${BUTTON_CLASS}:hover{background:var(--dsw-alias-button-floating-hover,#f5f6f7)}`,
    `.${BUTTON_CLASS}:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,rgb(65,118,230)));outline-offset:2px}`,
].join('\n')

/** 幂等注入；宿主 HMR 按 data-plugin 摘旧节点，故本节点每次同步内容而非重建 */
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

const CHEVRON_LEFT = primitives.IconChevronLeftOutlineRegular

function BackToChat(props: {
    t: TranslateNS<'settings.modelFix'>
    locale: LocaleRuntime
    onBack: () => void
}): ReactNode {
    // LocaleRuntime.subscribe/getSnapshot 是类方法（内部用 this），裸函数传参会丢 this 导致渲染抛错
    useSyncExternalStore(
        props.locale.subscribe.bind(props.locale),
        props.locale.getSnapshot.bind(props.locale),
        props.locale.getSnapshot.bind(props.locale),
    )
    return (
        <button
            type="button"
            id={BUTTON_ID}
            className={BUTTON_CLASS}
            aria-label={props.t('backToChat')}
            title={props.t('backToChat')}
            onClick={props.onBack}
        >
            {CHEVRON_LEFT({ size: 14 })}
        </button>
    )
}

/**
 * 装上「返回对话」悬浮按钮，可见性只由 `behavior.backToChat` 一个开关决定：开即挂载，关即销毁
 * （拆 React 根、摘容器节点、还原中心列定位上下文）。子 fiber 卸载即级联撤销。
 *
 * 走子 fiber `inject(['layout'])` 门控：`ctx.layout` 由宿主 ui-layout 提供，缺席则该 fiber
 * 静默 PENDING（同 `src/subagent.ts` 的手法）。
 */
export function applyBackToChat(ctx: ClientContext, scope: DecodedScope<Flags>): void {
    ctx.inject(['layout'], (child) => {
        const layout = child.get('layout') as HostLayout
        const t = child.locale.bind(CARD_NS)
        let root: { render(node: ReactNode): void; unmount(): void } | null = null
        let container: HTMLElement | null = null
        /** 中心列原 inline position 值；null = 原本没有 */
        let columnPosition: string | null = null
        let column: HTMLElement | null = null

        /** 宿主中心列没有 position（其定位上下文是整帧），按钮要贴中心列左下角就得补一条。
         * 该元素只由宿主 className 渲染，inline style 不被覆盖 */
        const ensureColumnContext = (target: HTMLElement): void => {
            if (column === target) return
            column = target
            columnPosition = target.style.position
            target.style.position = 'relative'
        }

        const restoreColumnContext = (): void => {
            if (column === null) return
            if (columnPosition === null) column.style.removeProperty('position')
            else column.style.position = columnPosition
            column = null
            columnPosition = null
        }

        const mount = (): void => {
            if (container !== null) return
            if (!groupValue(scope.getSnapshot().value, 'behavior', 'backToChat')) return
            const target = centerColumn()
            if (target === null) return
            ensureStyles()
            ensureColumnContext(target)
            container = document.createElement('div')
            container.id = CONTAINER_ID
            container.className = CONTAINER_CLASS
            target.appendChild(container)
            root = createRoot(container)
            try {
                root.render(
                    <BackToChat
                        t={t}
                        locale={child.locale}
                        onBack={() => { layout.selectPanel(null) }}
                    />,
                )
            } catch (error) {
                // 渲染抛错会清空整棵子树且无痕迹
                child.logger.error(`${PLUGIN_NAME}: 返回对话按钮渲染失败：${String(error)}`)
            }
        }

        const unmount = (): void => {
            root?.unmount()
            root = null
            container?.remove()
            container = null
            restoreColumnContext()
        }

        const reconcile = (): void => {
            if (groupValue(scope.getSnapshot().value, 'behavior', 'backToChat')) mount()
            else unmount()
        }

        // 中心列属宿主 React 树，宿主重挂时会被换掉，换人即重挂按钮
        const observer = new MutationObserver(() => {
            const target = centerColumn()
            if (target === null) {
                if (container !== null) unmount()
                return
            }
            if (container !== null && container.parentElement !== target) unmount()
            mount()
        })
        observer.observe(document.body, { childList: true, subtree: true })

        // scope 订阅不推首值，故先按当前快照补跑一次
        const unsubscribe = scope.subscribe(reconcile)
        reconcile()

        child.effect(() => () => {
            observer.disconnect()
            unsubscribe()
            unmount()
        })
    })
}
