/**
 * 「探测档位」弹层（浏览器半）：`DiagnoseDialog` 外壳的组装层——
 * 两个开关经 `extras` 插槽渲染在选项卡容器之下，选项卡行右侧快捷勾选键经 `tools` 递入。
 */

import { useMemo } from 'react'
// primitives 由宿主模块表注入
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { DiagnoseDialog } from '@/client/diagnose-dialog'
import type { DiagnoseTool } from '@/client/diagnose-dialog'
import type { VerifyCandidate } from '@/client/model'
import { TIP_MAX_WIDTH } from '@/client/card-styles'

const { Switch, Tooltip, IconInfoOutlineRegular } = primitives

interface ProbeDialogProps {
    t: TranslateNS<'settings.modelFix'>
    open: boolean
    /** 关窗即中止在途探测：连接一断，Node 半随即早停并把未跑完的模型还原 */
    onClose: () => void
    /** 在途（卡片 busy 判为 probe）：主键就地变「停止」，列表、小键与开关全禁 */
    running: boolean
    /** 无任何动作在途（卡片 busy 为空）：与「未勾选任何模型」一同决定发起键是否可点 */
    idle: boolean
    /** 候选按提供方归组（外壳自会归组，传原始候选即可） */
    candidates: readonly VerifyCandidate[]
    picked: ReadonlySet<string>
    onTogglePick: (key: string) => void
    onToggleGroup: (models: readonly VerifyCandidate[]) => void
    /** 选项卡行右侧小键：选择未填充 / 全选（由卡片组装，含各自的文案判据） */
    tools: readonly DiagnoseTool[]
    /** 「自动写入」：关闭时探测结束后不写回、仅汇报结论（Node 半把预声明原样收回） */
    autoWrite: boolean
    onAutoWriteChange: (value: boolean) => void
    dropUnsupported: boolean
    onDropUnsupportedChange: (drop: boolean) => void
    /** 记录区抬头：总项数取自 opened 帧；0 意味还没发起过 */
    total: number
    /** 记录区抬头进度段：已完成条数，逐条 probed 帧更新 */
    done: number
    lines: readonly string[]
    terminalLabels: TerminalBlockLabels
    onRun: () => void
    onStop: () => void
}

export function ProbeDialog(props: ProbeDialogProps) {
    const t = props.t
    const extras = useMemo(() => (
        <div className="dsh-mf-verifyOptions">
            <span className="dsh-mf-verifyOption">
                <Switch
                    checked={props.autoWrite}
                    disabled={props.running}
                    label={t('probeAutoWrite')}
                    onChange={props.onAutoWriteChange}
                />
                <span>{t('probeAutoWrite')}</span>
                {/* portal 必需（缺失会被模态层层叠上下文裁掉气泡） */}
                <Tooltip label={t('probeAutoWriteTip')} side="top" maxWidth={TIP_MAX_WIDTH} portal>
                    <button type="button" className="dsh-mf-help" aria-label={t('probeAutoWriteTip')}>
                        <IconInfoOutlineRegular size={12} />
                    </button>
                </Tooltip>
            </span>
            <span className="dsh-mf-verifyOption">
                <Switch
                    checked={props.dropUnsupported}
                    disabled={props.running || !props.autoWrite}
                    label={t('probeDropUnsupported')}
                    onChange={props.onDropUnsupportedChange}
                />
                <span>{t('probeDropUnsupported')}</span>
                <Tooltip label={t('probeDropUnsupportedTip')} side="top" maxWidth={TIP_MAX_WIDTH} portal>
                    <button type="button" className="dsh-mf-help" aria-label={t('probeDropUnsupportedTip')}>
                        <IconInfoOutlineRegular size={12} />
                    </button>
                </Tooltip>
            </span>
        </div>
    ), [t, props.running, props.autoWrite, props.dropUnsupported, props.onAutoWriteChange, props.onDropUnsupportedChange])
    return (
        <DiagnoseDialog
            t={t}
            titleKey="probeTitle"
            descriptionKey="probeDesc"
            quotaKey="probeQuota"
            modelsTabKey="verifyTabModels"
            recordsTabKey="probeTabRecords"
            listEmptyKey="verifyEmpty"
            terminalCwdKey="probe"
            terminalCommandKey="probeCommand"
            runKey="probeGo"
            stopKey="probeStop"
            open={props.open}
            onClose={props.onClose}
            running={props.running}
            idle={props.idle}
            candidates={props.candidates}
            picked={props.picked}
            onTogglePick={props.onTogglePick}
            onToggleGroup={props.onToggleGroup}
            tools={props.tools}
            extras={extras}
            total={props.total}
            done={props.done}
            lines={props.lines}
            terminalLabels={props.terminalLabels}
            onRun={props.onRun}
            onStop={props.onStop}
        />
    )
}
