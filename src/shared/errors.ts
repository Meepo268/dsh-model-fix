/**
 * 异常通用辅助：跨半共享。Node 半记日志 + settings 冲突重试；浏览器半把失败原因
 * 写进弹层记录区，记忆写入同样走 settings mutate + 冲突重试。
 */

/** 取异常展示文案：Error 取 message，其余退化为 String(error) */
export function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * 宿主 settings 写回 revision 冲突判定（跨半共享）：
 * Node 半 ctx.settings.mutate 与浏览器半 ConfigForm.mutate 在 expectedRevision 不符时
 * 统一抛 code='SETTINGS_CONFLICT'；Node 半各写回端点与浏览器半记忆写入据此重试。
 */
export function isSettingsConflict(error: unknown): boolean {
    return (error as { code?: unknown })?.code === 'SETTINGS_CONFLICT'
}
