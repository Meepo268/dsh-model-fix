/** 提供方卡片里的「参数来源」入口（浏览器半）：挂在宿主 `settings.models.provider-card` 席位，
 * 位置就在这张卡片的「添加模型」附近——模型一多，把入口藏在插件卡片底部就找不到了，故每张提供方卡片各给一枚。
 * 提供方 id 取自席位的 owner props（`provider.provider`）；拿不到时退回注册键（个别适配器把 settingsNs 设成提供方 id）。
 * 弹层复用 SourcesDialog，传 `focusProvider` 让它默认只看本提供方；按钮与文案随宿主席位注入的 t 跟随界面语言 */

import { useLayoutEffect, useMemo, useState } from 'react'
// primitives 由宿主模块表注入
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcCarrier } from '@/client/rpc-carrier'
import { ensureStyles } from '@/client/card-styles'
import { SourcesDialog } from '@/client/sources-dialog'

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

export function SourceSeat(props: SourceSeatProps) {
    const { t, fallbackProvider, sources, setSource } = props
    // 与卡片同源的样式表：席位可能先于卡片挂载，故这里也挂一次（ensureStyles 幂等）
    useLayoutEffect(() => { ensureStyles() }, [])
    const [open, setOpen] = useState(false)
    const providerId = useMemo(() => providerIdOf(props, fallbackProvider), [props, fallbackProvider])
    return (
        <div className="dsh-mf-sourceSeat">
            <Button variant="outline" title={t('sourceSeatHint')} onClick={() => { setOpen(true) }}>
                {t('sourceSeat')}
            </Button>
            <span className="dsh-mf-sourceSeatHint">{t('sourceSeatHint')}</span>
            <SourcesDialog
                t={t}
                open={open}
                onClose={() => { setOpen(false) }}
                sources={sources}
                setSource={setSource}
                focusProvider={providerId}
            />
        </div>
    )
}
