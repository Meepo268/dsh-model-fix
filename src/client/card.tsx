/**
 * 模型参数填充卡片（浏览器半）：复刻官方插件卡的可折叠卡片。五个挂载席位（模型页 footer / 插件详情页 /
 * 组件实例详情页 / 内置插件选项卡 / 输入框工具行弹层）共用同一外壳，差异只有折叠态策略（`defaultOpen`：
 * 弹层与三处详情席位默认展开且保存后不自动收起，footer 席默认收起、保存后自动收起；输入框弹层另禁用折叠）；
 * 详情页仍自绘自己的图标 / 面包屑 / 开关，卡片头部只管本卡。
 * 展开体为六张瓦片（顺序由 TILE_ORDER 单一分发）：五张布尔矩阵瓦片（自动填充 / 允许更新 / 兼容性 /
 * 用户体验 / UI 与行为）+ 一张动态集合瓦片（排除提供方，summary 尾区为「N 命中」徽标，0 命中也常驻、不得画成错误色）
 * 。「UI 与行为」组内另有一条恒定展示行排在真键之前（插件管理，不绑配置、不可关闭——关掉就没有任何界面可以重新打开）。
 * 瓦片手风琴：默认收起、同时只开一个。
 * 布尔瓦片的每一行标题带一个说明键：悬停或键盘聚焦时经宿主 Tooltip 气泡给出该设置项释义（组释义在首行、项释义在气泡）。
 * footer 左侧为强制更新 / 重置推理级别（危险键）/ 恢复备份（次级键）/ 验证模型（次级键）/ 探测式填充（次级键），右侧为取消（仅未保存时渲染）/ 保存；
 * 三把写回键与「清空记忆」均先弹宿主 Modal 二次确认，再经 Connection RPC 或 settings scope 请求 Node 半。
 * 「验证模型」则弹一个自带确认的候选框（逐条照官方 models 页「获取可用模型」的候选框，减去其搜索/全选工具条）：
 * 按提供方分组多选模型，配「验证推理级别」开关，对每个勾选模型声明的每个推理级别发起真实探测；
 * 结论只留在该弹层内（实时记录区的末行），不写卡片状态行——验证即用即弃，不留任何配置痕迹。
 * 「探测式填充」是它的写回版：没有候选框（范围由「探测所有 / 探测未填充」两键与「忽略排除」开关决定，
 * 模型列表取**点按钮那一刻**的最新值并当场冻结），正文依次是「探测范围一句 → 额度提示 → 实时记录区 → 三个开关」，
 * 两个范围的大小由那句提示交代（分别对应「探测所有 / 探测未填充」两键，键文本保持短）；
 * footer 只留 关闭 / 探测所有 / 探测未填充 三键（由宽到窄）；
 * 跑完把结果留在记录区并**不自动关窗**（由用户自行关窗），
 * 「自动写入」开启时同一份补全结果另落卡片状态行。
 * 编辑只改本地草稿，「保存」才经 settings scope 原子写当前版本快照键（efforts 取写入当刻实时值，
 * 卡片不拥有该字段）；草稿跨折叠存活（header 挂「未保存」胶囊），写失败保持展开可重试。
 * 除验证外的操作结果一律走卡片内联状态行（挂在条件展开体之外，折叠不丢在途结果）。
 * 弹层不在本文件：样式表与它的注入、说明气泡宽度上限、两处展示数值统一见 card-styles.ts；末尾联系行（仓库地址 / 版本标记 / 反馈入口）见 card-meta.tsx；
 * 「验证模型」弹层（候选列表 + 记录区 + 档位开关 + 发跑/停止）见 verify-dialog.tsx，
 * 「探测式填充」弹层（两个范围键 + 记录区 + 三个开关）见 probe-dialog.tsx，卡片只递状态与回调。本文件只管卡片的状态与编排。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
// primitives 由宿主模块表注入
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
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
    probeCandidatesOf,
    probeTargetsOf,
    removeExclude,
    resolveHits,
    toggleCell,
    toggleGroupPicks,
    verifyCandidatesOf,
    verifyTargets,
} from '@/client/model'
import type { Flags, Group, RowKey, VerifyCandidate, VerifyTarget } from '@/client/model'
import type { CardKey } from '@/client/locale-keys'
import { ExcludesTile, GroupTile, TILE_ORDER } from '@/client/tile'
import { CardMeta } from '@/client/card-meta'
import { ConfirmModal } from '@/client/confirm'
import { VerifyDialog } from '@/client/verify-dialog'
import { ProbeDialog } from '@/client/probe-dialog'
import type { RpcCarrier } from '@/client/rpc-carrier'
import { errorText } from '@/shared/errors'
import { isProviderBlocking } from '@/shared/verify-progress'
import type { UnsupportedEffort, ProbeOutcome, VerifyProbedFrame } from '@/shared/verify-progress'
import { DEFAULT_CONFIG, toStored } from '@/shared/config-schema'

/** 瓦片 chevron：宿主 ui-primitives 导出的描边 chevron 图标 */
const CHEVRON_DOWN = primitives.IconChevronDownOutlineRegular
const { Tag } = primitives

