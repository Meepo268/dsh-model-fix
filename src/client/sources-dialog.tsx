/** 「参数来源」弹层（浏览器半）：列出每个模型当前的来源与可选项，让人工指定「用哪一家提供方的参数」。
 * 数据全由 Node 半算出（`src/source.ts` 的 `buildSourceSnapshot`），本层只渲染与回写；下拉变更即时落盘，
 * 随后的填充由 Node 半既有接线自动触发，本层只在回写成功后重新取一次快照。
 * 两个入口共用本弹层：插件卡片里的按钮（不传 `focusProvider`，看全部）与提供方卡片里的按钮
 * （传 `focusProvider`，默认只看本提供方）。模型一多就必须能搜、能滚，故列表体自带滚动与搜索框 */

import { useCallback, useEffect, useMemo, useState } from 'react'
// primitives 由宿主模块表注入
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { candidateSummary, fitLabel, snapshotOfResult, upstreamOptionLabel, type SourceModelView, type SourceSnapshot } from '@/shared/source-view'

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

/** 固定项（自动 / 只用上游声明）的文案：并上上游声明的能力摘要，便于和目录候选一眼对比 */
function fixedLabel(text: string, model: SourceModelView, t: Translate): string {
    return fitLabel(upstreamOptionLabel(text, model.upstream, t('sourceImageMark'), t('sourceNoUpstream')), 78)
}

/** 目录状况一句话：`目录：232 家 · 9008 个模型（磁盘缓存）`。空目录时把失败原因一并说出来——
 * 没有这一行，「目录是空」和「模型没匹配上」在界面上长得一模一样 */
function catalogLine(catalog: NonNullable<SourceSnapshot['catalog']>, t: Translate): string {
    if (catalog.source === 'empty') {
        return catalog.error === undefined
            ? t('sourceCatalogEmpty')
            : t('sourceCatalogError', { message: catalog.error })
    }
    const source = catalog.source === 'cache' ? t('sourceCatalogFromCache') : t('sourceCatalogFromNetwork')
    return t('sourceCatalogLine', {
        providers: String(catalog.providers),
        models: String(catalog.models),
        source,
    })
}

/** 搜索命中：模型 id、显示名、任一候选的来源键里有子串即可（空查询全中） */
function hits(model: SourceModelView, needle: string): boolean {
    if (needle === '') return true
    const haystack = [model.id, model.name ?? '', ...model.candidates.map((candidate) => `${candidate.provider}/${candidate.id}`)]
    return haystack.some((value) => value.toLowerCase().includes(needle))
}

interface SourcesDialogProps {
    t: Translate
    open: boolean
    onClose: () => void
    /** 取整份快照（Node 半 RPC） */
    sources: () => Promise<ConnectionRpcResult<unknown>>
    /** 写一个模型的来源（空串 = 回到自动） */
    setSource: (provider: string, model: string, source: string) => Promise<ConnectionRpcResult<unknown>>
    /** 刷新上游声明（清缓存重抓 + 按闸门补填）：不传则本弹层不显示该键（只读快照仍可用） */
    refreshDeclarations?: () => Promise<ConnectionRpcResult<unknown>>
    /** 拉取 models.dev 目录（清缓存重抓 + 落盘 + 补填）：「刷新数据」键的另一半，缺任一半则该键不显示 */
    fetchCatalog?: () => Promise<ConnectionRpcResult<unknown>>
    /** 从这里进来时只看这个提供方（提供方卡片上的入口）；缺省即看全部 */
    focusProvider?: string
}

/** 从 RPC 结果里认快照：失败信封或形状不符都按「空」处理，由弹层给一行错误 */
const snapshotOf = snapshotOfResult

