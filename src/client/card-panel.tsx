/** 配置卡弹层面板：输入框 chip 与悬浮按钮共用同一张卡（宿主 Modal 的 headless 形态） */

import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Card, type CardProps } from '@/client/card'

export function CardPanel(props: {
    open: boolean
    onClose: () => void
    t: TranslateNS<'settings.modelFix'>
    cardProps: Omit<CardProps, 't'>
}): ReactNode {
    return (
        // headless：卡片直接作 children，不套宿主的标题栏/关闭钮/content/body 一层
        <Modal
            open={props.open}
            onClose={props.onClose}
            title={props.t('title')}
            headless
            className="dsh-mf-composerDialog"
        >
            <div className="dsh-mf-composerBody">
                {/* defaultOpen：弹层内一进来就见全貌；collapsible={false}：面板尺寸固定可滚动，折叠会脱钩 */}
                <Card {...props.cardProps} t={props.t} defaultOpen collapsible={false} />
            </div>
        </Modal>
    )
}
