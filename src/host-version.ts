/** 宿主版本（Node 半）：经 `pluginPackages` 读 app-boot 的 package.json 版本号。服务面按契约复制，见 docs/host/imports.md */

import type { Context } from '@deepseek-ai/cordis'
import { hostHidesOfficialSince } from '@/shared/version'

const HOST_VERSION_PACKAGE = '@deepseek-ai/dsh-app-boot'

interface HostPluginPackages {
    packageOf: (specifier: string, parentURL: string) => { readonly version: string | undefined } | undefined
}

/** 读宿主版本号；服务缺席或读不到返回 undefined */
export function hostVersionNow(ctx: Context): string | undefined {
    const packages = ctx.get('pluginPackages') as HostPluginPackages | undefined
    if (packages === undefined) return undefined
    try {
        const version = packages.packageOf(HOST_VERSION_PACKAGE, ctx.baseUrl ?? import.meta.url)?.version
        return typeof version === 'string' && version.length > 0 ? version : undefined
    } catch {
        return undefined
    }
}

/** 宿主是否已自带隐藏；版本未知返回 false（不空转） */
export function hostHidesOfficialNow(ctx: Context): boolean {
    return hostHidesOfficialSince(hostVersionNow(ctx))
}