/** 宿主 TerminalBlock 的展示文案（该包无语言回退，整份照官方 terminalLabels(t) 提供）。
 *  0.2.1-alpha.2 起新增必填字段 `commandLine`，而 devDep 停在 0.1.7-rc.2、编译面看不到它，
 *  故并入期望类型：既避开 excess-property 检查，又保住其余字段的必填校验；
 *  多带该字段在 0.1.7-rc.2 上被静默忽略，两端兼容。详见 docs/host-api.md */
type TerminalLabels = TerminalBlockLabels & { commandLine: (line: number) => string }

function terminalLabelsOf(t: TranslateNS<'settings.modelFix'>): TerminalLabels {
    return {
        commandLine: (n) => t('terminalCommandLine', { n: String(n) }),
        signal: (signal) => t('terminalSignal', { signal }),
        exitCode: (code) => t('terminalExitCode', { code: String(code) }),
        noExitCode: t('terminalNoExitCode'),
        running: t('terminalRunning'),
        failed: t('terminalFailed'),
        done: t('terminalDone'),
        copy: t('terminalCopy'),
        copied: t('terminalCopied'),
        noOutput: t('terminalNoOutput'),
        collapseAria: t('terminalCollapseAria'),
        collapse: t('terminalCollapse'),
        expandAria: (n) => t('terminalExpandAria', { n: String(n) }),
        expand: (n) => t('terminalExpand', { n: String(n) }),
    }
}

/** 每种探测结论对应的展示词；判别值与 `ProbeOutcome` 一一对应，漏一个即类型报错。
 * `aborted` 只占类型位：中止一律不入账，不会出现在记录区 */
const OUTCOME_KEYS: Record<ProbeOutcome, CardKey> = {
    usable: 'verifyOutUsable',
    'unsupported-effort': 'verifyOutUnsupported',
    unreachable: 'verifyOutUnreachable',
    quota: 'verifyOutQuota',
    credential: 'verifyOutCredential',
    'rate-limit': 'verifyOutRateLimit',
    timeout: 'verifyOutTimeout',
    aborted: 'verifyOutAborted',
    other: 'verifyOutOther',
}

/**
 * 一条探测结论的记录行。
 *
 * provider 级失败（不可达 / 凭据无效）不带模型与档位——那不是某个模型的问题，是整组都不成立；
 * 带 `skipped` 时补一句「还剩几条没验」，免得用户把那一行当成全部结论。
 */
function verifyLineOf(frame: VerifyProbedFrame, t: TranslateNS<'settings.modelFix'>): string {
    const result = t(OUTCOME_KEYS[frame.outcome])
    const line = isProviderBlocking(frame.outcome)
        ? t('verifyLineProvider', { provider: frame.provider, result })
        : frame.effort === undefined
            ? t('verifyLinePlain', { provider: frame.provider, model: frame.model, result })
            : t('verifyLine', { provider: frame.provider, model: frame.model, effort: frame.effort, result })
    return frame.skipped === undefined ? line : `${line}${t('verifySkipped', { count: String(frame.skipped) })}`
}

/** 卡片组件 props（t 由 slots.register 的 locale 席位合成注入；scope/forceUpdate 由入口闭包传入）；六个调 Node 半的方法由 `RpcCarrier` 给出，入口整包递进来（语言上报不经过卡片，故从调用面里剔掉） */
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

