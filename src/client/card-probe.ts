/**
 * 「探测档位」的整轮编排 hook（浏览器半）：三个开关、点开弹层时冻结的候选计划、
 * 记录区、发跑（两个范围）/ 停止 / 关窗。只编排，不渲染——弹层本体见 `probe-dialog.tsx`；
 * busy 由卡片传入并与其余写操作共用同一互斥，补全结果与失败提示经 `onNotice` 落卡片状态行。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { errorText } from '@/shared/errors'
import type { VerifyProgressUpdate, VerifySummary } from '@/shared/verify-progress'
import { probeCandidatesOf, probeTargetsOf } from '@/client/model'
import type { VerifyTarget } from '@/client/model'
import { truncateMessage } from '@/client/card-notice'
import type { CardBusy, Notice } from '@/client/card-notice'
import { terminalLabelsOf, verifyLineOf } from '@/client/card-records'

/** 本轮跑的是哪个键：在途那个键就地变「停止」，故得记住发起时的选择 */
export type ProbeScope = 'unfilled' | 'all'

export interface ProbeRunOptions {
    t: TranslateNS<'settings.modelFix'>
    /** 卡片的全局占用态：发起前置位、收尾清空，与其余写操作互斥 */
    busy: CardBusy
    setBusy: (busy: CardBusy) => void
    /** 卡片当前显示值里的排除列表（所见即所得：与「命中」判定同源） */
    excludes: readonly string[]
    /** llm-pi-ai user 层（此刻最新值）：发跑当刻拍候选 */
    user: unknown
    /** 发起一轮探测（Node 半经进度流回帧）；返回 undefined = 被中止 */
    probeEfforts: (
        models: readonly VerifyTarget[],
        options: { ignoreExcludes: boolean; dropUnsupported: boolean; autoWrite: boolean },
        onFrame: (frame: VerifyProgressUpdate) => void,
        signal: AbortSignal,
    ) => Promise<VerifySummary | undefined>
    /** 「自动写入」开启时：补全结果落卡片状态行（成功） */
    onNotice: (notice: Notice) => void
}

