/**
 * 卡片内联状态行与操作互斥的助手（浏览器半）：`Notice` 形状、全卡共用的占用态 `CardBusy`、
 * 超长文案截断与写回超时判定。
 */

/** 全部写操作共用的单一互斥标志：一者 in-flight 时其余入口与按钮全禁 */
export type CardBusy = 'save' | 'force' | 'reset' | 'restore' | 'clear' | 'verify' | 'probe' | 'prune' | null

/** 内联状态行：文本 + 色调（成功＝官方 .savedNotice 绿，失败＝.error 红） */
export interface Notice {
    text: string
    tone: 'success' | 'error'
}

/** 状态行文案的截断上限（字符）：RPC 与异常消息可能极长（含 URL、响应片段），截断以保持可读 */
const NOTICE_MAX_CHARS = 120

/** 截断失败信息：超长即截到上限并补省略号 */
export function truncateMessage(value: string): string {
    return value.length > NOTICE_MAX_CHARS ? `${value.slice(0, NOTICE_MAX_CHARS - 1)}…` : value
}

/** 写回超时不是失败原因而是「没等到结果」，状态行另给中文；`DOMException` 不继承 `Error`，不能按 `Error` 判 */
export function isWritebackTimeout(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'TimeoutError'
}
