/**
 * 「验证模型」弹层（浏览器半）：两个选项卡（模型列表 / 验证记录）+ 底部动作行。
 *
 * 结构逐条照官方 models 页「获取可用模型」的候选框（title / desc / 候选列表 / 底部取消 + 采用），
 * 按需求去掉其「搜索 — 全选」工具条一行；改为列表下方一条 warn 额度提示，底部左侧加「验证推理级别」开关。
 * 选项卡条则逐条复刻官方「设置 → 内置插件」的插件视图选项卡（PluginsSettingsSection）：记录区是「正在
 * 发生的事」，与「挑哪些模型去验」摆在一屏里只会互相挤，故把它单列一页。
 *
 * 抽出来的理由：弹层是一块自足的展示，它的所有状态与动作都由卡片经 props 递进来
 * （勾选集、档位开关、记录区内容、发跑与中止的回调），自己不碰 Connection 也不发起探测。
 * 留在卡片里只会让那个已经很长的组件再长一百行，且弹层的形态改动（列表密度、选项卡分页）
 * 与卡片的状态机毫无关系。关窗即中止在途验证这条纪律记在 props 上：取消键、遮罩、Escape、×
 * 四者走的是同一个回调，故四者在途都不禁用。
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
// primitives 由宿主模块表注入
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { TIP_MAX_WIDTH, VERIFY_TERMINAL_LINES } from '@/client/card-styles'
import type { CardKey } from '@/client/locale-keys'
import { groupAllPicked, verifyKey } from '@/client/model'
import type { VerifyCandidate } from '@/client/model'

const { Button, Modal, StateDot, Switch, TerminalBlock, Tooltip, IconInfoOutlineRegular } = primitives

/** 选项卡 id：既作页签/面板的 DOM id 后缀（aria-controls 与之配对），也作当前页的状态值 */
type VerifyTab = 'models' | 'records'

const TABS: readonly { id: VerifyTab; label: CardKey }[] = [
    { id: 'models', label: 'verifyTabModels' },
    { id: 'records', label: 'verifyTabRecords' },
]

/** 按提供方归组后的候选：一组 = 一个提供方 + 它的候选模型（组内顺序即录入顺序） */
export interface VerifyGroup {
    readonly provider: string
    readonly models: readonly VerifyCandidate[]
}

export interface VerifyDialogProps {
    t: TranslateNS<'settings.modelFix'>
    open: boolean
    /** 关窗即中止在途验证：连接一断，Node 半的执行循环随即早停，不会在用户离开之后继续烧额度。
     *  取消键 / 遮罩 / Escape / × 都落到这一个回调上，故在途也照常可点 */
    onClose: () => void
    /** 在途（卡片 busy 判为 verify）：键就地变「停止」，列表与开关全禁 */
    running: boolean
    /** 无任何动作在途（卡片 busy 为空）：与「未勾选任何模型」一同决定发起键是否可点 */
    idle: boolean
    /** 候选按提供方归组；传原始候选也行，本层自会归组（归组是纯展示关切） */
    candidates: readonly VerifyCandidate[]
    picked: ReadonlySet<string>
    onTogglePick: (key: string) => void
    onToggleGroup: (models: readonly VerifyCandidate[]) => void
    efforts: boolean
    onEffortsChange: (efforts: boolean) => void
    /** 记录区抬头：总项数取自 opened 帧；0 意味还没发起过，故记录面板给一行空态而非记录区 */
    total: number
    lines: readonly string[]
    terminalLabels: TerminalBlockLabels
    onRun: () => void
    onStop: () => void
}

