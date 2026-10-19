// Modal 与 Button 由宿主模块表注入
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

const { Button, Modal } = primitives

/** 一次操作的二次确认层：宿主 Modal + Button 原语。卡片里有四层同形的二次确认，差别只有标题、说明、两键文案、红 tint 语义与在途禁用，把这四处差异显式列成 props，比四份并排的 JSX 更容易看出它们本该一样。取消键标 `data-modal-autofocus`：焦点落在可安全退出的一侧（React autoFocus 会毁掉关闭后的回焦） */
export function ConfirmModal(props: {
    open: boolean
    onClose: () => void
    title: string
    description: string
    closeLabel: string
    cancelLabel: string
    confirmLabel: string
    onConfirm: () => void
    /** 确认键上红 tint：删除类操作用，不动用户已有数据的（恢复备份）不用 */
    danger?: boolean
    /** 在途时禁掉确认键，避免连点重入 */
    confirmDisabled?: boolean
}) {
    return (
        <Modal
            open={props.open}
            onClose={props.onClose}
            title={props.title}
            closeLabel={props.closeLabel}
            description={props.description}
            footer={<>
                <Button variant="outline" data-modal-autofocus onClick={props.onClose}>{props.cancelLabel}</Button>
                <Button
                    variant="outline"
                    className={props.danger ? 'dsh-mf-confirmDanger' : undefined}
                    disabled={props.confirmDisabled}
                    onClick={props.onConfirm}
                >
                    {props.confirmLabel}
                </Button>
            </>}
        />
    )
}
