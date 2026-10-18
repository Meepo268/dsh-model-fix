/**
 * 模型参数填充卡片（浏览器半）：复刻官方插件卡的可折叠卡片。五个挂载席位共用同一外壳，
 * 差异只有折叠态策略（`defaultOpen` 与保存后是否自动收起）与是否允许折叠（输入框弹层禁用）。
 *
 * 本文件只做**卡片外壳的编排**：草稿与保存、四个写回动作（强制更新 / 重置 / 恢复 / 剔除）、
 * 五层二次确认、瓦片与 footer 的渲染，以及验证 / 探测两个弹层的状态挂接——两条诊断链的整轮
 * 编排各自内聚在 `card-verify.ts` / `card-probe.ts`（弹层本体见 `verify-dialog.tsx` /
 * `probe-dialog.tsx`），记录区文案层在 `card-records.ts`，状态行助手在 `card-notice.ts`。
 *
 * 展开体为六张瓦片（顺序由 TILE_ORDER 单一分发），瓦片手风琴：默认收起、同时只开一个。
 * 编辑只改本地草稿，「保存」才经 settings scope 原子写当前版本快照键（efforts 取写入当刻实时值，
 * 卡片不拥有该字段）；草稿跨折叠存活。除验证外的操作结果一律走卡片内联状态行。
 *
 * 样式数值见 `card-styles.ts`，末尾联系行见 `card-meta.tsx`。行为细节见 docs/decisions.md「宿主与卡片」。
 */

import { useLayoutEffect, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
// primitives 由宿主模块表注入
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
// RPC 返回信封：写回结果的读取走 reportWriteback
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
// scope 类型来自本项目的 ConfigForm decode 包装层
import type { DecodedScope } from '@/client/scope'
import { ensureStyles } from '@/client/card-styles'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
    VERSION_KEY,
    addExclude,
    applyGroup,
    groupValue,
    isDirty,
    masterValue,
    providerIdsOf,
    removeExclude,
    resolveHits,
    toggleCell,
    verifyCandidatesOf,
} from '@/client/model'
import type { Flags, Group, RowKey } from '@/client/model'
import { ExcludesTile, GroupTile, TILE_ORDER } from '@/client/tile'
import { CardMeta } from '@/client/card-meta'
import { ConfirmModal } from '@/client/confirm'
import { VerifyDialog } from '@/client/verify-dialog'
import { ProbeDialog } from '@/client/probe-dialog'
import type { RpcCarrier } from '@/client/rpc-carrier'
import { errorText } from '@/shared/errors'
import type { UnsupportedEffort } from '@/shared/verify-progress'
import { DEFAULT_CONFIG, toStored } from '@/shared/config-schema'
import type { CardBusy, Notice } from '@/client/card-notice'
import { isWritebackTimeout, truncateMessage } from '@/client/card-notice'
import { useVerifyRun } from '@/client/card-verify'
import { useProbeRun } from '@/client/card-probe'

/** 瓦片 chevron：宿主 ui-primitives 导出的描边 chevron 图标 */
const CHEVRON_DOWN = primitives.IconChevronDownOutlineRegular
const { Tag } = primitives

/** 卡片组件 props（t 由 locale 席位合成注入；六个调 Node 半的方法取 `RpcCarrier` 调用面，语言上报不经过卡片故剔掉） */
export interface CardProps extends Omit<RpcCarrier, 'reportLocale'> {
    t: TranslateNS<'settings.modelFix'>
    scope: DecodedScope<Flags>
    /** 宿主 llm-pi-ai 命名空间：只取 snapshot.user 的提供方 id，判定排除项是否命中 */
    providersScope: DecodedScope<readonly unknown[]>
    /** 初始折叠态：插件详情页（plugins.bundle.config）、组件实例详情页（plugins.row.config）与「内置插件」选项卡（settings.plugins.tab）默认展开；模型页 footer 席不传即默认收起（与官方插件卡一致）。同时决定保存成功后是否自动收起——只在默认收起的席位上生效 */
    defaultOpen?: boolean
    /** 是否允许点 header 折叠整卡：详情席位与选项卡席皆可；输入框弹层传 false（面板尺寸固定、可滚动，折叠会让面板内容与指针下的尺寸脱钩） */
    collapsible?: boolean
}