export function VerifyDialog(props: VerifyDialogProps) {
    const t = props.t
    // 选项卡三件套照官方 PluginsSettingsSection：useId 出前缀、ref 收页签、当前页只作本层状态（不回头写卡片）
    const tabsId = useId()
    const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
    const [tab, setTab] = useState<VerifyTab>('models')
    // 每次开窗都回「模型列表」：关窗已丢弃上一轮的勾选与记录（见卡片 closeVerify），落在空记录页只会让人以为记录还在
    useEffect(() => { if (props.open) setTab('models') }, [props.open])
    // running 期间等 total>0（TerminalBlock 可渲染）再切记录页，避免先看到空态闪烁
    useEffect(() => { if (props.running && props.total > 0) setTab('records') }, [props.running, props.total])
    // 按提供方归组渲染：候选本就是「提供方内聚」的录入顺序，取相邻同提供方成组即可，无需再分桶
    const groups = useMemo<VerifyGroup[]>(() => {
        const grouped: { provider: string; models: VerifyCandidate[] }[] = []
        for (const candidate of props.candidates) {
            const last = grouped[grouped.length - 1]
            if (last !== undefined && last.provider === candidate.provider) last.models.push(candidate)
            else grouped.push({ provider: candidate.provider, models: [candidate] })
        }
        return grouped
    }, [props.candidates])
    // 键盘行为同官方：左右方向键循环、Home / End 跳首尾，切页后把焦点落到目标页签上
    const onTabKeyDown = (index: number, event: KeyboardEvent<HTMLButtonElement>) => {
        let nextIndex: number
        switch (event.key) {
            case 'ArrowRight': nextIndex = (index + 1) % TABS.length; break
            case 'ArrowLeft': nextIndex = (index - 1 + TABS.length) % TABS.length; break
            case 'Home': nextIndex = 0; break
            case 'End': nextIndex = TABS.length - 1; break
            default: return
        }
        event.preventDefault()
        setTab(TABS[nextIndex].id)
        tabRefs.current[nextIndex]?.focus()
    }
    return (
        <Modal
            open={props.open}
            onClose={props.onClose}
            title={t('verifyTitle')}
            closeLabel={t('close')}
            description={t('verifyDesc')}
            className="dsh-mf-verifyDialog"
            footer={
                /* 宿主 .footer 是单行 flex、无 wrap、且 justify-content 为 flex-end。弹层加宽后档位开关与两键
                    并排同一行、开关靠左两键靠右，故在 footer 内自绘容器覆盖宿主那三个数值。
                    记录区不在这一行下方——它已自成一个选项卡面板（见正文） */
                <div className="dsh-mf-verifyActions">
                    <span className="dsh-mf-verifyOption">
                        <Switch
                            checked={props.efforts}
                            disabled={props.running}
                            label={t('verifyEfforts')}
                            onChange={props.onEffortsChange}
                        />
                        <span>{t('verifyEfforts')}</span>
                        {/* 释义走宿主 Tooltip 原语，锚点复刻瓦片内的 .helpButton；portal 必需（模态层自建层叠上下文会裁掉气泡） */}
                        <Tooltip label={t('verifyEffortsTip')} side="top" maxWidth={TIP_MAX_WIDTH} portal>
                            <button type="button" className="dsh-mf-help" aria-label={t('verifyEffortsTip')}>
                                <IconInfoOutlineRegular size={12} />
                            </button>
                        </Tooltip>
                    </span>
                    <div className="dsh-mf-verifyButtons">
                        {/* 在途不禁用：遮罩 / Escape / × 本就任何时刻都能关窗并中止（宿主 Modal 只管调 onClose），
                            键若在途禁用，它反成唯一关不掉的出口。点它与那三者同一条路径：
                            props.onClose → 卡片的 closeVerify 先 abort 再清勾选与记录 */}
                        <Button variant="outline" data-modal-autofocus onClick={props.onClose}>{t('cancel')}</Button>
                        {/* 判据为三态，与 probe-dialog.tsx 的两个范围键同形：本键在途 → 放行（它已是「停止」），
                            其余非空闲一律禁——那时点它会被卡片 runVerify 的 `if (busy) return` 挡下，不做「点了没反应」 */}
                        <Button
                            variant="outline"
                            className="dsh-mf-warn"
                            disabled={props.running ? false : !props.idle || props.picked.size === 0}
                            onClick={() => {
                                // 发跑由 useEffect 自动跳记录页（等首条记录数据到达再跳）
                                if (props.running) props.onStop()
                                else props.onRun()
                            }}
                        >
                            {/* 在途指示：宿主 Button 自身即 inline-flex + gap，指示器直接作首个子节点；
                                StateDot 的 ongoing 态就是侧边栏会话列表项左侧那个转圈（同原语、同动效） */}
                            {props.running ? <StateDot state="ongoing" /> : null}
                            {t(props.running ? 'verifyStop' : 'verifyGo')}
                        </Button>
                    </div>
                </div>
            }
        >
            {/* 正文纵向节奏一律 12px：额度提示、选项卡条、当前面板是相邻三段（宿主 .body 无 gap，故由这层容器给出） */}
            <div className="dsh-mf-verifyBody">
                {/* 额度提示对两页都成立，故留在选项卡条之上、不进任何一个面板 */}
                <p className="dsh-mf-verifyQuota">{t('verifyQuota')}</p>
                {/* 选项卡条逐条复刻官方 PluginsSettingsSection：role/aria 串、选中态走 data-active、
                    未选中的页签 tabIndex:-1（只靠方向键进出），指示条的样式见 card-styles.ts */}
                <div className="dsh-mf-verifyTabs" role="tablist" aria-label={t('verifyTitle')}>
                    {TABS.map((row, index) => {
                        const selected = row.id === tab
                        return (
                            <button
                                key={row.id}
                                ref={(element) => { tabRefs.current[index] = element }}
                                id={`${tabsId}-tab-${row.id}`}
                                type="button"
                                role="tab"
                                className="dsh-mf-verifyTab"
                                aria-selected={selected}
                                aria-controls={`${tabsId}-panel-${row.id}`}
                                data-active={selected ? 'true' : undefined}
                                tabIndex={selected ? 0 : -1}
                                onClick={() => { setTab(row.id) }}
                                onKeyDown={(event) => { onTabKeyDown(index, event) }}
                            >
                                {t(row.label)}
                            </button>
                        )
                    })}
                </div>
                {/* 两个面板都常驻挂载、切页只改 hidden（官方那份 visitedIds 的同一用意）：记录区的 TerminalBlock
                    自带展开/收起状态，卸载即丢；hidden 的面板即 display:none、不是 flex 项，换页不留空段 */}
                <div
                    id={`${tabsId}-panel-models`}
                    className="dsh-mf-verifyPanel"
                    role="tabpanel"
                    aria-labelledby={`${tabsId}-tab-models`}
                    hidden={tab !== 'models'}
                >
                    {groups.length === 0 ? (
                        <p className="dsh-mf-verifyEmpty" role="status">{t('verifyEmpty')}</p>
                    ) : (
                        <ul className="dsh-mf-verifyList">
                            {groups.map((group) => [
                                <li key={`g-${group.provider}`} className="dsh-mf-verifyGroup">
                                    {group.provider}
                                    {/* 分组全选键：组件、尺寸与文案语义逐条照官方 candidateToolbar 的 ghost 小键 */}
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="dsh-mf-verifyGroupAll"
                                        disabled={props.running}
                                        onClick={() => { props.onToggleGroup(group.models) }}
                                    >
                                        {groupAllPicked(props.picked, group.models) ? t('verifyDeselectAll') : t('verifySelectAll')}
                                    </Button>
                                </li>,
                                ...group.models.map((candidate) => {
                                    const key = verifyKey(candidate.provider, candidate.model)
                                    return (
                                        <li key={key} className="dsh-mf-verifyRow">
                                            {/* 官方候选行同构：label 内 checkbox + 等宽模型 id，点整行即切换 */}
                                            <label className="dsh-mf-verifyLabel">
                                                <input
                                                    type="checkbox"
                                                    checked={props.picked.has(key)}
                                                    disabled={props.running}
                                                    onChange={() => { props.onTogglePick(key) }}
                                                />
                                                <span className="dsh-mf-verifyId" title={candidate.model}>{candidate.model}</span>
                                            </label>
                                        </li>
                                    )
                                }),
                            ])}
                        </ul>
                    )}
                </div>
                <div
                    id={`${tabsId}-panel-records`}
                    className="dsh-mf-verifyPanel"
                    role="tabpanel"
                    aria-labelledby={`${tabsId}-tab-records`}
                    hidden={tab !== 'records'}
                >
                    {/* 记录区就在本页：opened 帧一到即有总项数，先于此则没有进度可展示，故空态占位 */}
                    {props.total > 0 ? (
                        <TerminalBlock
                            command={t('verifyCommand', { total: String(props.total) })}
                            output={props.lines.join('\n')}
                            running={props.running}
                            maxLines={VERIFY_TERMINAL_LINES}
                            labels={props.terminalLabels}
                            className="dsh-mf-verifyLog"
                        />
                    ) : (
                        <p className="dsh-mf-verifyEmpty">{t('verifyRecordEmpty')}</p>
                    )}
                </div>
            </div>
        </Modal>
    )
}