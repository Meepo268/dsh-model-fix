/** 「UI 与行为」组（`behavior`）的执行面：把四个可隐匿部件按开关做**真正的挂载 / 卸载**。
 * 为什么必须是装卸而非组件内显隐：`settings.plugins.tab` 的 tab 头由宿主按**注册账本**画出，组件返回 `null` 只会让内容空掉、tab 头照旧。撤销 `ctx.slots.register` 的 disposer 才是让部件从宿主账本里消失的唯一途径。
 * 为什么注册动作写在 `ctx.slots.inject` 的回调里：向未声明的 slot 直接 `register` 会抛 `slot "..." is not declared`，而声明到达前本席不能注册。`ctx.effect` 会把回调返回的清理函数挂进该次声明的 effect 生命周期，故 fiber 卸载或声明坍缩时最后挂载的条目一并撤销。
 * 编排单位是部件：`conversation.input.left` 贡献两条（模型优化 / 跟随状态灯），list 席位按 `id` 记账、id 不同可并存 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { behaviorVisible } from '@/client/model'
import type { Flags } from '@/client/model'
import type { DecodedScope } from '@/client/scope'
import { CARD_NS } from '@/client/locale-keys'
import { PLUGIN_NS as MODEL_FIX_NS } from '@/shared/constants'
import { ComposerEntry, FollowLamp, type ComposerProps } from '@/client/composer'
import { Card, type CardProps } from '@/client/card'

/** 三个宿主 slot（`conversation.input.left` 贡献两条，故此处去重） */
type ManagedSlot = 'settings.models.footer' | 'settings.plugins.tab' | 'conversation.input.left'

/** 一个可挂载的部件：`conversation.input.left` 下的两枚 chip 各有自己的条目 id */
interface Part {
    slot: ManagedSlot
    /** 部件键：同一 slot 下的多个部件靠它区分（同时用作 mounted 账本的键） */
    key: string
    flag: 'showInModels' | 'showInBuiltinPlugins' | 'showInComposer' | 'showFollowStatus'
    mount: () => () => void
}

/** 卡片入参的共有部分：scope / providersScope 由本文件补齐，其余字段逐席相同故只传一份 */
type SharedCardProps = Omit<CardProps, 't' | 'scope' | 'providersScope'>

/** 模型页 footer 席位的 order：取足够小的值以排在全部既有条目之前（list 渲染器按 order 单键重排） */
const FOOTER_ORDER = -999999
/** 内置插件选项卡席位的 order：落在官方条目之后 */
const TAB_ORDER = 20
/** 输入框工具行两枚 chip 的 order：模型优化在前、跟随灯在后 */
const COMPOSER_ORDER = 5
const FOLLOW_ORDER = 6

/** 挂上装卸编排：每个部件在所属 slot 声明到达后按开关决定挂不挂，之后每次配置变更重算。
 * `ctx` 是注册所挂的 ctx（`boot` 传入的子 fiber ctx）：注册与订阅都挂在它上面，fiber 卸载即级联撤销 */
export function applySlotVisibility(
    ctx: ClientContext,
    scope: DecodedScope<Flags>,
    shared: SharedCardProps,
    composerProps: Omit<ComposerProps, 'cardProps'>,
): void {
    const t = ctx.locale.bind(CARD_NS)
    const card = { ...shared, scope, providersScope: composerProps.providersScope }
    // 每个部件当前挂载着的 disposer；undefined 即当前未挂载（reconcile 的幂等依据）
    const mounted = new Map<string, (() => void) | undefined>()

    const parts: readonly Part[] = [
        {
            slot: 'settings.models.footer',
            key: 'modelsFooter',
            flag: 'showInModels',
            mount: () => ctx.slots.register({
                name: 'settings.models.footer',
                id: MODEL_FIX_NS,
                order: FOOTER_ORDER,
                locale: CARD_NS,
            }, (props) => <Card {...card} {...props} />),
        },
        {
            slot: 'settings.plugins.tab',
            key: 'builtinPluginsTab',
            flag: 'showInBuiltinPlugins',
            mount: () => ctx.slots.register({
                name: 'settings.plugins.tab',
                id: MODEL_FIX_NS,
                order: TAB_ORDER,
                // tab label 走 thunk，section 每次读账本时求值、切语言即跟随
                label: () => t('tabLabel'),
                locale: CARD_NS,
            }, (props) => <Card {...card} defaultOpen {...props} />),
        },
        {
            slot: 'conversation.input.left',
            key: 'composerEntry',
            flag: 'showInComposer',
            mount: () => ctx.slots.register({
                name: 'conversation.input.left',
                id: `${MODEL_FIX_NS}-entry`,
                order: COMPOSER_ORDER,
                locale: CARD_NS,
            }, (props) => <ComposerEntry {...props} {...composerProps} cardProps={card} />),
        },
        {
            slot: 'conversation.input.left',
            key: 'followLamp',
            flag: 'showFollowStatus',
            mount: () => ctx.slots.register({
                name: 'conversation.input.left',
                id: `${MODEL_FIX_NS}-follow`,
                order: FOLLOW_ORDER,
                locale: CARD_NS,
            }, (props) => <FollowLamp {...props} {...composerProps} cardProps={card} />),
        },
    ]

    /**
     * 目标态与已挂载态不一致才动：这是幂等的全部依据。只处理 `key` 这一个部件。
     */
    const reconcileOne = (key: string): void => {
        const part = parts.find((p) => p.key === key)
        // 编排表是本文件的字面量，key 必在其中；缺失即内部错误
        if (part === undefined) return
        const dispose = mounted.get(key)
        if (behaviorVisible(scope.getSnapshot().value, part.flag)) {
            if (dispose === undefined) mounted.set(key, part.mount())
        } else if (dispose !== undefined) {
            dispose()
            mounted.set(key, undefined)
        }
    }

    for (const slot of new Set(parts.map((p) => p.slot))) {
        const keys = parts.filter((p) => p.slot === slot).map((p) => p.key)
        // 宿主在声明到达后执行本回调（同一 slot 只需等一次声明，旗下各部件共用它）
        ctx.slots.inject(slot, () => {
            for (const key of keys) reconcileOne(key)
            // subscribe 只推失效通知、不推首值，故上面已按当前快照补跑一遍
            const unsubscribe = scope.subscribe(() => { for (const key of keys) reconcileOne(key) })
            return () => {
                unsubscribe()
                for (const key of keys) {
                    mounted.get(key)?.()
                    mounted.set(key, undefined)
                }
            }
        })
    }
}
