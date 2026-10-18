/**
 * 「探测档位」弹层（浏览器半）：两个发起键 + 记录区 + 三个开关。
 *
 * 没有候选列表——范围由 footer 那两个键与「忽略排除」开关决定，故正文依次是范围提示 → 额度提示 →
 * off 说明 → 记录区 → 三个开关（自动写入 / 忽略排除 / 剔除不支持）；footer 只留取消与两个范围键。
 *
 * 状态与动作全由卡片经 props 递进来，自己不碰 Connection 也不发起探测；「关窗即中止在途探测」记在 `onClose` 上。
 * 理由与样式数值见 docs/decisions.md「探测档位」与 `card-styles.ts`。
 */

import { useMemo } from 'react'
// primitives 由宿主模块表注入
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { TIP_MAX_WIDTH } from '@/client/card-styles'

const { Button, Modal, StateDot, Switch, TerminalBlock, Tooltip, IconInfoOutlineRegular } = primitives

/** 两个探测范围：全部 / 未填充（点开弹层那一刻冻结的那份计划的两个计数） */
type ProbeScope = 'unfilled' | 'all'

interface ProbeDialogProps {
    t: TranslateNS<'settings.modelFix'>
    open: boolean
    /** 关窗即中止在途探测：连接一断，Node 半随即早停并把未跑完的模型还原 */
    onClose: () => void
    /** 在途：两个范围键里在途那个就地变「停止」，另一键禁用，两个开关全禁 */
    running: boolean
    /** 无任何动作在途：与「该范围一个模型都没有」一同决定范围键是否可点 */
    idle: boolean
    /** 本轮正在跑的范围（在途键据此就地变「停止」，剔除开关据此显形地失效） */
    scope: ProbeScope | null
    /** 两个范围各自的模型数；为 0 的键禁用，不做「点了没反应」 */
    unfilledCount: number
    allCount: number
    /** 发起一轮；入参即「只探未填充」，范围键据此下发 */
    onProbe: (unfilledOnly: boolean) => void
    onStop: () => void
    /** 「自动写入」：关闭时探测结束后不写回、仅汇报结论（Node 半把预声明原样收回） */
    autoWrite: boolean
    onAutoWriteChange: (value: boolean) => void
    ignoreExcludes: boolean
    onIgnoreExcludesChange: (ignore: boolean) => void
    dropUnsupported: boolean
    onDropUnsupportedChange: (drop: boolean) => void
    /** 记录区抬头：总项数取自 opened 帧；0 意味还没发起过，故记录区整块不渲染 */
    total: number
    /** 记录区抬头进度段：已完成条数，逐条 probed 帧更新 */
    done: number
    lines: readonly string[]
    terminalLabels: TerminalBlockLabels
}

