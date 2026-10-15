/**
 * 「UI 与行为」组（`behavior`）的执行面：把三个可隐匿席位按开关做**真正的挂载 / 卸载**。
 *
 * 为什么必须是装卸而非组件内显隐：`settings.plugins.tab` 的 tab 头由宿主按**注册账本**画出，
 * 组件返回 `null` 只会让内容空掉、tab 头照旧——用户看到的是一个点进去空白的选项卡。
 * 撤销 `ctx.slots.register` 的 disposer 才是让席位真正从宿主账本里消失的唯一途径。
 *
 * 为什么回调仍走 `ctx.slots.inject`：向未声明的 slot 直接 `register` 会抛
 * `slot "..." is not declared`（`ui-slots/src/index.ts`），而声明到达前本席不能注册。
 * 故注册动作一律写在 `inject` 的回调里（宿主在声明到达后才执行它），回调内部再自行
 * 订阅配置做装卸——`ctx.effect` 会把回调返回的清理函数挂进该次声明的 effect 生命周期。
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { behaviorVisible } from '@/client/model'
import type { Flags } from '@/client/model'
import type { DecodedScope } from '@/client/scope'
import { CARD_NS } from '@/client/locale-keys'
import { PLUGIN_NS as MODEL_FIX_NS } from '@/shared/constants'
import { ComposerChips, type ComposerProps } from '@/client/composer'
import { Card, type CardProps } from '@/client/card'

/** 受可见性开关支配的三个席位 */
type ManagedSlot = 'settings.models.footer' | 'settings.plugins.tab' | 'conversation.input.left'

/** 每个席位对应的 behavior 键 */
const SLOT_FLAG: Record<ManagedSlot, 'showInModels' | 'showInBuiltinPlugins' | 'showInComposer'> = {
    'settings.models.footer': 'showInModels',
    'settings.plugins.tab': 'showInBuiltinPlugins',
    'conversation.input.left': 'showInComposer',
}

/** 三席共用的卡片入参：scope / providersScope 由本函数补齐，其余字段逐席相同故只传一份 */
type SharedCardProps = Omit<CardProps, 't' | 'scope' | 'providersScope'>

/**
 * 挂上装卸编排：每个席位在声明到达后按开关决定挂不挂，之后每次配置变更重算。
 *
 * @param ctx - 父 fiber 的 ctx：注册与订阅都挂在它上面，fiber 卸载即级联撤销
 * @param scope - 本插件命名空间的 decode 后段视图（读 behavior 组的开关）
 * @param shared - 三席共用的卡片入参（六个写回出口）
 * @param composerProps - composer 席的入参（宿主 model-selection 段的 scope 等）
 */
export function applySlotVisibility(
    ctx: ClientContext,
    scope: DecodedScope<Flags>,
    shared: SharedCardProps,
    composerProps: Omit<ComposerProps, 'cardProps'>,
): void {
    const t = ctx.locale.bind(CARD_NS)
    const card = { ...shared, scope, providersScope: composerProps.providersScope }
    // 每个席位当前挂载着的 disposer；undefined 即当前未挂载（reconcile 的幂等依据）
    const mounted = new Map<ManagedSlot, (() => void) | undefined>()
    // 三席的注册动作；开关未开时一律不挂载
    const registrars: Record<ManagedSlot, () => () => void> = {
        'settings.models.footer': () => ctx.slots.register({
            name: 'settings.models.footer',
            id: MODEL_FIX_NS,
            // footer 以 order 排最前（list 渲染器按 order 单键重排）
            order: -999999,
            locale: CARD_NS,
        }, (props) => <Card {...card} {...props} />),
        'settings.plugins.tab': () => ctx.slots.register({
            name: 'settings.plugins.tab',
            id: MODEL_FIX_NS,
            order: 20,
            // tab label 走 thunk，section 每次读账本时求值、切语言即跟随
            label: () => t('tabLabel'),
            locale: CARD_NS,
        }, (props) => <Card {...card} defaultOpen {...props} />),
        'conversation.input.left': () => ctx.slots.register({
            name: 'conversation.input.left',
            id: `${MODEL_FIX_NS}-composer`,
            order: 5,
            locale: CARD_NS,
        }, (props) => <ComposerChips {...props} {...composerProps} cardProps={card} />),
    }

    /**
     * 目标态与已挂载态不一致才动：这是幂等的全部依据。
     * 只处理 `slot` 这一席，三席各由自己的 inject 回调驱动，互不干扰。
     */
    const reconcileOne = (slot: ManagedSlot): void => {
        const dispose = mounted.get(slot)
        if (behaviorVisible(scope.getSnapshot().value, SLOT_FLAG[slot])) {
            if (dispose === undefined) mounted.set(slot, registrars[slot]())
        } else if (dispose !== undefined) {
            dispose()
            mounted.set(slot, undefined)
        }
    }

    for (const slot of Object.keys(registrars) as ManagedSlot[]) {
        // 宿主在声明到达后执行本回调；返回的清理函数随该次声明的 effect 生命周期走，
        // 故 fiber 卸载或声明坍缩时，最后一次挂载的条目也会被撤销
        ctx.slots.inject(slot, () => {
            reconcileOne(slot)
            // subscribe 只推失效通知、不推首值，故上面已按当前快照补跑一遍
            const unsubscribe = scope.subscribe(() => { reconcileOne(slot) })
            return () => {
                unsubscribe()
                mounted.get(slot)?.()
                mounted.set(slot, undefined)
            }
        })
    }
}