/** 卡片主体 */
export function Card(props: CardProps) {
    useLayoutEffect(() => { ensureStyles() }, [])
    const scope = props.scope
    const { t } = props
    const snap = useSyncExternalStore(scope.subscribe, scope.getSnapshot, scope.getSnapshot)
    // 提供方 id 来源 scope：只消费其 user 层（宿主 describe mirror 保证快照引用稳定）
    const providersScope = props.providersScope
    const providersSnap = useSyncExternalStore(providersScope.subscribe, providersScope.getSnapshot, providersScope.getSnapshot)
    const providerIds = useMemo(
        () => providerIdsOf(providersSnap.status === 'ready' ? providersSnap.user : undefined),
        [providersSnap],
    )
    // 验证候选与提供方 id 同源（同一份 llm-pi-ai user 层），故列表里出现的正是 fix 会遍历的那些模型
    const verifyCandidates = useMemo(
        () => verifyCandidatesOf(providersSnap.status === 'ready' ? providersSnap.user : undefined),
        [providersSnap],
    )
    // draft === null 表示未编辑、跟随已存值；首次点击即冻结当前显示值为草稿
    const [draft, setDraft] = useState<Flags | null>(null)
    // 全部写操作共用单一互斥标志（形状见 card-notice.ts 的 CardBusy）
    const [busy, setBusy] = useState<CardBusy>(null)
    const collapsible = props.collapsible !== false
    // 折叠态为卡片本地状态（读姿而非配置）；草稿跨折叠存活
    const [open, setOpen] = useState(collapsible ? (props.defaultOpen ?? false) : true)
    // 保存后自动收起只对默认收起的席位有意义：默认展开的席位保存后保持展开，否则用户刚配完就被收起
    const autoCollapse = props.defaultOpen !== true
    // 瓦片折叠态：官方手风琴语义（同时只开一个、默认全收起）
    const [tileOpen, setTileOpen] = useState<string | null>(null)
    // 内联结果提示：常驻至下一次操作（官方 .savedNotice 无定时器，故不设自动淡出）
    const [notice, setNotice] = useState<Notice | null>(null)
    // 四层二次确认各控一个状态（执行态统一在 busy）：三个写回端点 + 清空记忆
    const [confirmOpen, setConfirmOpen] = useState(false)
    const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
    const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false)
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
    // 剔除确认的目标：验证明细里**明确**被判「档位不支持」的条目，由 Node 半直接给出，浏览器半不自己筛。
    // 中止 / 出错 / 无此类结论时保持空数组，空数组即不弹窗
    const [pruneTargets, setPruneTargets] = useState<readonly UnsupportedEffort[]>([])
    const saveStarted = useRef(false)

    const saved = snap.value
    const shown = draft ?? saved ?? DEFAULT_CONFIG
    const ready = snap.status === 'ready' && saved !== undefined
    const canWrite = ready && snap.writable === true
    const dirty = draft !== null && saved !== undefined && isDirty(draft, saved)
    // 命中集合按草稿算（编辑中即所见即所得）
    const hits = useMemo(() => resolveHits(shown.excludes, providerIds), [shown.excludes, providerIds])
    // 保存成功（保存结束且 dirty 归 false）后自动收起，仅限默认收起的席位；写失败保留草稿与展开态可重试
    useEffect(() => {
        if (busy === 'save') {
            saveStarted.current = true
            return
        }
        if (busy !== null) return
        if (!saveStarted.current) return
        saveStarted.current = false
        if (!dirty && autoCollapse) setOpen(false)
    }, [busy, dirty, autoCollapse])

    // 「验证模型」「探测式填充」的整轮编排内聚在 card-verify.ts / card-probe.ts；
    // hooks 必须在早退 return 之前调用
    const verify = useVerifyRun({
        t,
        busy,
        setBusy,
        candidates: verifyCandidates,
        verifyModels: props.verifyModels,
        onUnsupported: setPruneTargets,
    })
    const probe = useProbeRun({
        t,
        busy,
        setBusy,
        excludes: shown.excludes,
        user: providersSnap.status === 'ready' ? providersSnap.user : undefined,
        probeEfforts: props.probeEfforts,
        onNotice: setNotice,
    })
    // 五个动作键共用一个占用态：任一处在途或任一弹层开着，其余四个一并禁用
    const configLocked = busy !== null || verify.open || probe.open

    // 配置服务不可用：保留静态外壳（无展开语义）便于发现与排查
    if (snap.status === 'unavailable') {
        return (
            <div className="dsh-mf-card">
                <div className="dsh-mf-header dsh-mf-headerStatic">
                    <span className="dsh-mf-headText">
                        <span className="dsh-mf-name">{t('title')}</span>
                        <span className="dsh-mf-desc">{t('unavailable')}</span>
                    </span>
                </div>
            </div>
        )
    }

    /**
     * 四个写回动作的结果汇报同形：成功按条数出一句、失败取原因出一句、传输层 reject 与 `ok:false`
     * 走同一条展示路径、收尾一律清占用态，差异只有文案键，故收在一处。
     */
    const reportWriteback = (
        call: Promise<ConnectionRpcResult<unknown>>,
        ok: (count: number) => void,
        failed: (message: string) => void,
        settled?: () => void,
    ): void => {
        call.then((result) => {
            if (result.ok) {
                const value = result.value as { changed?: number; pruned?: number } | undefined
                ok(value?.changed ?? value?.pruned ?? 0)
            } else {
                failed(result.error.message)
            }
        })
            .catch((error: unknown) => {
                failed(isWritebackTimeout(error) ? t('writebackTimeout') : errorText(error))
            })
            .finally(() => {
                setBusy(null)
                settled?.()
            })
    }
    // 落草稿；「记住推理级别」由开转关且仍有记忆时立即弹确认。记忆判据取实时值（草稿不拥有 efforts）
    const commitDraft = (next: Flags) => {
        setDraft(next)
        if (
            groupValue(shown, 'userExperience', 'rememberEfforts') &&
            !groupValue(next, 'userExperience', 'rememberEfforts') &&
            Object.keys(snap.value?.efforts ?? {}).length > 0
        ) {
            setClearConfirmOpen(true)
        }
    }
    const onCell = (group: Group, key: RowKey) => {
        setNotice(null)
        commitDraft(toggleCell(shown, group, key))
    }
    // 整组总控：显示值取 masterValue（全开才显示开，部分选中显示关）；点击取反并把该组全部行设为同一值
    const onMaster = (group: Group) => {
        setNotice(null)
        commitDraft(applyGroup(shown, group, !masterValue(shown, group)))
    }
    // 瓦片折叠：官方 toggleRow 同语义——点已开者即收起，否则切到该瓦片
    const onTileToggle = (key: string) => {
        setTileOpen((prev) => (prev === key ? null : key))
    }
    // 排除列表的增删同样只改草稿（保存才落盘），与单格/总控一条路径
    const onAddExclude = (id: string) => {
        setNotice(null)
        setDraft(addExclude(shown, id))
    }
    const onRemoveExclude = (id: string) => {
        setNotice(null)
        setDraft(removeExclude(shown, id))
    }
    const onSave = () => {
        if (!canWrite || !dirty || busy) return
        setNotice(null)
        setBusy('save')
        // 写入成功由宿主回推新 value（dirty 自动归 false，触发自动收起）；失败由 scope 重读恢复，保持 dirty 可重试。
        // efforts 取写入当刻的实时值：卡片不拥有该字段，用草稿副本会覆盖「开卡后切过模型」的记忆
        const liveEfforts = scope.getSnapshot().value?.efforts
        void scope.set(VERSION_KEY, toStored({ ...shown, efforts: liveEfforts ?? shown.efforts }))
            .then(() => {
                // 官方 card-form 范式：写后读回核对，未落地不算成功
                const latest = scope.getSnapshot().value
                if (latest !== undefined && !isDirty(shown, latest)) {
                    setNotice({ text: t('saveDone'), tone: 'success' })
                }
            })
            .catch(() => {
                /* 恢复读由 scope 负责，失败保持 dirty 态可重试 */
            })
            .finally(() => {
                setBusy(null)
            })
    }
    // 取消：草稿归 null 即回到「跟随已存值」形态，dirty 随之消失（不发任何写）
    const onDiscard = () => {
        if (busy === 'save') return
        setNotice(null)
        setDraft(null)
    }
    // 危险操作先弹 Modal 二次确认；不依赖 canWrite/dirty（不改配置，只按目录覆盖写回模型字段）
    const onForce = () => {
        if (!ready || busy) return
        setNotice(null)
        setConfirmOpen(true)
    }
    const runForce = () => {
        setConfirmOpen(false)
        setBusy('force')
        reportWriteback(
            props.forceUpdate(),
            (count) => setNotice({ text: count > 0 ? t('forceDone', { count }) : t('forceNone'), tone: 'success' }),
            (message) => setNotice({ text: t('forceFailed', { message: truncateMessage(message) }), tone: 'error' }),
        )
    }
    // 重置推理级别：与强制更新同形（危险键 + 二次确认）；配置段零写入（开关不变），竞态防护由 Node 半事件流守卫负责
    const onReset = () => {
        if (!ready || busy) return
        setNotice(null)
        setResetConfirmOpen(true)
    }
    const runReset = () => {
        setResetConfirmOpen(false)
        setBusy('reset')
        reportWriteback(
            props.resetModels(),
            (count) => setNotice({ text: t('resetDone', { count }), tone: 'success' }),
            (message) => setNotice({ text: t('resetFailed', { message: truncateMessage(message) }), tone: 'error' }),
        )
    }
    // 恢复备份：与重置同形（次级样式 + 二次确认），仅回退「备份与当前都存在」的 provider+model
    const onRestore = () => {
        if (!ready || busy) return
        setNotice(null)
        setRestoreConfirmOpen(true)
    }
    const runRestore = () => {
        setRestoreConfirmOpen(false)
        setBusy('restore')
        reportWriteback(
            props.restoreModels(),
            (count) => setNotice({ text: t('restoreDone', { count }), tone: 'success' }),
            (message) => setNotice({ text: t('restoreFailed', { message: truncateMessage(message) }), tone: 'error' }),
        )
    }
    // 剔除确认的关闭即丢弃目标：不写任何配置，清空即不再弹出（不另设开关态避免两状态不同步）
    const closePrune = () => { setPruneTargets([]) }
    /**
     * 剔除不被支持的推理级别：经 Node 半写回，读取最新配置、revision 围栏、`excludes` 跳过与守卫全在那边；
     * 无论成败都关掉两层弹层（剔除确认 + 其下的验证弹层），否则结果写在状态行上用户看不到。
     */
    const pruneEfforts = () => {
        if (busy) return
        setBusy('prune')
        reportWriteback(
            props.pruneEfforts(pruneTargets),
            (count) => setNotice({ text: t('pruneDone', { count: String(count) }), tone: 'success' }),
            (message) => setNotice({ text: t('pruneFailed', { message: truncateMessage(message) }), tone: 'error' }),
            () => {
                closePrune()
                verify.close()
            },
        )
    }
    // 清空记忆：前端经自有 NS 的 settings scope 直写（与「保存」同一条写通道）；失败要显式提示。
    // 与保存共用 busy 互斥：保存整段写含 efforts 实时值，并发时后落者会覆盖先落者
    const clearEfforts = () => {
        if (busy) return
        setClearConfirmOpen(false)
        setBusy('clear')
        void scope.mutate([{ op: 'set', path: [VERSION_KEY, 'efforts'], value: {} }])
            .then((accepted) => { setNotice({ text: t(accepted ? 'clearEffortsDone' : 'clearEffortsFailed'), tone: accepted ? 'success' : 'error' }) })
            .catch(() => { setNotice({ text: t('clearEffortsFailed'), tone: 'error' }) })
            .finally(() => { setBusy(null) })
    }

    // 结果提示挂在折叠条件之外：收起不吞掉在途/已到的结果
    const isError = notice?.tone === 'error'
    const notices = notice !== null ? (
        <p
            className={isError ? 'dsh-mf-notice dsh-mf-noticeError' : 'dsh-mf-notice dsh-mf-noticeSuccess'}
            role={isError ? 'alert' : 'status'}
            aria-live={isError ? undefined : 'polite'}
        >
            {notice.text}
        </p>
    ) : null
    // 正文（状态行 + 瓦片栅格 + footer）：卡片展开体与插件页正文共用，只换容器
    const body = (
        <>
            {!ready ? <p className="dsh-mf-line" role="status">{t('loading')}</p> : null}
            {ready && !snap.writable ? <p className="dsh-mf-line dsh-mf-warn" role="status">{t('readOnly')}</p> : null}
            {/* 五个布尔组由组枚举与键表派生，「排除提供方」形状不同单独分发；顺序见 TILE_ORDER */}
            <div className="dsh-mf-items">
                {TILE_ORDER.map((tile) => tile === 'excludes' ? (
                    <ExcludesTile
                        key={tile}
                        t={t}
                        flags={shown}
                        hits={hits}
                        open={tileOpen === tile}
                        disabled={!canWrite}
                        onToggle={() => { onTileToggle(tile) }}
                        onAdd={onAddExclude}
                        onRemove={onRemoveExclude}
                    />
                ) : (
                    <GroupTile
                        key={tile}
                        group={tile}
                        t={t}
                        flags={shown}
                        open={tileOpen === tile}
                        disabled={!canWrite}
                        onToggle={() => { onTileToggle(tile) }}
                        onMaster={() => { onMaster(tile) }}
                        onCell={(key) => { onCell(tile, key) }}
                        // 「插件管理」是回入口，恒可见且不可关（故不绑配置键，见 tile.tsx 的 lockedRow）
                        lockedRow={tile === 'behavior' ? { label: 'rowShowInPluginManager', tip: 'tipShowInPluginManager' } : undefined}
                    />
                ))}
            </div>
            {/* 动作键独占一行、置于分隔线之上：键数增长后不再与取消/保存挤在同一行 */}
            <div className="dsh-mf-bar">
                <span className="dsh-mf-actions">
                    {/* 五个动作键共用上方那个占用态：在途或任一弹层开着，其余四个一并禁用 */}
                    <button
                        type="button"
                        className="dsh-mf-force"
                        disabled={!ready || configLocked}
                        onClick={onForce}
                    >
                        {busy === 'force' ? t('forceBusy') : t('force')}
                    </button>
                    <button
                        type="button"
                        className="dsh-mf-force"
                        disabled={!ready || configLocked}
                        onClick={onReset}
                    >
                        {busy === 'reset' ? t('resetBusy') : t('reset')}
                    </button>
                    <button
                        type="button"
                        className="dsh-mf-discard"
                        disabled={!ready || configLocked}
                        onClick={onRestore}
                    >
                        {busy === 'restore' ? t('restoreBusy') : t('restore')}
                    </button>
                    {/* 弹层自带额度提示与 warn 语义确认键，已构成自确认，不叠二次确认弹层；触发键同取 warn 语义 */}
                    <button
                        type="button"
                        className="dsh-mf-discard dsh-mf-warn"
                        disabled={!ready || configLocked}
                        onClick={verify.onOpen}
                    >
                        {t('verify')}
                    </button>
                    {/* 与验证同一 warn 语义（花额度且写回）；放在验证之后——写回前用户应已读过只读验证的结论 */}
                    <button
                        type="button"
                        className="dsh-mf-discard dsh-mf-warn"
                        disabled={!ready || configLocked}
                        onClick={probe.onOpen}
                    >
                        {t('probe')}
                    </button>
                </span>
            </div>
            <div className="dsh-mf-footer">
                <span className="dsh-mf-actions">
                    {/* 取消键只在有未保存编辑时出现（保存后自动隐去）；保存中保持可见但禁用 */}
                    {dirty ? (
                        <button
                            type="button"
                            className="dsh-mf-discard"
                            disabled={busy === 'save'}
                            onClick={onDiscard}
                        >
                            {t('cancel')}
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className="dsh-mf-save"
                        disabled={!canWrite || !dirty || busy !== null}
                        onClick={onSave}
                    >
                        {busy === 'save' ? t('saving') : t('save')}
                    </button>
                </span>
            </div>
            <CardMeta t={t} />
        </>
    )
    // 五层二次确认同形，差异只有标题 / 说明 / 两键文案与红 tint 语义：都归 confirm.tsx 的 ConfirmModal
    const confirms = (
        <>
            <ConfirmModal
                open={confirmOpen}
                onClose={() => { setConfirmOpen(false) }}
                title={t('force')}
                closeLabel={t('close')}
                description={t('forceConfirm')}
                cancelLabel={t('cancel')}
                confirmLabel={t('forceGo')}
                onConfirm={runForce}
                danger
            />
            <ConfirmModal
                open={resetConfirmOpen}
                onClose={() => { setResetConfirmOpen(false) }}
                title={t('reset')}
                closeLabel={t('close')}
                description={t('resetConfirm')}
                cancelLabel={t('cancel')}
                confirmLabel={t('resetGo')}
                onConfirm={runReset}
                danger
            />
            {/* 恢复不上 danger：操作不删用户任何东西，红色与语义不符 */}
            <ConfirmModal
                open={restoreConfirmOpen}
                onClose={() => { setRestoreConfirmOpen(false) }}
                title={t('restore')}
                closeLabel={t('close')}
                description={t('restoreConfirm')}
                cancelLabel={t('cancel')}
                confirmLabel={t('restoreGo')}
                onConfirm={runRestore}
            />
            {/* 清空记忆确认：只问记忆去留（开关此时已转关）；清空即删除类操作，故 danger */}
            <ConfirmModal
                open={clearConfirmOpen}
                onClose={() => { setClearConfirmOpen(false) }}
                title={t('clearEffortsTitle')}
                closeLabel={t('close')}
                description={t('clearEffortsConfirm')}
                cancelLabel={t('clearEffortsKeep')}
                confirmLabel={t('clearEffortsGo')}
                onConfirm={clearEfforts}
                danger
                confirmDisabled={busy !== null}
            />
            {/* 剔除确认：出现与否只看 pruneTargets 是否为空——中止、出错、无明确不支持结论时都不弹 */}
            <ConfirmModal
                open={pruneTargets.length > 0}
                onClose={closePrune}
                title={t('pruneTitle')}
                closeLabel={t('close')}
                description={t('pruneConfirm', { count: String(pruneTargets.length) })}
                cancelLabel={t('cancel')}
                confirmLabel={t('pruneGo')}
                onConfirm={pruneEfforts}
                danger
                confirmDisabled={busy !== null}
            />
            {/* 「验证模型」弹层见 verify-dialog.tsx：候选列表 + 记录区 + 底部动作行，本文件只递状态与回调 */}
            <VerifyDialog
                t={t}
                open={verify.open}
                onClose={verify.close}
                running={verify.running}
                idle={busy === null}
                candidates={verifyCandidates}
                picked={verify.picked}
                onTogglePick={verify.togglePick}
                onToggleGroup={verify.toggleGroup}
                efforts={verify.efforts}
                onEffortsChange={verify.setEfforts}
                total={verify.total}
                lines={verify.lines}
                terminalLabels={verify.terminalLabels}
                onRun={verify.run}
                onStop={verify.stop}
            />
            {/* 「探测式填充」弹层见 probe-dialog.tsx：两个范围键 + 记录区 + 三个开关，本文件只递状态与回调 */}
            <ProbeDialog
                t={t}
                open={probe.open}
                onClose={probe.close}
                running={probe.running}
                idle={busy === null}
                scope={probe.scope}
                unfilledCount={probe.unfilledCount}
                allCount={probe.allCount}
                onProbe={probe.run}
                onStop={probe.stop}
                autoWrite={probe.autoWrite}
                onAutoWriteChange={probe.setAutoWrite}
                ignoreExcludes={probe.ignoreExcludes}
                onIgnoreExcludesChange={probe.toggleIgnoreExcludes}
                dropUnsupported={probe.dropUnsupported}
                onDropUnsupportedChange={probe.setDropUnsupported}
                total={probe.total}
                lines={probe.lines}
                terminalLabels={probe.terminalLabels}
            />
        </>
    )

    // 不可折叠席位（输入框弹层）用静态头渲染：保留名称/描述/未保存胶囊，不给按钮语义与 chevron
    const head = (
        <span className="dsh-mf-headText">
            <span className="dsh-mf-name">{t('title')}</span>
            <span className="dsh-mf-desc">{t('description')}</span>
        </span>
    )

    return (
        <div className={open ? 'dsh-mf-card dsh-mf-cardOpen' : 'dsh-mf-card'}>
            {collapsible ? (
                <button
                    type="button"
                    className="dsh-mf-header"
                    aria-expanded={open}
                    aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('title')}`}
                    onClick={() => { setOpen(!open) }}
                >
                    {head}
                    {/* 胶囊挂在 header：收起态也要说明卡里存着未落盘的编辑 */}
                    {dirty ? <Tag tone="neutral">{t('unsaved')}</Tag> : null}
                    <CHEVRON_DOWN className={open ? 'dsh-mf-chevron dsh-mf-chevronOpen' : 'dsh-mf-chevron'} />
                </button>
            ) : (
                <div className="dsh-mf-header dsh-mf-headerStatic">
                    {head}
                    {dirty ? <Tag tone="neutral">{t('unsaved')}</Tag> : null}
                </div>
            )}
            {notices}
            {open ? <div className="dsh-mf-body">{body}</div> : null}
            {confirms}
        </div>
    )
}
