/**
 * 诊断弹层的自足外壳 `DiagnoseDialog`（浏览器半）：「验证模型」与「探测档位」共用。
 *
 * 主体同构——两个选项卡（模型列表 / 验证或探测记录）+ 选项卡行右侧小键 + 底部动作行——收在这一份
 * JSX 里，差异只有数据与文案，显式列成 props（模式同 confirm.tsx 的 ConfirmModal）：tab 名、空态与
 * 额度提示等文案键、选项卡行右侧小键、正文插槽（`extras`，渲染在选项卡条与面板之间）与两个回调。
 * 选项卡条的 role / aria / 键盘行为逐条复刻官方「内置插件」的插件视图选项卡。
 *
 * 状态与动作全由卡片经 props 递进来，自己不碰 Connection 也不发起诊断；关窗即中止在途这条纪律
 * 记在 `onClose` 上，取消键、遮罩、Escape、× 四者走同一回调。
 * 在途期间自动切到记录页、跑完不关窗；理由与样式数值见 docs/decisions.md 与 `card-styles.ts`。
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
// primitives 由宿主模块表注入
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CardKey } from '@/client/locale-keys'
import { groupAllPicked, verifyKey } from '@/client/model'
import type { VerifyCandidate } from '@/client/model'

const { Button, Modal, StateDot, TerminalBlock } = primitives

/** 选项卡 id：既作页签/面板的 DOM id 后缀（aria-controls 与之配对），也作当前页的状态值 */
type DiagnoseTab = 'models' | 'records'

/** 选项卡行右侧的小键：文案与动作由调用方给（如全列表「全选 / 取消全选」），在途一律禁用 */
export interface DiagnoseTool {
    label: string
    onClick: () => void
    /** 候选为空等情形下不渲染该键 */
    hidden?: boolean
}

interface DiagnoseDialogProps {
    t: TranslateNS<'settings.modelFix'>
    /** 弹层标题，也作选项卡条的 aria-label */
    titleKey: CardKey
    descriptionKey: CardKey
    /** 额度提示：对两页都成立，故留在选项卡条之上、不进任何一个面板 */
    quotaKey: CardKey
    modelsTabKey: CardKey
    recordsTabKey: CardKey
    listEmptyKey: CardKey
    recordsEmptyKey: CardKey
    /** 记录区抬头：cwd 取功能名、command 是进度段（done/total 逐帧更新） */
    terminalCwdKey: CardKey
    terminalCommandKey: CardKey
    /** 在途主键就地变「停止」，两态各一个文案键 */
    runKey: CardKey
    stopKey: CardKey
    open: boolean
    /** 关窗即中止在途诊断：连接一断，Node 半的执行循环随即早停。取消键 / 遮罩 / Escape / × 都落到这一个回调上 */
    onClose: () => void
    /** 在途（卡片 busy 判为本功能）：键就地变「停止」，列表与小键全禁 */
    running: boolean
    /** 无任何动作在途（卡片 busy 为空）：与「未勾选任何模型」一同决定发起键是否可点 */
    idle: boolean
    /** 候选按提供方归组；传原始候选也行，本层自会归组（归组是纯展示关切） */
    candidates: readonly VerifyCandidate[]
    picked: ReadonlySet<string>
    onTogglePick: (key: string) => void
    onToggleGroup: (models: readonly VerifyCandidate[]) => void
    /** 选项卡行右侧小键；渲染顺序即数组序 */
    tools?: readonly DiagnoseTool[]
    /** 正文插槽：渲染在选项卡行与面板之间（如探测的开关组——切页不丢，故放弹层级而非面板内） */
    extras?: React.ReactNode
    /** 记录区抬头：总项数取自 opened 帧；0 意味还没发起过，故记录面板给一行空态而非记录区 */
    total: number
    /** 记录区抬头进度段：已完成条数，逐条 probed 帧更新 */
    done: number
    lines: readonly string[]
    terminalLabels: TerminalBlockLabels
    onRun: () => void
    onStop: () => void
}