export function useProbeRun(options: ProbeRunOptions) {
    const { t } = options
    // 「探测档位」弹层：三个开关 + 点开弹层那一刻冻结的候选清单（两个键各一份）+ 记录区。
    // 候选清单冻结在点开时而非渲染时：弹层开着期间用户改了配置也不影响本轮
    const [open, setOpen] = useState(false)
    const [ignoreExcludes, setIgnoreExcludes] = useState(false)
    const [dropUnsupported, setDropUnsupported] = useState(false)
    // 「自动写入」默认开启，且每次开窗重置为开（见 onOpen）
    const [autoWrite, setAutoWrite] = useState(true)
    const [plan, setPlan] = useState<{ unfilled: readonly VerifyTarget[]; all: readonly VerifyTarget[] } | null>(null)
    const [scope, setScope] = useState<ProbeScope | null>(null)
    const [lines, setLines] = useState<readonly string[]>([])
    const [total, setTotal] = useState(0)
    const [done, setDone] = useState(0)
    const [stopped, setStopped] = useState(false)
    const abort = useRef<AbortController | null>(null)
    useEffect(() => () => { abort.current?.abort() }, [])
    const terminalLabels = useMemo<TerminalBlockLabels>(
        () => ({ ...terminalLabelsOf(t), done: stopped ? t('verifyStopped') : t('terminalDone') }),
        [t, stopped],
    )

    /**
     * 按当前状态算两份候选计划（未填充 / 全部）：模型列表取**此刻**的最新值；排除值用卡片当前
     * 显示的那份（与「命中」判定同源），`ignore` 同时管 Node 半的两次写回，两边必须是同一个值。
     */
    const planOf = (ignore: boolean) => {
        const pick = (unfilledOnly: boolean): readonly VerifyTarget[] => probeTargetsOf(probeCandidatesOf(options.user, {
            excludes: options.excludes,
            ignoreExcludes: ignore,
            unfilledOnly,
        }))
        return { unfilled: pick(true), all: pick(false) }
    }
    /** 探测档位：点开弹层并当场冻结计划。弹层开着期间配置再变也不改本轮（记录区的总项数照这份计划走） */
    const onOpen = () => {
        if (options.busy !== null) return
        setPlan(planOf(ignoreExcludes))
        // 「自动写入」每次开窗重置为开：它是本轮的模式选择，带着上一轮的取值出现会与用户对不上
        setAutoWrite(true)
        setOpen(true)
    }
    // 切「忽略排除」要重算计划：探测范围随它变，两个键上的模型数与记录区的总项数都得跟着变
    const toggleIgnoreExcludes = (value: boolean) => {
        setIgnoreExcludes(value)
        setPlan(planOf(value))
    }
    /**
     * 跑一轮探测档位。跑完不关窗：结论追加进记录区后留在窗内由用户自行关窗；
     * 「自动写入」开启时补全结果另落卡片状态行，关闭时换措辞报「可补全多少、未执行写入」。
     */
    const run = (unfilledOnly: boolean) => {
        if (options.busy !== null || plan === null) return
        const models = unfilledOnly ? plan.unfilled : plan.all
        if (models.length === 0) return
        setLines([])
        setTotal(0)
        setDone(0)
        setStopped(false)
        options.setBusy('probe')
        const controller = new AbortController()
        abort.current = controller
        setScope(unfilledOnly ? 'unfilled' : 'all')
        // 记下本次的「自动写入」取值：结果回来时不能现读，否则收尾文案会张冠李戴
        const autoWriteValue = autoWrite
        // 「剔除不支持」只对「探测所有」有意义：未填充的模型本来就没声明过档位，没什么可剔，
        // 故这一档强制按关处理，不把用户的选择悄悄带进下一轮
        options.probeEfforts(models, { ignoreExcludes, dropUnsupported: unfilledOnly ? false : dropUnsupported, autoWrite: autoWriteValue }, (frame) => {
            if (frame.type === 'opened') {
                setTotal(frame.total)
                return
            }
            setDone(frame.done)
            setLines((current) => [...current, verifyLineOf(frame, t)])
        }, controller.signal)
            .then((summary) => {
                if (summary === undefined) {
                    setStopped(true)
                    return
                }
                const fill = summary.fill
                const stats = t('probeDone', {
                    models: String(summary.tested),
                    levels: String(summary.plannedEfforts),
                    usable: String(summary.efforts),
                    unsupported: String(summary.unsupported),
                })
                setLines((current) => [...current, stats])
                // 只有「自动写入」开启才落卡片状态行——没写回就没有「已补全」可言
                if (autoWriteValue) {
                    const filled = t('probeFilled', {
                        models: String(fill?.models ?? 0),
                        added: String(fill?.added ?? 0),
                        removed: String(fill?.removed ?? 0),
                    })
                    options.onNotice({ text: filled, tone: 'success' })
                    setLines((current) => [...current, filled])
                } else {
                    // 关闭自动写入：Node 半没落盘，这里换措辞交代「可补全多少」，与已写入的分支区分
                    const held = t('probeFillSkipped', {
                        models: String(fill?.models ?? 0),
                        added: String(fill?.added ?? 0),
                        removed: String(fill?.removed ?? 0),
                    })
                    setLines((current) => [...current, held])
                }
            })
            .catch((error: unknown) => {
                const failed = t('probeFillFailed', { message: truncateMessage(errorText(error)) })
                options.onNotice({ text: failed, tone: 'error' })
                setLines((current) => [...current, failed])
            })
            .finally(() => {
                abort.current = null
                setScope(null)
                options.setBusy(null)
            })
    }
    // 停止：中止在途探测但不关窗——已探到哪一步值得留在记录里，故按下即在记录区留一行
    const stop = () => {
        if (abort.current === null) return
        abort.current.abort()
        setLines((current) => [...current, t('probeStoppedLine')])
    }
    // 关闭即丢弃本轮记录与计划，开关一并复位（「自动写入」每次开窗重置为开，见 onOpen）
    const close = () => {
        abort.current?.abort()
        setOpen(false)
        setPlan(null)
        setScope(null)
        setLines([])
        setTotal(0)
        setDone(0)
        setStopped(false)
        setIgnoreExcludes(false)
        setDropUnsupported(false)
    }
    return {
        open, ignoreExcludes, dropUnsupported, setDropUnsupported, autoWrite, setAutoWrite, scope, lines, total, done,
        running: options.busy === 'probe', terminalLabels,
        unfilledCount: plan?.unfilled.length ?? 0,
        allCount: plan?.all.length ?? 0,
        onOpen, run, stop, close, toggleIgnoreExcludes,
    }
}
