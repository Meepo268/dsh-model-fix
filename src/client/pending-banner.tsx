/** 模型上新提示条：卡片正文顶部的一行，勾选要上线的模型后点「一键上线」。
 *  未勾选的视为不需要——同一批里自动记为已知，此后不再提示（等价于逐个「忽略」）。
 *  非对话模型（图像 / 视频）只点名，不参与上线：上游清单能列出来不等于本地能跑。 */
import { useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PendingMap } from '@/shared/types'

/** 一条待上线的模型（provider 与 id 一起构成定位，kind 决定能否上线） */
interface PendingRow {
    provider: string
    model: string
    kind: string
}

export interface PendingBannerProps {
    t: TranslateNS<'settings.modelFix'>
    pending: PendingMap
    /** 写操作互斥：正在保存/更新时禁用 */
    disabled: boolean
    onAdopt: (picked: readonly { provider: string; model: string }[]) => Promise<void>
}

/** 把 pending 摊平成行（提供方顺序即配置顺序） */
function rowsOf(pending: PendingMap): PendingRow[] {
    return Object.entries(pending).flatMap(([provider, entries]) =>
        Object.entries(entries).map(([model, entry]) => ({ provider, model, kind: entry.kind })),
    )
}

const rowKey = (row: PendingRow): string => `${row.provider}/${row.model}`

export function PendingBanner(props: PendingBannerProps): ReactNode {
    const { t, pending, disabled } = props
    const [busy, setBusy] = useState(false)
    const [picked, setPicked] = useState<Record<string, boolean>>({})
    const rows = rowsOf(pending)
    if (rows.length === 0) return null
    const chat = rows.filter((row) => row.kind === 'chat')
    const others = rows.filter((row) => row.kind !== 'chat')
    const selected = chat.filter((row) => picked[rowKey(row)] === true)
    const toggle = (row: PendingRow): void => {
        setPicked((prev) => ({ ...prev, [rowKey(row)]: prev[rowKey(row)] !== true }))
    }
    const run = async (task: () => Promise<void>): Promise<void> => {
        setBusy(true)
        try {
            await task()
        } finally {
            setBusy(false)
        }
    }
    return (
        <div className="dsh-mf-notice dsh-mf-noticeSuccess" role="status" aria-live="polite">
            <p className="dsh-mf-line">{t('pendingTitle')}</p>
            {chat.length > 0 ? (
                <>
                    <p className="dsh-mf-line">
                        {chat.map((row) => (
                            <label key={rowKey(row)} style={{ marginRight: 10, whiteSpace: 'nowrap' }}>
                                <input
                                    type="checkbox"
                                    checked={picked[rowKey(row)] === true}
                                    disabled={disabled || busy}
                                    onChange={() => { toggle(row) }}
                                />
                                {` ${row.model}`}
                            </label>
                        ))}
                    </p>
                    <p className="dsh-mf-line" style={{ opacity: 0.75 }}>
                        {t('pendingHint')}
                    </p>
                    <span className="dsh-mf-actions">
                        <button
                            type="button"
                            className="dsh-mf-save"
                            disabled={disabled || busy || selected.length === 0}
                            onClick={() => { void run(() => props.onAdopt(selected)) }}
                        >
                            {`${t('pendingAdopt')}（${selected.length}）`}
                        </button>
                    </span>
                </>
            ) : null}
            {others.length > 0 ? (
                <p className="dsh-mf-line dsh-mf-warn">{`${t('pendingNonChat')} ${others.map((row) => row.model).join('、')}`}</p>
            ) : null}
        </div>
    )
}