export function DiagnoseDialog(props: DiagnoseDialogProps) {
    const t = props.t
    // join 按 lines 引用缓存：同份行内容的重复渲染不重拼，也不打断 TerminalBlock 内部对整段文本的解析缓存
    const output = useMemo(() => props.lines.join('\n'), [props.lines])
    // 选项卡三件套照官方 PluginsSettingsSection：useId 出前缀、ref 收页签、当前页只作本层状态（不回头写卡片）
    const tabsId = useId()
    const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
    const [tab, setTab] = useState<DiagnoseTab>('models')
    // 每次开窗都回「模型列表」：关窗已丢弃上一轮的勾选与记录，落在空记录页只会让人以为记录还在
    useEffect(() => { if (props.open) setTab('models') }, [props.open])
    // running 期间等 total>0（TerminalBlock 可渲染）再切记录页，避免先看到空态闪烁
    useEffect(() => { if (props.running && props.total > 0) setTab('records') }, [props.running, props.total])
    // 按提供方归组渲染：候选本就是「提供方内聚」的录入顺序，取相邻同提供方成组即可
    const groups = useMemo(() => {
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
            case 'ArrowRight': nextIndex = (index + 1) % 2; break
            case 'ArrowLeft': nextIndex = (index - 1 + 2) % 2; break
            case 'Home': nextIndex = 0; break
            case 'End': nextIndex = 1; break
            default: return
        }
        event.preventDefault()
        setTab(nextIndex === 0 ? 'models' : 'records')
        tabRefs.current[nextIndex]?.focus()
    }
    const tabs: readonly { id: DiagnoseTab; label: CardKey }[] = [
        { id: 'models', label: props.modelsTabKey },
        { id: 'records', label: props.recordsTabKey },
    ]
    return (
        <Modal
            open={props.open}
            onClose={props.onClose}
            title={t(props.titleKey)}
            closeLabel={t('close')}
            description={t(props.descriptionKey)}
            className="dsh-mf-verifyDialog"
            footer={
                /* 宿主 .footer 是单行 flex、无 wrap、justify-content 为 flex-end + gap 8px，两键靠右即得 */
                <div className="dsh-mf-verifyButtons">
                    {/* 在途不禁用：遮罩 / Escape / × 本就任何时刻都能关窗并中止，键若在途禁用，它反成唯一关不掉的出口 */}
                    <Button variant="outline" data-modal-autofocus onClick={props.onClose}>{t('cancel')}</Button>
                    {/* 判据为三态：本键在途 → 放行（它已是「停止」），其余非空闲一律禁 */}
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
                        {/* 在途指示：宿主 Button 自身即 inline-flex + gap，指示器直接作首个子节点 */}
                        {props.running ? <StateDot state="ongoing" /> : null}
                        {t(props.running ? props.stopKey : props.runKey)}
                    </Button>
                </div>
            }
        >
            {/* 正文纵向节奏一律 12px：额度提示、选项卡行、当前面板是相邻三段（宿主 .body 无 gap，故由这层容器给出） */}
            <div className="dsh-mf-verifyBody">
                <p className="dsh-mf-verifyQuota">{t(props.quotaKey)}</p>
                {/* 选项卡行：选项卡条居左（role/aria 串、选中态走 data-active、未选中的页签 tabIndex:-1
                    只靠方向键进出），右端是调用方给的小键 */}
                <div className="dsh-mf-verifyTabsRow">
                    <div className="dsh-mf-verifyTabs" role="tablist" aria-label={t(props.titleKey)}>
                        {tabs.map((row, index) => {
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
                    {props.tools?.filter((tool) => !tool.hidden).map((tool) => (
                        <Button
                            key={tool.label}
                            variant="ghost"
                            size="sm"
                            className="dsh-mf-verifyListAll"
                            disabled={props.running}
                            onClick={tool.onClick}
                        >
                            {tool.label}
                        </Button>
                    ))}
                </div>
                {props.extras}
                {/* 两个面板都常驻挂载、切页只改 hidden（官方那份 visitedIds 的同一用意）：记录区的 TerminalBlock
                    输出区带滚动位置，卸载即丢；hidden 即 display:none、不是 flex 项，换页不留空段 */}
                <div
                    id={`${tabsId}-panel-models`}
                    className="dsh-mf-verifyPanel"
                    role="tabpanel"
                    aria-labelledby={`${tabsId}-tab-models`}
                    hidden={tab !== 'models'}
                >
                    {groups.length === 0 ? (
                        <p className="dsh-mf-verifyEmpty" role="status">{t(props.listEmptyKey)}</p>
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
                            cwd={t(props.terminalCwdKey)}
                            command={t(props.terminalCommandKey, { done: String(props.done), total: String(props.total) })}
                            output={output}
                            running={props.running}
                            maxLines={Infinity}
                            labels={props.terminalLabels}
                            className="dsh-mf-verifyLog"
                        />
                    ) : (
                        <p className="dsh-mf-verifyEmpty">{t(props.recordsEmptyKey)}</p>
                    )}
                </div>
            </div>
        </Modal>
    )
}
