/** 更新检查（浏览器半的纯逻辑层）：把 GitHub Release 的 JSON 收敛成「有没有新版」，并把版本比较、安装地址拼接、剪贴板写入从组件里剥出来，好单测。
 *
 * 三条约束决定了这里的形状：
 * - 只读 `releases/latest`：GitHub 对浏览器开放 CORS，匿名限流 60 次/小时/IP，故只在用户点「检查更新」时才请求，不做轮询、不做启动自检；
 * - 任何失败（超时、非 2xx、JSON 不合规、网络异常）一律收敛成 `null`，由调用方降级成「打开 Releases 页」——检查更新坏掉不能连累卡片其它部分；
 * - 安装地址必须是**构建产物 tarball**（`pnpm pack` 的产出），不是仓库地址：仓库里 `lib/` 被 .gitignore 排除，装源码会加载失败；
 * - 安装地址默认带镜像前缀：直连 github.com 在国内常被静默丢包（宿主内的 pnpm 又不读系统代理，HEAD 直接 ETIMEDOUT），
 *   实测带 `https://ghfast.top/` 前缀的地址能被宿主安装器一次装上；把 `MIRROR_PREFIX` 置空即回到直连。
 */

import { compareHostVersion, parseHostVersion } from '@/shared/version'

const REPO_URL = 'https://github.com/Meepo268/dsh-model-fix'

/** 最新 Release 的公开查询口（无需 token） */
export const RELEASES_API = 'https://api.github.com/repos/Meepo268/dsh-model-fix/releases/latest'

/** 查不到最新版时的降级去处：整个 Releases 列表，用户可自行挑版本下载 */
export const RELEASES_PAGE = `${REPO_URL}/releases`

/** Release 资产名：CI 用 `pnpm pack --out="dist/%s.tgz"`，`%s` 是包名，故资产名恒为 `dsh-model-fix.tgz` */
const ASSET_NAME = 'dsh-model-fix.tgz'

/** 查询超时：GitHub 在国内偶尔要几秒，8 秒足够且不至于让按钮转太久 */
const TIMEOUT_MS = 8000

/** 一次检查的结果：标签、去掉 v 的版本、Release 页、tarball 安装地址、说明正文 */
export interface ReleaseInfo {
    readonly tag: string
    readonly version: string
    readonly pageUrl: string
    readonly installUrl: string
    readonly notes: string
}

/** 加速前缀：原样把完整 URL 挂在镜像域名后面（`https://ghfast.top/https://github.com/...`）。
 * 换成别的镜像只改这一行；置空串即回到直连——镜像只是「连不上 GitHub 时的路」，不是信任转移。 */
const MIRROR_PREFIX = 'https://ghfast.top/'

/** 直连地址（不含镜像前缀）：文档、排查、以及想绕开第三方镜像时用 */
export function directInstallUrlOf(tag: string): string {
    return `${REPO_URL}/releases/download/${tag}/${ASSET_NAME}`
}

/** 钉住 tag 的 tarball 地址（带镜像前缀），复制给宿主的「添加插件」用；
 * 不复用 `releases/latest/download`：那个地址不可复现（同一 URL 不同时间可能是不同字节） */
export function installUrlOf(tag: string): string {
    return `${MIRROR_PREFIX}${directInstallUrlOf(tag)}`
}

/** 去掉标签上常见的 `v` 前缀；比较器只认 `a.b.c[-alpha|rc.N]` */
export function versionOfTag(tag: string): string {
    return tag.trim().replace(/^v/i, '')
}

/** 比较两个版本（允许带 v 前缀）：左侧更新返回正数、相同返回 0、任一侧非法返回 undefined */
export function compareVersions(a: string, b: string): number | undefined {
    return compareHostVersion(versionOfTag(a), versionOfTag(b))
}

/** Release JSON → 结果；字段缺失或版本不可解析返回 null（GitHub 也可能回 rate-limit 的 JSON） */
export function parseRelease(payload: unknown): ReleaseInfo | null {
    if (payload === null || typeof payload !== 'object') return null
    const raw = payload as { tag_name?: unknown; html_url?: unknown; body?: unknown }
    if (typeof raw.tag_name !== 'string') return null
    const tag = raw.tag_name.trim()
    if (tag === '') return null
    const version = versionOfTag(tag)
    if (parseHostVersion(version) === undefined) return null
    const pageUrl = typeof raw.html_url === 'string' && raw.html_url !== ''
        ? raw.html_url
        : `${RELEASES_PAGE}/tag/${tag}`
    return {
        tag,
        version,
        pageUrl,
        installUrl: installUrlOf(tag),
        notes: typeof raw.body === 'string' ? raw.body.trim() : '',
    }
}

/** 查一次最新 Release；调用方只关心「拿到」还是「没拿到」 */
export async function fetchLatestRelease(options: {
    readonly fetcher?: typeof fetch
    readonly timeoutMs?: number
} = {}): Promise<ReleaseInfo | null> {
    const fetcher = options.fetcher ?? (typeof fetch === 'function' ? fetch : undefined)
    if (fetcher === undefined) return null
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    const timer = controller === undefined
        ? undefined
        : setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS)
    try {
        const response = await fetcher(RELEASES_API, {
            headers: { accept: 'application/vnd.github+json' },
            signal: controller?.signal,
        })
        if (!response.ok) return null
        return parseRelease(await response.json())
    } catch {
        return null
    } finally {
        if (timer !== undefined) clearTimeout(timer)
    }
}

/** 写剪贴板：优先 Clipboard API；宿主 webview 不给权限时退回临时 textarea（`execCommand` 仍是最广的兜底） */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
            await navigator.clipboard.writeText(text)
            return true
        }
    } catch { /* 落到下面的兜底 */ }
    try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const copied = document.execCommand('copy')
        document.body.removeChild(area)
        return copied
    } catch {
        return false
    }
}
