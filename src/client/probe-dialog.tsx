/**
 * 「探测式填充」弹层（浏览器半）：两个发起键 + 记录区 + 三个开关。
 *
 * 没有候选列表——范围由 footer 那两个键与「忽略排除」开关决定，故正文依次是
 * 记录区（首次发起才出现，与验证同纪律）→ 范围提示 → 额度提示 → 三个开关
 * （自动写入 / 忽略排除 / 剔除不支持）；
 * footer 只留三键，直接吃宿主 .footer 的 flex-end 右对齐，不必自绘行容器。
 *
 * 抽出来的理由与 `verify-dialog.tsx` 同源：弹层是一块自足的展示，范围、开关、记录区内容与
 * 发起 / 中止的回调全由卡片经 props 递进来，自己不碰 Connection 也不发起探测。
 * 「关窗即中止在途探测」这条纪律记在 `onClose` 上。
 */

import { useMemo } from 'react'
// primitives 由宿主模块表注入
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { TIP_MAX_WIDTH, VERIFY_TERMINAL_LINES } from '@/client/card-styles'

const { Button, Modal, StateDot, Switch, TerminalBlock, Tooltip, IconInfoOutlineRegular } = primitives

/** 两个探测范围：全部 / 未填充（点开弹层那一刻冻结的那份计划的两个计数） */
export type ProbeScope = 'unfilled' | 'all'

export interface ProbeDialogProps {
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
    /** 「自动写入」：关闭时探测结束后不写回、仅汇报结论（Node 半把预声明原样收回，`fill` 为「可补全」假设统计） */
    autoWrite: boolean
    onAutoWriteChange: (value: boolean) => void
    ignoreExcludes: boolean
    onIgnoreExcludesChange: (ignore: boolean) => void
    dropUnsupported: boolean
    onDropUnsupportedChange: (drop: boolean) => void
    /** 记录区抬头：总项数取自 opened 帧；0 意味还没发起过，故记录区整块不渲染 */
    total: number
    lines: readonly string[]
    terminalLabels: TerminalBlockLabels
}

export function ProbeDialog(props: ProbeDialogProps) {
    const t = props.t
    // 行数组换引用时才重拼：整轮 1400 帧、每帧一次重渲染，逐帧重拼整段输出是 O(n²)
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
                    键文本保持短——两个范围的大小由正文那句提示交代，不往键上堆 */}
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
                {/* 取消键在途不禁用：它是本弹层唯一的常驻出口，遮罩 / Escape / × 也都中止，
                    键却禁着就只剩「干等」一条路。键面文案取「取消」而非「关闭」——与验证弹层、卡片底部
                    的取消键同一个词，两个弹层的退出动作在用户眼里就是同一件事 */}
                <Button variant="outline" data-modal-autofocus onClick={props.onClose}>{t('cancel')}</Button>
                {/* 由宽到窄：先「全部」后「未填充」，两个键各带自己的模型数，
                    从大到小读下来就是这一轮的范围由大到小的收窄 */}
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
                {/* 记录区排在提示之下、开关之上，与验证弹层同序：它是「正在发生的事」，
                    提示是「这轮会做什么」，两者挨着放才读得顺；反过来就成了在两段静态说明中间夹一块滚动区域。
                    首次发起才出现——opened 帧一到即有总项数，先于此则没有任何进度可展示 */}
                {props.total > 0 ? (
                    <TerminalBlock
                        command={t('probeCommand', { total: String(props.total) })}
                        output={output}
                        running={props.running}
                        maxLines={VERIFY_TERMINAL_LINES}
                        labels={props.terminalLabels}
                        className="dsh-mf-verifyLog"
                    />
                ) : null}
            {/* 三个开关放正文末尾而非 footer：它们是这一轮的参数（是否写回、探测范围与收敛口径），
                    与正文里正在发生的事同处一屏，改动即刻可见；footer 因此只剩「取消 / 探测」，
                    与其余弹层「footer 只放取消与确认」的形态一致 */}
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
                            // 跑「未填充」时一并禁掉：这一轮压根不读它（见卡片侧 onProbe），让开关显形地失效，
                            // 好过留一个亮着的开关骗人——用户在途时看得见这一轮是「只增不剔」。
                            // 「自动写入」关闭时同样禁掉：整轮不落结论，收敛口径无从谈起
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