/** 内联状态行：文本 + 色调（成功＝官方 .savedNotice 绿，失败＝.error 红） */
interface Notice {
    text: string
    tone: 'success' | 'error'
}

/** 截断失败信息：RPC 与异常消息可能极长（含 URL、响应片段），截断以保持状态行可读 */
function truncateMessage(value: string): string {
    return value.length > 120 ? `${value.slice(0, 119)}…` : value
}

/** 写回超时不是失败原因而是「没等到结果」，状态行另给中文；`DOMException` 不继承 `Error`，不能按 `Error` 判 */
function isWritebackTimeout(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'TimeoutError'
}

/** 卡片主体 */
export function Card(props: CardProps) {
    useLayoutEffect(() => { ensureStyles() }, [])
    const scope = props.scope
    const { t } = props
    const snap = useSyncExternalStore(
        (listener) => scope.subscribe(listener),
        () => scope.getSnapshot(),
    )
    // 提供方 id 来源 scope：只消费其 user 层（宿主 describe mirror 保证快照引用稳定，memo 只在文档变更时重算）
    const providersScope = props.providersScope
    const providersSnap = useSyncExternalStore(
        (listener) => providersScope.subscribe(listener),
        () => providersScope.getSnapshot(),
    )
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
    // 全部写操作（保存 / 强制更新 / 重置 / 恢复 / 清空记忆 / 验证 / 探测 / 剔除）共用单一互斥标志：
    // 一者 in-flight 时其余入口与按钮全禁
    const [busy, setBusy] = useState<'save' | 'force' | 'reset' | 'restore' | 'clear' | 'verify' | 'probe' | 'prune' | null>(null)
    // 不可折叠席位（输入框弹层）恒展开：面板尺寸固定、内容可滚，折叠无从触发
    const collapsible = props.collapsible !== false
    // 折叠态为卡片本地状态（读姿而非配置）：初始值取 defaultOpen（缺省收起、与官方插件卡一致）；草稿跨折叠存活
    const [open, setOpen] = useState(collapsible ? (props.defaultOpen ?? false) : true)
    // 保存后自动收起只对默认收起的席位有意义：默认展开的三席（插件详情页 / 组件实例详情页 / 内置插件选项卡）
    // 保存后保持展开，否则用户刚配完就被收起、还得再点一次才看得见结果
    const autoCollapse = props.defaultOpen !== true
    // 瓦片折叠态：官方手风琴语义（同时只开一个、默认全收起；各瓦片展开高度不同，同开两列底部参差）
    const [tileOpen, setTileOpen] = useState<string | null>(null)
    // 内联结果提示：常驻至下一次操作（官方 .savedNotice 无定时器，故不设自动淡出）
    const [notice, setNotice] = useState<Notice | null>(null)
    // 五层二次确认各控一个状态（执行态统一在 busy）：三个写回端点 + 清空记忆 + 剔除
    const [confirmOpen, setConfirmOpen] = useState(false)
    const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
    const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false)
    // 「记住推理级别」关掉时的确认：是否清空已有记忆（前端直写，不走 RPC）
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
    // 剔除确认的目标：验证明细里**明确**被判「档位不支持」的条目，由 Node 半直接给出，
    // 浏览器半不自己从 results 里筛——两处口径一旦分叉就会漏剔或多剔。
    // 中止 / 出错 / 无此类结论时保持空数组，空数组即不弹窗
    const [pruneTargets, setPruneTargets] = useState<readonly UnsupportedEffort[]>([])
    // 「验证模型」弹层：勾选集（键见 verifyKey）、是否逐个档位验证；默认不预选——每次验证都花真实额度
    const [verifyOpen, setVerifyOpen] = useState(false)
    const [verifyPicked, setVerifyPicked] = useState<ReadonlySet<string>>(() => new Set())
    const [verifyEfforts, setVerifyEfforts] = useState(false)
    // 验证记录区：逐行追加探测结论，发起时清空；总项数取自 opened 帧，供记录区抬头显示
    const [verifyLines, setVerifyLines] = useState<readonly string[]>([])
    const [verifyTotal, setVerifyTotal] = useState(0)
    // 本轮是否以中止收场：跑完与失败都留在窗内，只有停止键会中止，故记录区的 settle 措辞按它分「完成 / 已停止」
    const [verifyStopped, setVerifyStopped] = useState(false)
    // 在途的 AbortController：点停止、关窗与组件卸载都靠它中止——中止经 signal 传导到 Node 半的执行循环
    const verifyAbort = useRef<AbortController | null>(null)
    // 卸载即中止在途验证：连接随之断开，宿主 Connection 把断开传导成 request.signal，执行循环随即早停
    useEffect(() => () => { verifyAbort.current?.abort() }, [])
    // 中止不落宿主那个 error 态的「失败」——用户主动停止不是失败，故改 done 态 + 中性措辞「已停止」
    const verifyTerminalLabels = useMemo<TerminalBlockLabels>(
        () => ({ ...terminalLabelsOf(t), done: verifyStopped ? t('verifyStopped') : t('terminalDone') }),
        [t, verifyStopped],
    )
    const saveStarted = useRef(false)

    // 「探测式填充」弹层：三个开关 + 点开弹层那一刻冻结的候选清单（两个键各一份）+ 记录区。
    // 候选清单冻结在点开时而非渲染时：模型列表要取**点按钮那一刻**的最新值，
    // 弹层开着期间用户改了配置也不影响本轮（否则记录区的总项数与实际发的不一致）
    const [probeOpen, setProbeOpen] = useState(false)
    const [probeIgnoreExcludes, setProbeIgnoreExcludes] = useState(false)
    const [probeDropUnsupported, setProbeDropUnsupported] = useState(false)
    // 「自动写入」默认开启，且每次开窗重置为开（见 onProbe）——它是本轮「探完写不写」的模式选择
    const [probeAutoWrite, setProbeAutoWrite] = useState(true)
    const [probePlan, setProbePlan] = useState<{ unfilled: readonly VerifyTarget[]; all: readonly VerifyTarget[] } | null>(null)
    // 本轮跑的是哪个键：在途那个键就地变「停止」，故得记住发起时的选择
    const [probeScope, setProbeScope] = useState<'unfilled' | 'all' | null>(null)
    const [probeLines, setProbeLines] = useState<readonly string[]>([])
    const [probeTotal, setProbeTotal] = useState(0)
    const [probeStopped, setProbeStopped] = useState(false)
    // 在途的 AbortController：点停止、关窗与组件卸载都靠它中止
    const probeAbort = useRef<AbortController | null>(null)
    // 卸载即中止在途探测（与验证同一条纪律）
    useEffect(() => () => { probeAbort.current?.abort() }, [])
    const probeTerminalLabels = useMemo<TerminalBlockLabels>(
        () => ({ ...terminalLabelsOf(t), done: probeStopped ? t('verifyStopped') : t('terminalDone') }),
        [t, probeStopped],
    )

    const saved = snap.value
    const shown = draft ?? saved ?? DEFAULT_CONFIG
    const ready = snap.status === 'ready' && saved !== undefined
    const canWrite = ready && snap.writable === true
    // 五个动作键共用一个占用态：三个写回端点与两个弹层都牵动模型配置，任一处在途或任一弹层开着，其余四个一并禁用
    const configLocked = busy !== null || verifyOpen || probeOpen
    const dirty = draft !== null && saved !== undefined && isDirty(draft, saved)
    // 命中集合按草稿算（编辑中即所见即所得），未命中项同样生效，只是当前无同名提供方
    const hits = useMemo(() => resolveHits(shown.excludes, providerIds), [shown.excludes, providerIds])
    // 两个探测键各自的模型数（点开弹层时冻结的那份计划）：为 0 的键禁用，不做「点了没反应」
    const unfilledCount = probePlan?.unfilled.length ?? 0
    const allCount = probePlan?.all.length ?? 0
    // 保存成功（保存结束且 dirty 归 false）后自动收起，仅限默认收起的席位；
    // 写失败保留草稿与展开态可重试。其余动作的 busy 起止不触碰 saveStarted，不会误收起
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
     * 四个写回动作的结果汇报同形：成功按条数出一句、失败取原因出一句、传输层 reject 与 `ok:false` 走同一条展示路径、
     * 收尾一律清占用态。差异只有文案键与那条数怎么插值，故收在一处，各动作只给文案。
     *
     * @param call - 已经发出去的那次 RPC
     * @param ok - 成功回调，入参是 Node 半回的条数（强制更新 / 重置 / 恢复给 `changed`，剔除给 `pruned`）
     * @param failed - 失败回调，入参是原因原文（截断与插值由调用点的文案键决定）
     * @param settled - 收尾额外做的事（剔除那条还要关掉两层弹层，否则结果写在状态行上用户看不到）
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
    // 整组总控：显示值取 masterValue（全开才显示开，部分选中显示关，点击即补全为开）；点击取反并把该组全部行设为同一值
    // （总开关无对应存储，只是批量操作）
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
        // efforts 取写入当刻的实时值：卡片不拥有该字段，用草稿副本会把「开卡后切过模型」的记忆覆盖回去
        const liveEfforts = scope.getSnapshot().value?.efforts
        void scope.set(VERSION_KEY, toStored({ ...shown, efforts: liveEfforts ?? shown.efforts }))
            .then(() => {
                // 官方 card-form 范式：写后读回核对，未落地不算成功（保持「未保存」态，不误报）
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
    // 验证模型：弹层自身已含 warn 提示与 warn 语义的确认键，构成自确认，故不再叠加二次确认弹层。
    // 只清掉上一次操作的结果、结果本身留在弹层内（那行挂在条件展开体之外，折叠不丢在途结果）
    const onVerify = () => {
        if (!ready || busy) return
        setNotice(null)
        setVerifyOpen(true)
    }
    const runVerify = () => {
        if (busy) return
        // 记下本次的档位开关取值：结果回来时不能现读，否则用户在途中拨了开关，文案就会张冠李戴
        const allEfforts = verifyEfforts
        // 每次发起都清空记录，免得上一轮（尤其被用户停止的那轮）的残留行混进这一轮
        setVerifyLines([])
        setVerifyTotal(0)
        setVerifyStopped(false)
        setBusy('verify')
        const controller = new AbortController()
        verifyAbort.current = controller
        props.verifyModels(verifyTargets(verifyCandidates, verifyPicked, allEfforts), (frame) => {
            if (frame.type === 'opened') {
                setVerifyTotal(frame.total)
                return
            }
            setVerifyLines((current) => [...current, verifyLineOf(frame, t)])
        }, controller.signal)
            .then((summary) => {
                // undefined = 被中止（点停止 / 关窗 / 断连）。那不是失败：保留进度与弹层，由用户决定要不要重跑
                if (summary === undefined) {
                    setVerifyStopped(true)
                    return
                }
                // 两档口径各取各的数：关档位时只有模型数可言，开档位时级别分母取 plannedEfforts——
                // 没声明档位的模型验的是模型本身、不占级别，用 planned（含它那条）会让分母虚高。
                // 而档位开关开着却一个级别都没计划时（勾选的模型都没声明档位），级别那行只会显示「[0/0]」，故退回模型口径
                const stats = t(allEfforts && summary.plannedEfforts > 0 ? 'verifyDoneLevels' : 'verifyDoneModels', {
                    models: summary.models,
                    tested: summary.tested,
                    efforts: summary.efforts,
                    levels: summary.plannedEfforts,
                })
                // 结论只留在弹层内，不写卡片状态行：弹层跑完不关、结论又追加成记录区末行，
                // 用户当场就看得见；同步到卡片是「渗透」——关窗即随记录一起丢弃，那行反馈没有归属
                // 明细由 Node 半直接给出（只收明确判为不支持的），前端不自己从 results 里筛——
                // 两处口径一旦分叉就会漏剔或多剔。中止时压根到不了这里，故不会误弹
                setPruneTargets(summary.unsupportedEfforts)
                setVerifyLines((current) => [...current, t('verifyFinished', { result: stats })])
            })
            .catch((error: unknown) => {
                const stats = t('verifyFailed', { message: truncateMessage(errorText(error)) })
                setVerifyLines((current) => [...current, t('verifyFinished', { result: stats })])
            })
            .finally(() => {
                verifyAbort.current = null
                setBusy(null)
            })
    }
    // 停止：中止在途验证。连接随之断开，Node 半的执行循环随即早停，不再消耗额度。
    // 不顺手关窗——已验到哪一步值得留在记录里，用户看完可以原地重跑
    // 与探测弹层的 stopProbe 同一处理：「停止」是唯一不关窗的中止方式（关窗那几种记录随弹窗一起丢），
    // 故按下即在记录区留一行——中止这件事要落在日志里，而不只是 TerminalBlock 那个改了就改了的「已停止」状态标签
    const stopVerify = () => {
        if (verifyAbort.current === null) return
        verifyAbort.current.abort()
        setVerifyLines((current) => [...current, t('verifyStoppedLine')])
    }
    /**
     * 按当前状态算两份候选计划（未填充 / 全部）：模型列表取**此刻**的最新值。
     *
     * 排除值用卡片当前显示的那份（与「命中」判定同源，故所见即所得）；`ignoreExcludes` 由调用方给，
     * 它同时传下去管 Node 半的两次写回，两边必须是同一个值。
     */
    const probePlanOf = (ignoreExcludes: boolean) => {
        const user = providersSnap.status === 'ready' ? providersSnap.user : undefined
        const pick = (unfilledOnly: boolean): readonly VerifyTarget[] => probeTargetsOf(probeCandidatesOf(user, {
            excludes: shown.excludes,
            ignoreExcludes,
            unfilledOnly,
        }))
        return { unfilled: pick(true), all: pick(false) }
    }
    /** 探测式填充：点开弹层并当场冻结计划。弹层开着期间配置再变也不改本轮（记录区的总项数照这份计划走） */
    const onProbe = () => {
        if (busy !== null) return
        setProbePlan(probePlanOf(probeIgnoreExcludes))
        // 「自动写入」每次开窗重置为开：它是本轮的模式选择，带着上一轮的取值出现会与用户对不上
        setProbeAutoWrite(true)
        setProbeOpen(true)
    }
    // 切「忽略排除」要重算计划：探测范围随它变，两个键上标的模型数与记录区的总项数不跟着变，
    // 用户看到的数字就和实际会探的模型对不上了
    const toggleIgnoreExcludes = (value: boolean) => {
        setProbeIgnoreExcludes(value)
        setProbePlan(probePlanOf(value))
    }
    /**
     * 跑一轮探测式填充。
     *
     * 跑完不关窗：结论追加进记录区后留在窗内由用户自行关窗。
     * 「自动写入」开启时，Node 半在终帧之前已把档位按结论收敛写回（终帧的 `summary.fill` 带增删统计），
     * 补全结果追加进记录区并另落卡片状态行；关闭时 Node 半只把预声明原样收回（与中止同一形态），
     * `fill` 是「可补全」的假设统计，这里换措辞报一行「可补全多少、未执行写入」，不落状态行——没写回就没有「已补全」可言。
     * 在途被中止则两者都不做：未跑完的模型已被 Node 半还原成本轮开始前的形态，
     * 留在窗里让用户看见「探到哪一步」比报一个半截结论诚实。
     */
    const runProbe = (unfilledOnly: boolean) => {
        if (busy !== null || probePlan === null) return
        const models = unfilledOnly ? probePlan.unfilled : probePlan.all
        if (models.length === 0) return
        setProbeLines([])
        setProbeTotal(0)
        setProbeStopped(false)
        setBusy('probe')
        const controller = new AbortController()
        probeAbort.current = controller
        setProbeScope(unfilledOnly ? 'unfilled' : 'all')
        // 记下本次的「自动写入」取值：结果回来时不能现读，否则收尾文案会张冠李戴
        const autoWrite = probeAutoWrite
        // 「剔除不支持」只对「探测所有」有意义：未填充的模型本来就没声明过档位，判不支持的那些
        // 压根不会写进去，没什么可剔。故这一档在这里被强制按关处理，不把用户的选择悄悄带进下一轮
        props.probeEfforts(models, { ignoreExcludes: probeIgnoreExcludes, dropUnsupported: unfilledOnly ? false : probeDropUnsupported, autoWrite }, (frame) => {
            if (frame.type === 'opened') {
                setProbeTotal(frame.total)
                return
            }
            setProbeLines((current) => [...current, verifyLineOf(frame, t)])
        }, controller.signal)
            .then((summary) => {
                if (summary === undefined) {
                    setProbeStopped(true)
                    return
                }
                const fill = summary.fill
                const stats = t('probeDone', {
                    models: String(summary.tested),
                    levels: String(summary.plannedEfforts),
                    usable: String(summary.efforts),
                    unsupported: String(summary.unsupported),
                })
                setProbeLines((current) => [...current, stats])
                // 只有「自动写入」开启才落卡片状态行——没写回就没有「已补全」可言
                if (autoWrite) {
                    const filled = t('probeFilled', {
                        models: String(fill?.models ?? 0),
                        added: String(fill?.added ?? 0),
                        removed: String(fill?.removed ?? 0),
                    })
                    setNotice({ text: filled, tone: 'success' })
                    setProbeLines((current) => [...current, filled])
                } else {
                    // 关闭自动写入：Node 半没落盘，这里换措辞交代「可补全多少」，与已写入的分支区分
                    const held = t('probeFillSkipped', {
                        models: String(fill?.models ?? 0),
                        added: String(fill?.added ?? 0),
                        removed: String(fill?.removed ?? 0),
                    })
                    setProbeLines((current) => [...current, held])
                }
            })
            .catch((error: unknown) => {
                const failed = t('probeFillFailed', { message: truncateMessage(errorText(error)) })
                setNotice({ text: failed, tone: 'error' })
                setProbeLines((current) => [...current, failed])
            })
            .finally(() => {
                probeAbort.current = null
                setProbeScope(null)
                setBusy(null)
            })
    }
    // 停止：中止在途探测。连接随之断开，Node 半的执行循环随即早停，不再消耗额度。
    // 不顺手关窗——已探到哪一步值得留在记录里。
    // 「停止」是唯一不关窗的中止方式（关窗那几种记录随弹窗一起丢），故按下即在记录区留一行：
    // 中止这件事要落在日志里，而不只是 TerminalBlock 那个改了就改了的「已停止」状态标签
    const stopProbe = () => {
        if (probeAbort.current === null) return
        probeAbort.current.abort()
        setProbeLines((current) => [...current, t('probeStoppedLine')])
    }
    // 关闭即丢弃本轮记录与计划，「忽略排除 / 剔除不支持」一并复位（下次打开回到「关」的初始态）；
    // 「自动写入」不在关闭时复位——它每次开窗时重置为开（见 onProbe）。
    // 与验证弹层同一处理：开关是本轮的模式选择，留着会让下次打开时的模型数
    // 与用户当下看到的开关状态对不上——尤其「忽略排除」直接决定候选范围。
    // 在途时关窗同时中止；遮罩 / Escape / × / 「取消」键四种关闭都汇到 Modal 的 onClose 与该键
    const closeProbe = () => {
        probeAbort.current?.abort()
        setProbeOpen(false)
        setProbePlan(null)
        setProbeScope(null)
        setProbeLines([])
        setProbeTotal(0)
        setProbeStopped(false)
        setProbeIgnoreExcludes(false)
        setProbeDropUnsupported(false)
    }
    // 关闭即丢弃本次勾选与记录，并把档位开关一并复位（下次打开回到未预选、无记录、开关关闭的初始态）
    // 在途时关窗同时中止：验证即用即弃，用户已经离开就没必要继续烧额度。
    // 遮罩 / Escape / × 三种关闭都汇到 Modal 的 onClose，故中止只此一处；跑完后控制器已置空，是空操作
    const closeVerify = () => {
        verifyAbort.current?.abort()
        setVerifyOpen(false)
        setVerifyPicked(new Set())
        setVerifyLines([])
        setVerifyTotal(0)
        setVerifyEfforts(false)
    }
    // 剔除确认的关闭即丢弃目标：不写任何配置，清空即自然不再弹出（不另设开关态，避免两个状态不同步）
    const closePrune = () => { setPruneTargets([]) }
    /**
     * 剔除不被支持的推理级别：经 Node 半写回。
     *
     * 读取最新配置、revision 围栏与冲突重试、只认目标里当前仍在档位表中的那些、事件流守卫——全在那边，
     * 浏览器半只负责发请求与展示结果；剔除条数照实显示，为 0 也不例外——目标在剔除期间已被用户改掉，
     * 或其提供方正在排除列表里（排除提供方在 `planPruneEfforts` 中整组跳过，不撤销已写入的内容）。
     *
     * 无论成败都关掉两层弹层（剔除确认 + 其下的验证弹层）：结果写在卡片状态行上，
     * 弹层不关用户看不到，那条反馈等于没有。
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
                closeVerify()
            },
        )
    }
    const toggleVerifyPick = (key: string) => {
        setVerifyPicked((current) => {
            const next = new Set(current)
            if (!next.delete(key)) next.add(key)
            return next
        })
    }
    // 分组全选：点击方向与按钮文案同走 groupAllPicked（判据只此一处，两边各判一次会反直觉）
    const toggleVerifyGroup = (models: readonly VerifyCandidate[]) => {
        setVerifyPicked((current) => toggleGroupPicks(current, models))
    }
    // 清空记忆：前端经自有 NS 的 settings scope 直写（与「保存」同一条写通道，立即生效、草稿不动）；
    // 失败要显式提示——否则开关已关而记忆未清，无从察觉。与保存共用 busy 互斥：
    // 保存整段写含 efforts 实时值，两者并发时后落者会把先落者覆盖掉
    const clearEfforts = () => {
        if (busy) return
        setClearConfirmOpen(false)
        setBusy('clear')
        void scope.mutate([{ op: 'set', path: [VERSION_KEY, 'efforts'], value: {} }])
            .then((accepted) => { setNotice({ text: t(accepted ? 'clearEffortsDone' : 'clearEffortsFailed'), tone: accepted ? 'success' : 'error' }) })
            .catch(() => { setNotice({ text: t('clearEffortsFailed'), tone: 'error' }) })
            .finally(() => { setBusy(null) })
    }

    // 结果提示挂在条件体之外：折叠不会吞掉在途/已到的结果
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
                    {/* 验证模型：弹层自带额度提示与 warn 语义确认键，已构成自确认，故不再叠二次确认弹层；
                       触发键本身也取 warn 语义——点开即进入会花额度的流程，警示前移到入口 */}
                    <button
                        type="button"
                        className="dsh-mf-discard dsh-mf-warn"
                        disabled={!ready || configLocked}
                        onClick={onVerify}
                    >
                        {t('verify')}
                    </button>
                    {/* 探测式填充：与验证同一 warn 语义（点开即进入会花额度、且会写回配置的流程）。
                        它放在验证之后——两者都花额度，但验证只读、探测写回，后者需要用户已经读过验证的结论 */}
                    <button
                        type="button"
                        className="dsh-mf-discard dsh-mf-warn"
                        disabled={!ready || configLocked}
                        onClick={onProbe}
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
            {/* 剔除确认：结构照「清空推理级别记忆」那层二次确认，只把两键文案换成「剔除」。
                出现与否只看 pruneTargets 是否为空——中止、出错、或没有明确判为档位不支持的结论时都不弹 */}
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
                open={verifyOpen}
                onClose={closeVerify}
                running={busy === 'verify'}
                idle={busy === null}
                candidates={verifyCandidates}
                picked={verifyPicked}
                onTogglePick={toggleVerifyPick}
                onToggleGroup={toggleVerifyGroup}
                efforts={verifyEfforts}
                onEffortsChange={setVerifyEfforts}
                total={verifyTotal}
                lines={verifyLines}
                terminalLabels={verifyTerminalLabels}
                onRun={runVerify}
                onStop={stopVerify}
            />
            {/* 「探测式填充」弹层见 probe-dialog.tsx：两个范围键 + 记录区 + 三个开关，本文件只递状态与回调 */}
            <ProbeDialog
                t={t}
                open={probeOpen}
                onClose={closeProbe}
                running={busy === 'probe'}
                idle={busy === null}
                scope={probeScope}
                unfilledCount={unfilledCount}
                allCount={allCount}
                onProbe={runProbe}
                onStop={stopProbe}
                autoWrite={probeAutoWrite}
                onAutoWriteChange={setProbeAutoWrite}
                ignoreExcludes={probeIgnoreExcludes}
                onIgnoreExcludesChange={toggleIgnoreExcludes}
                dropUnsupported={probeDropUnsupported}
                onDropUnsupportedChange={setProbeDropUnsupported}
                total={probeTotal}
                lines={probeLines}
                terminalLabels={probeTerminalLabels}
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
