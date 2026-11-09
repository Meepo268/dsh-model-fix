import { appendFile, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getConfig } from '@/config'
import { CACHE_FILE } from '@/constants'

/** 运行期日志文件（与缓存同目录）：`lib/model-fix.log`。
 * 存在的理由：宿主不写运行期日志（只有崩溃日志），插件的 `ctx.logger.warn` 落到终端里也就没了——
 * 于是「启动链静默死掉」这类故障连自查入口都没有。这里落一份有上限的文件日志，出问题时直接读它 */
export const LOG_FILE = join(dirname(CACHE_FILE), 'model-fix.log')

/** 上限：超过即把当前文件轮转成 `.1`（只留一代），避免无限增长 */
const LOG_MAX_BYTES = 128 * 1024

/** 开关：读实时配置（`debugLog`，默认关）。用户在卡片里一开就生效，不必重启——
 * 日志只在排查时有用，默认写文件等于给每次启动留一份没人看的副本 */
export function logEnabled(): boolean {
    return getConfig().debugLog === true
}

/** 串行队列：日志行顺序不依赖调用方的并发关系，写入也不会互相截断 */
let pending: Promise<void> = Promise.resolve()

/**
 * 追加一行（UTC ISO 时间戳）：fire-and-forget，永不抛错、永不阻塞调用方。
 * 这一条比日志内容本身重要——写日志失败（只读安装目录、磁盘满）绝不能反过来改变插件行为。
 * 开关关着时直接返回，连 stat 都不做。
 */
export function logLine(message: string): void {
    if (!logEnabled()) return
    pending = pending.then(async () => {
        try {
            const existing = await stat(LOG_FILE).catch(() => undefined)
            if (existing !== undefined && existing.size > LOG_MAX_BYTES) {
                await rename(LOG_FILE, `${LOG_FILE}.1`).catch(() => {})
            }
            await appendFile(LOG_FILE, `${new Date().toISOString()} ${message}\n`)
        } catch {
            // 日志写不进去就算了，不升级成故障
        }
    })
}
