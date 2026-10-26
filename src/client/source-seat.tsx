/** 提供方卡片里的「参数来源」入口（浏览器半）：挂在宿主 `settings.models.provider-card` 席位，
 * 位置就在这张卡片的「添加模型」附近——模型一多，把入口藏在插件卡片底部就找不到了，故每张提供方卡片各给一枚。
 * 提供方 id 取自席位的 owner props（`provider.provider`）；拿不到时退回注册键（个别适配器把 settingsNs 设成提供方 id）。
 * 入口旁还标出「N 个模型未命中」：自动来源两路皆空时，这里是最先能看到的地方。
 * 弹层复用 SourcesDialog，传 `focusProvider` 让它默认只看本提供方；按钮与文案随宿主席位注入的 t 跟随界面语言 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
// primitives 由宿主模块表注入
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcCarrier } from '@/client/rpc-carrier'
import { ensureStyles } from '@/client/card-styles'
import { SourcesDialog } from '@/client/sources-dialog'
import { snapshotOfResult, unmatchedCount, type SourceSnapshot } from '@/shared/source-view'

const { Button } = primitives

/** 席位的 owner props：`renderSlot(..., { provider: row.entry, configured, keyConfigured })`，只取提供方 id 用 */
interface SeatOwnerProps {
    provider?: { provider?: unknown }
}

export interface SourceSeatProps extends SeatOwnerProps, Pick<RpcCarrier, 'sources' | 'setSource'> {
    t: TranslateNS<'settings.modelFix'>
    /** 注册用的键：席位定向分发到 `settingsNs`，自定义提供方全都指向 `llm-pi-ai`，故只作兜底 */
    fallbackProvider: string
}

/** 从 owner props 里取提供方 id：`provider.provider` 是字符串才认，取不到退回注册键 */
function providerIdOf(props: SeatOwnerProps, fallback: string): string {
    const provider = props.provider
    const id = provider !== undefined && typeof provider === 'object' ? provider.provider : undefined
    return typeof id === 'string' && id !== '' ? id : fallback
}

/** 快照缓存：同一页里每张提供方卡片各挂一枚入口，各取一次就是 N 次同样的抓取（要读整份配置 + 目录 + 声明），
 * 故共用一份「在途去重 + 15 秒新鲜」的缓存；弹层关掉时强制重取一次，pin 改了数字立刻跟上 */
const SNAPSHOT_TTL_MS = 15_000
let cached: { at: number; value: SourceSnapshot | undefined } | null = null
let inflight: Promise<SourceSnapshot | undefined> | null = null

/** 取一次快照（失败按「无快照」处理：徽标不显示，异常留给弹层自己报） */
function loadSnapshot(
    fetchSources: () => Promise<ConnectionRpcResult<unknown>>,
    force = false,
): Promise<SourceSnapshot | undefined> {
    const now = Date.now()
    if (!force && cached !== null && now - cached.at < SNAPSHOT_TTL_MS) return Promise.resolve(cached.value)
    if (!force && inflight !== null) return inflight
    const pending = fetchSources()
        .then((result) => snapshotOfResult(result))
        .catch(() => undefined)
        .then((value) => {
            cached = { at: Date.now(), value }
            inflight = null
            return value
        })
    inflight = pending
    return pending
}

export function SourceSeat(props: SourceSeatProps) {
    const { t, fallbackProvider, sources, setSource } = props
    // 与卡片同源的样式表：席位可能先于卡片挂载，故这里也挂一次（ensureStyles 幂等）
    useLayoutEffect(() => { ensureStyles() }, [])
    const [open, setOpen] = useState(false)
    // `null` = 还没取到（不显示徽标），0 也当作不显示
    const [unmatched, setUnmatched] = useState<number | null>(null)
    const providerId = useMemo(() => providerIdOf(props, fallbackProvider), [props, fallbackProvider])
    const refresh = useCallback((force: boolean): void => {
        void loadSnapshot(sources, force).then((snapshot) => {
            setUnmatched(snapshot === undefined ? null : unmatchedCount(snapshot, providerId))
        })
    }, [sources, providerId])
    useEffect(() => { refresh(false) }, [refresh])
    return (
        <div className="dsh-mf-sourceSeat">
            <Button variant="outline" title={t('sourceSeatHint')} onClick={() => { setOpen(true) }}>
                {t('sourceSeat')}
            </Button>
            {unmatched === null || unmatched === 0 ? null : (
                <span className="dsh-mf-sourceSeatBadge" title={t('sourceSeatUnmatchedHint')}>
                    {t('sourceSeatUnmatched', { n: String(unmatched) })}
                </span>
            )}
            <span className="dsh-mf-sourceSeatHint">{t('sourceSeatHint')}</span>
            <SourcesDialog
                t={t}
                open={open}
                onClose={() => {
                    setOpen(false)
                    refresh(true)
                }}
                sources={sources}
                setSource={setSource}
                focusProvider={providerId}
            />
        </div>
    )
}
