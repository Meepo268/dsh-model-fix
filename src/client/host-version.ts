/** 宿主版本（浏览器半）：读 `window.__DSH_BOOT__.release.version`，用于给「隐藏官方API」标注宿主已自带 */

import { hostHidesOfficialSince } from '@/shared/version'
import { isPlainObject } from '@/shared/types'

/** 读宿主版本号；`release` 缺席或 `version` 非法返回 undefined */
export function hostVersionNow(): string | undefined {
    const boot: unknown = Reflect.get(globalThis, '__DSH_BOOT__')
    if (!isPlainObject(boot)) return undefined
    const release: unknown = boot.release
    if (!isPlainObject(release)) return undefined
    const version = release.version
    return typeof version === 'string' && version.length > 0 ? version : undefined
}

/** 宿主是否已自带隐藏；版本未知返回 false（不空转） */
export function hostHidesOfficialNow(): boolean {
    return hostHidesOfficialSince(hostVersionNow())
}
