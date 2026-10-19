/**
 * 「探测档位」的整轮编排 hook（浏览器半）：勾选集、两个开关、记录区、发跑 / 停止 / 关窗。
 * 只编排不渲染（弹层外壳见 `diagnose-dialog.tsx`）；busy 由卡片传入。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { errorText } from '@/shared/errors'
import type { VerifyProgressUpdate, VerifySummary } from '@/shared/verify-progress'
import { groupAllPicked, isUnfilled, probeTargetsOf, toggleGroupPicks, verifyCandidatesOf, verifyKey } from '@/client/model'
import type { VerifyCandidate, VerifyTarget } from '@/client/model'
import { truncateMessage } from '@/client/card-notice'
import type { CardBusy, Notice } from '@/client/card-notice'
import { terminalLabelsOf, verifyLineOf } from '@/client/card-records'

export interface ProbeRunOptions {
    t: TranslateNS<'settings.modelFix'>
    /** 卡片的全局占用态 */
    busy: CardBusy
    setBusy: (busy: CardBusy) => void
    /** llm-pi-ai user 层（候选清单的事实源） */
    user: unknown
    /** 发起一轮探测（Node 半经进度流回帧）；返回 undefined = 被中止 */
    probeEfforts: (
        models: readonly VerifyTarget[],
        options: { dropUnsupported: boolean; autoWrite: boolean },
        onFrame: (frame: VerifyProgressUpdate) => void,
        signal: AbortSignal,
    ) => Promise<VerifySummary | undefined>
    /** 补全结果 / 失败提示落卡片状态行 */
    onNotice: (notice: Notice) => void
}

export function useProbeRun(options: ProbeRunOptions) {
    const { t } = options
    // 勾选集（键见 verifyKey）
    const [open, setOpen] = useState(false)
    const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
    // 「自动写入」默认开；每次开窗重置为开
    const [autoWrite, setAutoWrite] = useState(true)
    const [dropUnsupported, setDropUnsupported] = useState(false)
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
    // 候选清单（与验证同源）；发跑那一刻才收敛成请求计划并冻结
    const candidates = useMemo(
        () => verifyCandidatesOf(options.user),
        [options.user],
    )

    /** 跑一轮探测：发跑时的勾选即探测对象（冻结）。自动写入开时结果落卡片状态行，关时仅记录区报「可补全」 */
    const run = () => {
        if (options.busy !== null) return
        const models = probeTargetsOf(candidates.filter((candidate) => picked.has(verifyKey(candidate.provider, candidate.model))))
        if (models.length === 0) return
        setLines([])
        setTotal(0)
        setDone(0)
        setStopped(false)
        options.setBusy('probe')
        const controller = new AbortController()
        abort.current = controller
        // 记下发跑时的「自动写入」取值
        const autoWriteValue = autoWrite
        options.probeEfforts(models, { dropUnsupported, autoWrite: autoWriteValue }, (frame) => {
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
                if (autoWriteValue) {
                    const filled = t('probeFilled', {
                        models: String(fill?.models ?? 0),
                        added: String(fill?.added ?? 0),
                        removed: String(fill?.removed ?? 0),
                    })
                    options.onNotice({ text: filled, tone: 'success' })
                    setLines((current) => [...current, filled])
                } else {
                    // 未写入：报「可补全多少」
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
                options.setBusy(null)
            })
    }
    // 停止：中止在途探测，记录区留一行
    const stop = () => {
        if (abort.current === null) return
        abort.current.abort()
        setLines((current) => [...current, t('probeStoppedLine')])
    }
    // 关闭：复位勾选、记录与开关
    const close = () => {
        abort.current?.abort()
        setOpen(false)
        setPicked(new Set())
        setLines([])
        setTotal(0)
        setDone(0)
        setStopped(false)
        setDropUnsupported(false)
    }
    const onOpen = () => {
        if (options.busy !== null) return
        // 「自动写入」每次开窗重置为开
        setAutoWrite(true)
        setOpen(true)
    }
    const togglePick = (key: string) => {
        setPicked((current) => {
            const next = new Set(current)
            if (!next.delete(key)) next.add(key)
            return next
        })
    }
    // 分组全选
    const toggleGroup = (models: readonly VerifyCandidate[]) => {
        setPicked((current) => toggleGroupPicks(current, models))
    }
    /** 全列表「全选 / 取消全选」 */
    const toggleAll = () => {
        setPicked((current) => toggleGroupPicks(current, candidates))
    }
    // 「选择未填充」：只把未填充子清单传进去
    const unfilled = useMemo(
        () => candidates.filter((candidate) => isUnfilled(candidate.efforts)),
        [candidates],
    )
    const toggleUnfilled = () => {
        setPicked((current) => toggleGroupPicks(current, unfilled))
    }
    return {
        open, picked, candidates, autoWrite, setAutoWrite, dropUnsupported, setDropUnsupported,
        lines, total, done, running: options.busy === 'probe', terminalLabels,
        unfilledCount: unfilled.length,
        allUnfilledPicked: unfilled.length > 0 && groupAllPicked(picked, unfilled),
        onOpen, run, stop, close, togglePick, toggleGroup, toggleAll, toggleUnfilled,
    }
}