export function ProbeDialog(props: ProbeDialogProps) {
    const t = props.t
    // join 按 lines 引用缓存：同份行内容的重复渲染不重拼，也不打断 TerminalBlock 内部对整段文本的解析缓存
    const output = useMemo(() => props.lines.join('\n'), [props.lines])
    /** 探测弹层的两个发起键：在途那个就地变成「停止」，另一个禁用——弹层只有这两个入口，收起它们就只剩关闭 */
    const probeButton = (scope: ProbeScope, count: number) => {
        const running = props.running && props.scope === scope
        return (
            <Button
                variant="outline"
                className="dsh-mf-warn"
                disabled={running ? false : !props.idle || count === 0}
                onClick={running ? props.onStop : () => { props.onProbe(scope === 'unfilled') }}
            >
                {/* 在途指示：宿主 Button 自身即 inline-flex + gap，指示器直接作首个子节点。
                    键文本保持短——两个范围的大小由正文那句提示交代 */}
                {running ? <StateDot state="ongoing" /> : null}
                {t(running ? 'probeStop' : scope === 'unfilled' ? 'probeUnfilled' : 'probeAll')}
            </Button>
        )
    }
    return (
        <Modal
            open={props.open}
            onClose={props.onClose}
            title={t('probeTitle')}
            closeLabel={t('close')}
            description={t('probeDesc')}
            className="dsh-mf-verifyDialog"
            footer={<div className="dsh-mf-verifyButtons">
                {/* 取消键在途不禁用：它是本弹层唯一的常驻出口，遮罩 / Escape / × 也都中止。
                    键面文案取「取消」——与验证弹层、卡片底部的取消键同一个词 */}
                <Button variant="outline" data-modal-autofocus onClick={props.onClose}>{t('cancel')}</Button>
                {/* 由宽到窄：先「全部」后「未填充」，从大到小读下来就是范围由大到小的收窄 */}
                {probeButton('all', props.allCount)}
                {probeButton('unfilled', props.unfilledCount)}
            </div>}
        >
            {/* 正文各段的纵向间距一律 12px，由这层容器给出：宿主 .body 无 gap、段靠自身 margin，
                而 flex 容器里 margin 不折叠、紧挨两段会相加（此处「范围提示」与「额度提示」正是紧挨两段） */}
            <div className="dsh-mf-verifyBody">
                {/* 探测范围一句说清：两个数分别对应 footer 那两个键（全量 / 未填充），键文本保持短。
                    两个范围都为空时改说「为何为空」——用户多半是先把提供方排除了 */}
                {props.unfilledCount === 0 && props.allCount === 0 ? (
                    <p className="dsh-mf-verifyEmpty" role="status">{t('probeEmpty')}</p>
                ) : (
                    <p className="dsh-mf-verifyQuota">{t('probePlan', {
                        models: String(props.allCount),
                        unfilled: String(props.unfilledCount),
                    })}</p>
                )}
                <p className="dsh-mf-verifyQuota">{t('probeQuota')}</p>
                {/* off 说明：记录区里 off 的「可用」只判受理，这里先说破，免得把「能通」当成「能关」 */}
                <p className="dsh-mf-verifyQuota">{t('probeOffNote')}</p>
                {/* 记录区排在提示之下、开关之上：它是「正在发生的事」，提示是「这轮会做什么」。
                    首次发起才出现——opened 帧一到即有总项数 */}
                {props.total > 0 ? (
                    <TerminalBlock
                        cwd={t('probe')}
                        command={t('probeCommand', { done: String(props.done), total: String(props.total) })}
                        output={output}
                        running={props.running}
                        maxLines={Infinity}
                        labels={props.terminalLabels}
                        className="dsh-mf-verifyLog"
                    />
                ) : null}
            {/* 三个开关放正文末尾而非 footer：它们是这一轮的参数，与正文里正在发生的事同处一屏 */}
                <div className="dsh-mf-verifyOptions">
                    <span className="dsh-mf-verifyOption">
                        {/* 首位：它决定这轮「探完写不写」，另两个开关只有它开着才谈得上作用 */}
                        <Switch
                            checked={props.autoWrite}
                            disabled={props.running}
                            label={t('probeAutoWrite')}
                            onChange={props.onAutoWriteChange}
                        />
                        <span>{t('probeAutoWrite')}</span>
                        {/* 释义走宿主 Tooltip 原语，锚点复刻瓦片内的 .helpButton；portal 必需（模态层自建层叠上下文会裁掉气泡） */}
                        <Tooltip label={t('probeAutoWriteTip')} side="top" maxWidth={TIP_MAX_WIDTH} portal>
                            <button type="button" className="dsh-mf-help" aria-label={t('probeAutoWriteTip')}>
                                <IconInfoOutlineRegular size={12} />
                            </button>
                        </Tooltip>
                    </span>
                    <span className="dsh-mf-verifyOption">
                        <Switch
                            checked={props.ignoreExcludes}
                            disabled={props.running}
                            label={t('probeIgnoreExcludes')}
                            onChange={props.onIgnoreExcludesChange}
                        />
                        <span>{t('probeIgnoreExcludes')}</span>
                        <Tooltip label={t('probeIgnoreExcludesTip')} side="top" maxWidth={TIP_MAX_WIDTH} portal>
                            <button type="button" className="dsh-mf-help" aria-label={t('probeIgnoreExcludesTip')}>
                                <IconInfoOutlineRegular size={12} />
                            </button>
                        </Tooltip>
                    </span>
                    <span className="dsh-mf-verifyOption">
                        <Switch
                            checked={props.dropUnsupported}
                            // 跑「未填充」时一并禁掉（这一轮压根不读它）；「自动写入」关闭时同样禁掉
                            disabled={props.running || props.scope === 'unfilled' || !props.autoWrite}
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
            </div>
        </Modal>
    )
}
