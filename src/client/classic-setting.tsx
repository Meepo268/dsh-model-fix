/**
 * 「经典设置」入口：抢下宿主的 `settings.launcher` 席位（priority 遮蔽账号入口），
 * 渲染一枚经典「设置」按钮，点击即打开宿主设置面板。
 *
 * 按钮 1:1 复刻宿主 dsh-v0.2.0-rc.2 外壳的回退触发器：结构照该版 `SettingsRoot.tsx` 的
 * fallback，数值照该版 `SettingsRoot.module.css` 与 `chrome.module.css`，图标与文案照
 * 该版 `chrome.tsx`（出处见 docs/ui-fusion.md）。
 */
import type { ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// SlotMap 的 'settings.launcher' 键声明合并
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// primitives 由宿主模块表注入
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { groupValue } from '@/client/model'
import type { Flags } from '@/client/model'
import { CARD_NS } from '@/client/locale-keys'
import type { DecodedScope } from '@/client/scope'
import { PLUGIN_NAME } from '@/shared/constants'

const STYLE_ID = 'dsh-model-fix-classic-setting-css'
const TRIGGER_CLASS = 'dsh-mf-classic-setting-trigger'
const RAIL_CLASS = 'dsh-mf-classic-setting-rail'
const LABEL_CLASS = 'dsh-mf-classic-setting-label'
/** 遮蔽用的席位优先级：数字最小者渲染，故须小于宿主账号入口的默认 0 */
const SHADOW_PRIORITY = -1
/** 图标尺寸（px）照 dsh-v0.2.0-rc.2 的 chrome.tsx：展开 16、收起 18 */
const ICON_SIZE_WIDE = 16
const ICON_SIZE_RAIL = 18

/** 按钮数值逐条照 dsh-v0.2.0-rc.2 的 SettingsRoot.module.css 与 chrome.module.css；色值只用 --dsw-alias-* 令牌，字面量仅作浅色守卫 */
const STYLE_TEXT = [
    `.${TRIGGER_CLASS}{flex:1;min-width:0;display:flex;align-items:center;gap:8px;width:auto;height:42px;margin:0;padding:0 10px 0 8px;box-sizing:border-box;border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;overflow:hidden;color:var(--dsw-alias-label-primary,#0f1115);font-family:inherit;font-size:14px;line-height:22px}`,
    `.${TRIGGER_CLASS}:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}`,
    `.${RAIL_CLASS}{flex:none;width:36px;height:36px;margin:0;justify-content:center;gap:0;padding:0}`,
    `.${LABEL_CLASS}{overflow:hidden;white-space:nowrap}`,
].join('\n')

/** 幂等注入样式：宿主 HMR 会按 data-plugin 摘走旧节点，节点在则同步内容 */
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

/** 经典设置按钮：宿主外壳的回退触发器，props 来自 launcher 席位 */
type ClassicSettingProps = PropsRuntime<'settings.launcher'> & PropsLocale<'settings.modelFix'>

function ClassicSettingButton({ wide, settingsOpen, settingsShortcut, openSettings, t }: ClassicSettingProps): ReactNode {
    return (
        <primitives.Tooltip disabled={settingsOpen} label={t('classicSettingLabel')} shortcutKeys={settingsShortcut?.keys}>
            <button
                type="button"
                className={wide ? TRIGGER_CLASS : `${TRIGGER_CLASS} ${RAIL_CLASS}`}
                aria-label={t('classicSettingLabel')}
                aria-keyshortcuts={settingsShortcut?.aria}
                aria-haspopup="dialog"
                aria-expanded={settingsOpen}
                onClick={() => { openSettings() }}
            >
                <primitives.IconSettingsOutlineMedium size={wide ? ICON_SIZE_WIDE : ICON_SIZE_RAIL} />
                {wide && <span className={LABEL_CLASS}>{t('classicSettingLabel')}</span>}
            </button>
        </primitives.Tooltip>
    )
}

/**
 * 装上经典设置入口：开 `behavior.classicSetting` 即注册（遮蔽账号入口）、关即注销。
 * 账本里没有别的占位者时不注册——那种宿主本就显示自己的回退按钮。
 */
export function applyClassicSetting(ctx: ClientContext, scope: DecodedScope<Flags>): void {
    ctx.slots.inject('settings.launcher', () => {
        let mounted: (() => void) | undefined
        /** 账本里是否有本插件之外的占位者（宿主账号入口） */
        const hasOther = (): boolean => ctx.slots.entries('settings.launcher')
            .some(entry => entry.registrant !== PLUGIN_NAME)
        const reconcile = (): void => {
            const wanted = groupValue(scope.getSnapshot().value, 'behavior', 'classicSetting') && hasOther()
            if (wanted && mounted === undefined) {
                ensureStyles()
                mounted = ctx.slots.register({
                    name: 'settings.launcher',
                    priority: SHADOW_PRIORITY,
                    locale: CARD_NS,
                }, ClassicSettingButton)
            } else if (!wanted && mounted !== undefined) {
                mounted()
                mounted = undefined
            }
        }
        // 开关与账本变化都重算（两者注册先后不可控）
        const offScope = scope.subscribe(reconcile)
        const offLedger = ctx.slots.subscribe('settings.launcher', reconcile)
        reconcile()
        return () => {
            offScope()
            offLedger()
            mounted?.()
            mounted = undefined
        }
    })
}
