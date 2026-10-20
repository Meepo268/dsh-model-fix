/** 「验证模型」的整轮编排 hook（浏览器半）：勾选集、记录区、发跑 / 停止 / 关窗。只编排不渲染；busy 由卡片传入 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { errorText } from '@/shared/errors'
import type { VerifyProgressUpdate, VerifySummary } from '@/shared/verify-progress'
import { toggleGroupPicks, verifyTargets } from '@/client/model'
import type { VerifyCandidate } from '@/client/model'
import { truncateMessage } from '@/client/card-notice'
import type { CardBusy } from '@/client/card-notice'
import { terminalLabelsOf, verifyLineOf } from '@/client/card-records'

/** hook 入参：busy 属于卡片层，验证自身零持有 */
export interface VerifyRunOptions {
    t: TranslateNS<'settings.modelFix'>
    /** 卡片的全局占用态：发起前置位、收尾清空，与其余写操作互斥 */
    busy: CardBusy
    setBusy: (busy: CardBusy) => void
    /** 验证候选（与提供方 id 同源的那份），发跑时收敛成请求计划 */
    candidates: readonly VerifyCandidate[]
    /** 发起一轮验证（Node 半经进度流回帧）；返回 undefined = 被中止 */
    verifyModels: (targets: ReturnType<typeof verifyTargets>, onFrame: (frame: VerifyProgressUpdate) => void, signal: AbortSignal) => Promise<VerifySummary | undefined>
}

export function useVerifyRun(options: VerifyRunOptions) {
    const { t, candidates, verifyModels } = options
    // 「验证模型」弹层：勾选集（键见 verifyKey）；默认不预选——每次验证都花真实额度
    const [open, setOpen] = useState(false)
    const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
    // 验证记录区：逐行追加探测结论，发起时清空；总项数取自 opened 帧、已完成条数逐条 probed 帧更新
    const [lines, setLines] = useState<readonly string[]>([])
    const [total, setTotal] = useState(0)
    const [done, setDone] = useState(0)
    // 本轮是否以中止收场：记录区的 settle 措辞按它分「完成 / 已停止」
    const [stopped, setStopped] = useState(false)
    // 在途的 AbortController：点停止、关窗与组件卸载都靠它中止——中止经 signal 传导到 Node 半的执行循环
    const abort = useRef<AbortController | null>(null)
    useEffect(() => () => { abort.current?.abort() }, [])
    // 中止不落宿主那个 error 态的「失败」：用户主动停止不是失败，故改 done 态 + 中性措辞「已停止」
    const terminalLabels = useMemo<TerminalBlockLabels>(
        () => ({ ...terminalLabelsOf(t), done: stopped ? t('verifyStopped') : t('terminalDone') }),
        [t, stopped],
    )

    // 弹层自身已含 warn 提示与确认键，构成自确认，不叠二次确认弹层
    const onOpen = () => {
        if (options.busy !== null) return
        setOpen(true)
    }
    const run = () => {
        if (options.busy !== null) return
        // 每次发起都清空记录，免得上一轮的残留行混进这一轮
        setLines([])
        setTotal(0)
        setDone(0)
        setStopped(false)
        options.setBusy('verify')
        const controller = new AbortController()
        abort.current = controller
        verifyModels(verifyTargets(candidates, picked), (frame) => {
            if (frame.type === 'opened') {
                setTotal(frame.total)
                return
            }
            setDone(frame.done)
            setLines((current) => [...current, verifyLineOf(frame, t)])
        }, controller.signal)
            .then((summary) => {
                // undefined = 被中止（点停止 / 关窗 / 断连），不是失败：保留进度与弹层
                if (summary === undefined) {
                    setStopped(true)
                    return
                }
                // 请求本就不带档位参数，没有级别可报，故只报「勾选 N 个 / 可用 M 个」
                const stats = t('verifyDoneModels', {
                    models: summary.models,
                    tested: summary.tested,
                })
                // 结论只留在弹层内，不写卡片状态行（弹层跑完不关，结论追加成记录区末行）
                setLines((current) => [...current, t('verifyFinished', { result: stats })])
            })
            .catch((error: unknown) => {
                const stats = t('verifyFailed', { message: truncateMessage(errorText(error)) })
                setLines((current) => [...current, t('verifyFinished', { result: stats })])
            })
            .finally(() => {
                abort.current = null
                options.setBusy(null)
            })
    }
    // 停止：中止在途验证但不关窗，按下即在记录区留一行
    const stop = () => {
        if (abort.current === null) return
        abort.current.abort()
        setLines((current) => [...current, t('verifyStoppedLine')])
    }
    // 关闭即丢弃本次勾选与记录；在途时关窗同时中止（跑完后控制器已置空，是空操作）
    const close = () => {
        abort.current?.abort()
        setOpen(false)
        setPicked(new Set())
        setLines([])
        setTotal(0)
        setDone(0)
    }
    const togglePick = (key: string) => {
        setPicked((current) => {
            const next = new Set(current)
            if (!next.delete(key)) next.add(key)
            return next
        })
    }
    // 分组全选：点击方向与按钮文案同走 groupAllPicked（判据只此一处）
    const toggleGroup = (models: readonly VerifyCandidate[]) => {
        setPicked((current) => toggleGroupPicks(current, models))
    }
    // 全列表「全选 / 取消全选」
    const toggleAll = () => {
        setPicked((current) => toggleGroupPicks(current, candidates))
    }
    return {
        open, picked, lines, total, done, running: options.busy === 'verify',
        terminalLabels, onOpen, run, stop, close, togglePick, toggleGroup, toggleAll,
    }
}