export function SourcesDialog({
    t,
    open,
    onClose,
    sources: fetchSources,
    setSource: writeSource,
    refreshDeclarations,
    fetchCatalog,
    focusProvider,
}: SourcesDialogProps) {
    const [snap, setSnap] = useState<SourceSnapshot | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [refreshing, setRefreshing] = useState(false)
    const [refreshed, setRefreshed] = useState<string | null>(null)
    const [query, setQuery] = useState('')
    const [onlyFocus, setOnlyFocus] = useState(true)
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
    // 打开即取数（每次打开都重取，配置可能在别处改过）；搜索词、筛选与刷新提示每次打开复位
    useEffect(() => {
        if (!open) return
        setSnap(null)
        setError(null)
        setQuery('')
        setOnlyFocus(true)
        setRefreshed(null)
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
    // 刷新数据：一次点击取两路——目录（models.dev 数据本身）与上游声明（网关自报）。
    // 顺序不能反：目录是「按名字找参数」的底座，先取声明会拿旧目录去匹配，白抓一次。
    // 两路都只是重抓 + 按既有闸门补填（不覆盖手改值），随后重取快照让列表反映新数据
    const onRefresh = async () => {
        if (refreshDeclarations === undefined || fetchCatalog === undefined) return
        setRefreshing(true)
        setRefreshed(null)
        try {
            const catalog = await fetchCatalog()
            if (!catalog.ok) {
                setError(t('sourceFailed', { message: catalog.error.message }))
                return
            }
            const catalogValue = catalog.value as { providers?: number; models?: number } | undefined
            const result = await refreshDeclarations()
            if (!result.ok) {
                setError(t('sourceFailed', { message: result.error.message }))
                return
            }
            const value = result.value as { providers?: number; models?: number; changed?: number; throttled?: boolean } | undefined
            setError(null)
            if (value?.throttled === true) setRefreshed(t('sourceRefreshThrottled'))
            else {
                setRefreshed(t('sourceRefreshedCatalog', {
                    catalogProviders: String(catalogValue?.providers ?? 0),
                    catalogModels: String(catalogValue?.models ?? 0),
                    providers: String(value?.providers ?? 0),
                    models: String(value?.models ?? 0),
                    changed: String(value?.changed ?? 0),
                }))
            }
            await reload()
        } catch (failure) {
            setError(t('sourceFailed', { message: failure instanceof Error ? failure.message : String(failure) }))
        } finally {
            setRefreshing(false)
        }
    }
    // 提供方过滤 + 搜索：两件都是纯展示层筛选，不改快照本身。
    // 从提供方卡片进来时默认只看那一家；若那一家在快照里没有模型（席位落在官方适配器等无关卡片上），
    // 就不要把列表筛成空的——此时退化成「看全部」
    const groups = useMemo(() => {
        if (snap === null) return []
        const needle = query.trim().toLowerCase()
        const focusHasModels = snap.providers.some((provider) => provider.id === focusProvider && provider.models.length > 0)
        return snap.providers
            .filter((provider) => focusProvider === undefined || !onlyFocus || !focusHasModels || provider.id === focusProvider)
            .map((provider) => ({ id: provider.id, models: provider.models.filter((model) => hits(model, needle)) }))
            .filter((group) => group.models.length > 0)
    }, [snap, query, focusProvider, onlyFocus])
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
            <div className="dsh-mf-sourceTools">
                <input
                    className="dsh-mf-sourceSearch"
                    type="search"
                    value={query}
                    placeholder={t('sourceSearch')}
                    aria-label={t('sourceSearch')}
                    onChange={(event) => { setQuery(event.target.value) }}
                />
                {focusProvider === undefined ? null : (
                    <label className="dsh-mf-sourceOnly">
                        <input
                            type="checkbox"
                            checked={onlyFocus}
                            onChange={() => { setOnlyFocus((previous) => !previous) }}
                        />
                        {t('sourceOnlyProvider')}
                    </label>
                )}
                {refreshDeclarations === undefined || fetchCatalog === undefined ? null : (
                    <Button
                        variant="outline"
                        title={t('sourceRefreshHint')}
                        disabled={busy || refreshing}
                        onClick={() => { void onRefresh() }}
                    >
                        {refreshing ? t('sourceRefreshBusy') : t('sourceRefresh')}
                    </Button>
                )}
            </div>
            {snap?.catalog === undefined ? null : (
                <p className={`dsh-mf-sourceHint${snap.catalog.source === 'empty' ? ' dsh-mf-sourceWarn' : ''}`}>
                    {catalogLine(snap.catalog, t)}
                </p>
            )}
            {refreshed === null ? null : <p className="dsh-mf-sourceHint">{refreshed}</p>}
            <div className="dsh-mf-sourceBody">
                {snap === null
                    ? (busy ? null : <p className="dsh-mf-sourceEmpty">{t('sourceEmpty')}</p>)
                    : groups.length === 0
                        ? <p className="dsh-mf-sourceEmpty">{snap.providers.length === 0 ? t('sourceEmpty') : t('sourceNoMatch')}</p>
                        : groups.map((provider) => (
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
                                            <option value="">{fixedLabel(t('sourceAuto'), model, t)}</option>
                                            <option value="upstream">{fixedLabel(t('sourceUpstreamOnly'), model, t)}</option>
                                            {model.candidates.map((candidate) => {
                                                // 一行里给全判断依据：提供方 · 目录 id · 能力摘要（容量/档位/图片）
                                                const summary = candidateSummary(candidate.fields, t('sourceImageMark'))
                                                const extra = candidate.also === undefined ? '' : ` (+${candidate.also})`
                                                const label = `${candidate.provider} · ${candidate.id}${summary === '' ? '' : ` · ${summary}`}${extra}`
                                                return <option key={candidate.key} value={candidate.key}>{fitLabel(label, 78)}</option>
                                            })}
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
                                        {model.source === 'none' ? (
                                            <p className="dsh-mf-sourceHint dsh-mf-sourceWarn">{t('sourceUnmatchedHint')}</p>
                                        ) : null}
                                    </div>
                                ))}
                            </section>
                        ))}
            </div>
        </Modal>
    )
}
