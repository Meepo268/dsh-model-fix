/** 「参数来源」弹层（浏览器半）：列出每个模型当前的来源与可选项，让人工指定「用哪一家提供方的参数」。
 * 数据全由 Node 半算出（`src/source.ts` 的 `buildSourceSnapshot`），本层只渲染与回写；下拉变更即时落盘，
 * 随后的填充由 Node 半既有接线自动触发，本层只在回写成功后重新取一次快照 */

import { useCallback, useEffect, useState } from 'react'
// primitives 由宿主模块表注入
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type { SourceModelView, SourceSnapshot } from '@/shared/source-view'

const { Button, Modal } = primitives

/** 与卡片同形的文案面 */
type Translate = TranslateNS<'settings.modelFix'>

/** 来源一句话描述：`high / max · 1000000 / 128000 · 图片`（缺项跳过） */
function describeFields(fields: SourceModelView['current'], t: Translate): string {
    const parts: string[] = []
    if (fields.efforts !== '') parts.push(fields.efforts)
    const capacity = [fields.contextWindow, fields.maxTokens].filter((value) => value !== undefined)
    if (capacity.length > 0) parts.push(capacity.join(' / '))
    if (fields.image) parts.push(t('sourceImage'))
    return parts.join(' · ')
}

/** 当前生效来源的展示文案 */
function describeSource(model: SourceModelView, t: Translate): string {
    if (model.source === 'upstream') return t('sourceUpstreamLabel')
    if (model.source === 'catalog') return model.matchedKey ?? t('sourceCatalogLabel')
    return t('sourceNone')
}

interface SourcesDialogProps {
    t: Translate
    open: boolean
    onClose: () => void
    /** 取整份快照（Node 半 RPC） */
    sources: () => Promise<ConnectionRpcResult<unknown>>
    /** 写一个模型的来源（空串 = 回到自动） */
    setSource: (provider: string, model: string, source: string) => Promise<ConnectionRpcResult<unknown>>
}

/** 从 RPC 结果里认快照：失败信封或形状不符都按「空」处理，由弹层给一行错误 */
function snapshotOf(result: ConnectionRpcResult<unknown>): SourceSnapshot | undefined {
    if (!result.ok) return
    const value = result.value
    if (typeof value !== 'object' || value === null) return
    const providers = (value as { providers?: unknown }).providers
    if (!Array.isArray(providers)) return
    return value as SourceSnapshot
}

export function SourcesDialog({ t, open, onClose, sources: fetchSources, setSource: writeSource }: SourcesDialogProps) {
    const [snap, setSnap] = useState<SourceSnapshot | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    /** 重新取数：弹层打开时、以及每次回写成功后各来一次 */
    const reload = useCallback(async () => {
        setBusy(true)
        try {
            const result = await fetchSources()
            const next = snapshotOf(result)
            if (!next) {
                setError(t('sourceFailed', { message: result.ok ? t('sourceEmpty') : result.error.message }))
                return
            }
            setSnap(next)
            setError(null)
        } catch (failure) {
            setError(t('sourceFailed', { message: failure instanceof Error ? failure.message : String(failure) }))
        } finally {
            setBusy(false)
        }
    }, [fetchSources, t])
    // 打开即取数（每次打开都重取，配置可能在别处改过）
    useEffect(() => {
        if (!open) return
        setSnap(null)
        setError(null)
        void reload()
    }, [open, reload])
    const onChange = async (provider: string, model: string, source: string) => {
        setBusy(true)
        try {
            const result = await writeSource(provider, model, source)
            if (!result.ok) {
                setError(t('sourceFailed', { message: result.error.message }))
                return
            }
            setError(null)
            await reload()
        } catch (failure) {
            setError(t('sourceFailed', { message: failure instanceof Error ? failure.message : String(failure) }))
        } finally {
            setBusy(false)
        }
    }
    return (
        <Modal
            open={open}
            onClose={onClose}
            title={t('sourceTitle')}
            closeLabel={t('close')}
            description={t('sourceDesc')}
            className="dsh-mf-verifyDialog"
            footer={<Button variant="outline" data-modal-autofocus onClick={onClose}>{t('close')}</Button>}
        >
            {error !== null ? <p className="dsh-mf-sourceError">{error}</p> : null}
            {snap === null
                ? (busy ? null : <p className="dsh-mf-sourceEmpty">{t('sourceEmpty')}</p>)
                : snap.providers.map((provider) => (
                    <section key={provider.id} className="dsh-mf-sourceGroup">
                        <h4 className="dsh-mf-sourceGroupName">{provider.id}</h4>
                        {provider.models.map((model) => (
                            <div key={model.id} className="dsh-mf-sourceRow">
                                <div className="dsh-mf-sourceHead">
                                    <span className="dsh-mf-sourceName">{model.name ?? model.id}</span>
                                    <span className="dsh-mf-sourceId">{model.id}</span>
                                </div>
                                <select
                                    className="dsh-mf-sourceSelect"
                                    value={model.pin}
                                    disabled={busy}
                                    onChange={(event) => { void onChange(provider.id, model.id, event.target.value) }}
                                >
                                    <option value="">{t('sourceAuto')}</option>
                                    <option value="upstream">{t('sourceUpstreamOnly')}</option>
                                    {model.candidates.map((candidate) => (
                                        <option key={candidate.key} value={candidate.key}>{candidate.provider} · {candidate.id}</option>
                                    ))}
                                </select>
                                <p className="dsh-mf-sourceHint">
                                    {t('sourceNow', { label: describeSource(model, t) })}
                                    {model.excluded ? ` ${t('sourceExcluded')}` : null}
                                </p>
                                {model.upstream === undefined ? null : (
                                    <p className="dsh-mf-sourceHint">
                                        {t('sourceUpstreamLabel')}：{describeFields(model.upstream, t)}
                                    </p>
                                )}
                                <p className="dsh-mf-sourceHint">{t('sourceCurrent')}：{describeFields(model.current, t)}</p>
                            </div>
                        ))}
                    </section>
                ))}
        </Modal>
    )
}
