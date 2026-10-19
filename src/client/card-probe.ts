/** 「探测档位」编排 hook：勾选集、开关、记录区与发跑 / 停止 / 关窗；只编排不渲染，busy 由卡片传入。 */

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
    /** 卡片全局占用态 */
    busy: CardBusy
    setBusy: (busy: CardBusy) => void
    /** llm-pi-ai user 层（候选源） */
    user: unknown
    /** 发起一轮探测（Node 半经进度流回帧）；返回 undefined = 被中止 */
    probeEfforts: (
        models: readonly VerifyTarget[],
        options: { dropUnsupported: boolean; autoWrite: boolean },
        onFrame: (frame: VerifyProgressUpdate) => void,
        signal: AbortSignal,
    ) => Promise<VerifySummary | undefined>
    /** 结果 / 失败提示落卡片状态行 */
    onNotice: (notice: Notice) => void
}

export function useProbeRun(options: ProbeRunOptions) {
    const { t } = options
    const [open, setOpen] = useState(false)
    const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
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
    // 候选清单（与验证同源），发跑时冻结
    const candidates = useMemo(
        () => verifyCandidatesOf(options.user),
        [options.user],
    )

    /** 发跑一轮探测：勾选集在发跑时冻结为探测对象 */
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
    const stop = () => {
        if (abort.current === null) return
        abort.current.abort()
        setLines((current) => [...current, t('probeStoppedLine')])
    }
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
    const toggleGroup = (models: readonly VerifyCandidate[]) => {
        setPicked((current) => toggleGroupPicks(current, models))
    }
    const toggleAll = () => {
        setPicked((current) => toggleGroupPicks(current, candidates))
    }
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
