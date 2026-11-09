/** 提供方卡片里的「参数来源」入口（浏览器半）：挂在宿主 `settings.models.provider-card` 席位，
 * 位置就在这张卡片的「添加模型」附近——模型一多，把入口藏在插件卡片底部就找不到了，故每张提供方卡片各给一枚。
 * 提供方 id 取自席位的 owner props（`provider.provider`）；拿不到时退回注册键（个别适配器把 settingsNs 设成提供方 id）。
 * 入口旁常驻一枚计数徽标「命中 m/t · 上游 u · 目录 c」（有漏时追加「· 未命中 n」）：
 * 有漏用琥珀、有上游自报用淡绿、全靠目录匹配用灰。徽标把总命中/两路来源/漏了几个都写在里面，
 * 于是原来跟在后面的那句说明「按模型指定用哪一路数据填参数」撤掉了——它和按钮 tooltip 重复，
 * 占的是同一行最宝贵的位置。徽标只在取不到快照（或整家在排除列表）时消失，别让它无声隐去，
 * 否则修好之后看起来又像坏了。
 * 弹层复用 SourcesDialog，传 `focusProvider` 让它默认只看本提供方；按钮与文案随宿主席位注入的 t 跟随界面语言 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
// primitives 由宿主模块表注入
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcCarrier } from '@/client/rpc-carrier'
import { ensureStyles } from '@/client/card-styles'
import { SourcesDialog } from '@/client/sources-dialog'
import { snapshotOfResult, seatCounts, type SeatCounts, type SourceSnapshot } from '@/shared/source-view'

const { Button } = primitives

/** 席位的 owner props：`renderSlot(..., { provider: row.entry, configured, keyConfigured })`，只取提供方 id 用 */
interface SeatOwnerProps {
    provider?: { provider?: unknown }
}

export interface SourceSeatProps extends SeatOwnerProps, Pick<RpcCarrier, 'sources' | 'setSource' | 'refreshDeclarations' | 'fetchCatalog'> {
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

/** 徽标的四种说法：有漏的说漏了几个与补救方式，全命中的按来源分「全上游 / 全目录 / 混合」。
 * 单路全中时不写「目录 0」那种空位——那一位空出来正好换成一句解释来源的话 */
function badgeOf(counts: SeatCounts, t: TranslateNS<'settings.modelFix'>): { text: string; tone: string; title: string } {
    const m = String(counts.matched)
    const total = String(counts.total)
    const u = String(counts.fromUpstream)
    const c = String(counts.fromCatalog)
    if (counts.unmatched > 0) {
        return { text: t('sourceSeatHitsMissed', { m, t: total, u, c, n: String(counts.unmatched) }), tone: '', title: t('sourceSeatUnmatchedHint') }
    }
    if (counts.fromCatalog === 0) {
        return { text: t('sourceSeatHitsDeclared', { m, t: total }), tone: ' dsh-mf-sourceSeatBadgeOk', title: t('sourceSeatSplitDeclaredHint') }
    }
    if (counts.fromUpstream === 0) {
        return { text: t('sourceSeatHitsCatalog', { m, t: total }), tone: ' dsh-mf-sourceSeatBadgeDim', title: t('sourceSeatSplitCatalogHint') }
    }
    return {
        text: t('sourceSeatHitsMixed', { m, t: total, u, c }),
        tone: ' dsh-mf-sourceSeatBadgeOk',
        title: t('sourceSeatSplitDeclaredHint'),
    }
}

export function SourceSeat(props: SourceSeatProps) {
    const { t, fallbackProvider, sources, setSource, refreshDeclarations, fetchCatalog } = props
    // 与卡片同源的样式表：席位可能先于卡片挂载，故这里也挂一次（ensureStyles 幂等）
    useLayoutEffect(() => { ensureStyles() }, [])
    const [open, setOpen] = useState(false)
    // `null` = 还没取到（不画徽标）；取到后两种状态各说一句话：有漏的报未命中数，没漏的报已命中数
    const [counts, setCounts] = useState<SeatCounts | null>(null)
    const providerId = useMemo(() => providerIdOf(props, fallbackProvider), [props, fallbackProvider])
    const refresh = useCallback((force: boolean): void => {
        void loadSnapshot(sources, force).then((snapshot) => {
            // `seatCounts` 的 `undefined`（不在快照里 / 空模型表 / 整家在排除列表）与初始态同义：都不画徽标
            setCounts(seatCounts(snapshot, providerId) ?? null)
        })
    }, [sources, providerId])
    useEffect(() => { refresh(false) }, [refresh])
    return (
        <div className="dsh-mf-sourceSeat">
            <Button variant="outline" title={t('sourceSeatHint')} onClick={() => { setOpen(true) }}>
                {t('sourceSeat')}
            </Button>
            {counts === null ? null : (
                <span className={`dsh-mf-sourceSeatBadge${badgeOf(counts, t).tone}`} title={badgeOf(counts, t).title}>
                    {badgeOf(counts, t).text}
                </span>
            )}
            <SourcesDialog
                t={t}
                open={open}
                onClose={() => {
                    setOpen(false)
                    refresh(true)
                }}
                sources={sources}
                setSource={setSource}
                refreshDeclarations={refreshDeclarations}
                fetchCatalog={fetchCatalog}
                focusProvider={providerId}
            />
        </div>
    )
}
