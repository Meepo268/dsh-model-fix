/** 输入框工具行（conversation.input.left）的两枚 chip，各占一个席位条目：
 * · 「模型优化」（`ComposerEntry`）—— 常驻弱化态入口，点开弹层面板（宿主 Modal 的 headless 形态）
 * · 「跟随」状态灯（`FollowLamp`）—— 随 `followingActive(flags, hostEnabled)` 在亮绿/浅灰间切换；点击即 toggle 开关，写入失败时保持原态 + 琥珀色 + 原生 title 提示原因
 * 宿主 list 席位按 `id` 记账（`id` 不同可并存），故两枚 chip 各注册一条、各受自己的 `behavior` 开关支配。渲染点只有一个（`InputBar` 一次画出全部条目）。配色/几何语义见 card-styles.ts */

import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { VERSION_KEY, followingActive, type Flags } from '@/client/model'
import { ensureStyles } from '@/client/card-styles'
import { Card, type CardProps } from '@/client/card'
import type { DecodedScope } from '@/client/scope'

/** 宿主「允许 Agent 为子智能体选择模型」那段的最小 decode：只取 enabled，不管 allowedModels（我们不调 current()） */
export interface HostModelSelectionView { enabled: boolean }

type ChipState = 'muted' | 'off' | 'on' | 'fail'

/** 宿主 subagent-model-selection-settings 段名（字面量与 host-api.md 登记一致） */
export const HOST_MODEL_SELECTION_NS = 'subagent-model-selection-settings'

/** decode：只读 enabled 一个布尔值。段读不到（CLI/TUI 组合、或宿主未装配那段）、非对象、enabled 不是 true → 一律视为「未开启」。不碰 allowedModels 与 current()——不在浏览器半复刻宿主那段「enabled + 空授权表抛错」的逻辑（Node 半 subagent.ts 里有 try/catch 兜底） */
export function decodeHostModelSelection(raw: unknown): HostModelSelectionView {
    return { enabled: raw !== null && typeof raw === 'object' && (raw as { enabled?: unknown }).enabled === true }
}

/** 两枚 chip 各自需要的入参（插槽自带的 PropsRuntime / PropsLocale 由渲染器注入，不在此声明） */
export interface ComposerProps {
    scope: DecodedScope<Flags>
    hostModelScope: DecodedScope<HostModelSelectionView>
    /** 宿主 llm-pi-ai 命名空间：只给弹层内的 Card 消费（与其余席同一份） */
    providersScope: DecodedScope<readonly unknown[]>
    /** 卡片入参（复用 Card 的 RpcCarrier 部分，不包含 t/scope/providersScope——这三个由插槽 t 与闭包 scope/providersScope 提供） */
    cardProps: Omit<CardProps, 't' | 'scope' | 'providersScope'>
}

/** 插槽 props 类型面：PropsRuntime<'conversation.input.left'> & PropsLocale<CARD_NS>（无 owner props） */
type SlotProps = PropsRuntime<'conversation.input.left'> & PropsLocale<'settings.modelFix'>

/** 「模型优化」入口 chip：点开弹层面板，承载完整配置卡。显隐由 `behavior.showInComposer` 决定（装卸在 visibility.ts） */
export function ComposerEntry(props: SlotProps & ComposerProps): ReactNode {
    const { t, scope, cardProps } = props
    const [open, setOpen] = useState(false)

    // 幂等注入样式：Card 可能还没渲染过，但 chip 已经常驻输入框里了
    useEffect(() => { ensureStyles() }, [])

    return (
        <>
            <button
                type="button"
                className="dsh-mf-composerChip"
                data-state="muted"
                title={t('chipModelOptTitle')}
                onClick={() => { setOpen(true) }}
            >
                {t('chipModelOpt')}
            </button>
            {open && (
                // headless：卡片直接作 children，不套宿主的标题栏/关闭钮/content/body 一层
                <Modal
                    open={open}
                    onClose={() => { setOpen(false) }}
                    title={t('title')}
                    headless
                    className="dsh-mf-composerDialog"
                >
                    <div className="dsh-mf-composerBody">
                        {/* defaultOpen：弹层内一进来就见全貌；collapsible={false}：面板尺寸固定可滚动，折叠会脱钩 */}
                        <Card {...cardProps} t={t} scope={scope} providersScope={props.providersScope} defaultOpen collapsible={false} />
                    </div>
                </Modal>
            )}
        </>
    )
}

/** 「跟随」状态灯：亮绿＝子智能体跟随父智能体正在生效，浅灰＝未生效；点击即 toggle `userExperience.followParent`。显隐由 `behavior.showFollowStatus` 决定（装卸在 visibility.ts） */
export function FollowLamp(props: SlotProps & ComposerProps): ReactNode {
    const { t, scope, hostModelScope } = props

    useEffect(() => { ensureStyles() }, [])

    // 两个 scope 的快照（useSyncExternalStore 在浏览器端可直接把 getSnapshot 当作 fallback，SSR 兜底不会触发）
    const snapFlags = useSyncExternalStore(scope.subscribe, scope.getSnapshot, scope.getSnapshot)
    const snapHost = useSyncExternalStore(hostModelScope.subscribe, hostModelScope.getSnapshot, hostModelScope.getSnapshot)

    // 「跟随实际生效」的判据：插件配置就绪 + 宿主设置未显式开启
    const flags = snapFlags.value
    const hostEnabled = snapHost.status === 'ready' ? snapHost.value?.enabled : undefined
    const active = flags !== undefined && followingActive(flags, hostEnabled)

    // 上一次切换写入是否失败：失败时压过亮/灰态走琥珀色（followState 取 'fail'）
    const [chipFail, setChipFail] = useState(false)
    // 写入中锁（防连点）
    const [busy, setBusy] = useState(false)

    const onToggle = useCallback(async () => {
        if (!snapFlags.writable || snapFlags.status !== 'ready' || flags === undefined) return
        if (busy) return
        setBusy(true)
        const target = !flags.userExperience.followParent
        try {
            const ok = await scope.mutate([{
                op: 'set',
                path: [VERSION_KEY, 'userExperience', 'followParent'],
                value: target,
            }])
            // 写后读回核对（与 Card onSave 同款纪律：不接受宿主裁决布尔，必须看实际落了什么）
            const latest = scope.getSnapshot()
            const landed = ok
                && latest.status === 'ready'
                && latest.value !== undefined
                && latest.value.userExperience.followParent === target
            setChipFail(!landed)
        } catch {
            setChipFail(true)
        } finally {
            setBusy(false)
        }
    }, [scope, snapFlags, flags, busy])

    const state: ChipState = chipFail ? 'fail' : (active ? 'on' : 'off')
    // 原生 title 随态切换：失败原因 / 关闭提示 / 开启提示
    const title = chipFail
        ? t('chipFollowFail')
        : active ? t('chipFollowOnTitle') : t('chipFollowOffTitle')

    return (
        <button
            type="button"
            className="dsh-mf-composerChip"
            data-state={state}
            title={title}
            disabled={!snapFlags.writable || snapFlags.status !== 'ready' || busy}
            onClick={onToggle}
        >
            {active ? t('chipFollowOn') : t('chipFollowOff')}
        </button>
    )
}
