/** 悬浮按钮的卡片入口：图标取插件图标，点击打开与【模型优化】chip 同一张配置卡 */

import { createRoot } from 'react-dom/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { CARD_NS } from '@/client/locale-keys'
import { groupValue } from '@/client/model'
import type { Flags } from '@/client/model'
import type { DecodedScope } from '@/client/scope'
import { ensureStyles } from '@/client/card-styles'
import { CardPanel } from '@/client/card-panel'
import type { CardProps } from '@/client/card'
import { createFloatingButton } from '@/client/floating-button'
import type { FloatingButton } from '@/client/floating-button'
import { PLUGIN_NAME } from '@/shared/constants'

/** 插件图标的 SVG 标记（构建期内联，见 tsdown.config.ts 的 define） */
declare const __PLUGIN_ICON__: string

const ICON_STYLE_ID = 'tikaflow-model-fix-float-card-css'

/** 按钮内的插件图标：display:flex 去掉行内 SVG 的基线间隙（否则图标不居中） */
const ICON_STYLE_TEXT = [
    '.dsh-mf-floatIcon{display:flex}',
].join('\n')

/** 幂等注入图标样式；宿主 HMR 按 data-plugin 摘旧节点，故只同步内容不重建 */
function ensureIconStyles(): void {
    if (typeof document === 'undefined') return
    let tag = document.getElementById(ICON_STYLE_ID)
    if (tag === null) {
        tag = document.createElement('style')
        tag.id = ICON_STYLE_ID
        tag.dataset.plugin = PLUGIN_NAME
        document.head.appendChild(tag)
    }
    if (tag.textContent !== ICON_STYLE_TEXT) tag.textContent = ICON_STYLE_TEXT
}

export function applyFloatCard(
    ctx: ClientContext,
    scope: DecodedScope<Flags>,
    cardProps: Omit<CardProps, 't'>,
): FloatingButton {
    const t = ctx.locale.bind(CARD_NS)
    ensureIconStyles()
    /** 弹层的独立 React 根：宿主 Modal 自带 body portal，根只作挂载点 */
    const root = createRoot(document.createElement('div'))

    const button = createFloatingButton('model-opt-card', {
        icon: <span className="dsh-mf-floatIcon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: __PLUGIN_ICON__ }} />,
        title: t('tipOpenSettingCard'),
        active: false,
        onClick: () => {
            ensureStyles()
            root.render(
                <CardPanel
                    open
                    onClose={() => { root.render(null) }}
                    t={t}
                    cardProps={cardProps}
                />,
            )
        },
    })

    /** 可见性 = 「显示在悬浮按钮」开关 */
    const syncActive = (): void => {
        button.set({
            active: groupValue(scope.getSnapshot().value, 'behavior', 'showInFloat'),
        })
    }

    const unsubscribeScope = scope.subscribe(syncActive)
    const unsubscribeLocale = ctx.locale.subscribe(() => { button.set({ title: t('tipOpenSettingCard') }) })
    syncActive()

    ctx.effect(() => () => {
        unsubscribeScope()
        unsubscribeLocale()
        root.unmount()
    })

    return button
}
