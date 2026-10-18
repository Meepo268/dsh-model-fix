/**
 * 「验证模型」的整轮编排 hook（浏览器半）：勾选集、档位开关、记录区、发跑 / 停止 / 关窗。
 * 只编排，不渲染——弹层本体见 `verify-dialog.tsx`；busy 由卡片传入并与其余写操作共用同一互斥，
 * 「档位不支持」明细经 `onUnsupported` 交还卡片弹剔除确认（确认弹层属于卡片层）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { errorText } from '@/shared/errors'
import type { UnsupportedEffort, VerifyProgressUpdate, VerifySummary } from '@/shared/verify-progress'
import { toggleGroupPicks, verifyTargets } from '@/client/model'
import type { VerifyCandidate } from '@/client/model'
import { truncateMessage } from '@/client/card-notice'
import type { CardBusy } from '@/client/card-notice'
import { terminalLabelsOf, verifyLineOf } from '@/client/card-records'

/** hook 入参：busy 与两个回调属于卡片层，验证自身零持有 */
export interface VerifyRunOptions {
    t: TranslateNS<'settings.modelFix'>
    /** 卡片的全局占用态：发起前置位、收尾清空，与其余写操作互斥 */
    busy: CardBusy
    setBusy: (busy: CardBusy) => void
    /** 验证候选（与提供方 id 同源的那份），发跑时收敛成请求计划 */
    candidates: readonly VerifyCandidate[]
    /** 发起一轮验证（Node 半经进度流回帧）；返回 undefined = 被中止 */
    verifyModels: (targets: ReturnType<typeof verifyTargets>, onFrame: (frame: VerifyProgressUpdate) => void, signal: AbortSignal) => Promise<VerifySummary | undefined>
    /** 验证明细里明确判「档位不支持」的条目：交还卡片弹剔除确认 */
    onUnsupported: (targets: readonly UnsupportedEffort[]) => void
}

export function useVerifyRun(options: VerifyRunOptions) {
    const { t, candidates, verifyModels } = options
    // 「验证模型」弹层：勾选集（键见 verifyKey）、是否逐个档位验证；默认不预选——每次验证都花真实额度
    const [open, setOpen] = useState(false)
    const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
    const [efforts, setEfforts] = useState(false)
    // 验证记录区：逐行追加探测结论，发起时清空；总项数取自 opened 帧
    const [lines, setLines] = useState<readonly string[]>([])
    const [total, setTotal] = useState(0)
    // 本轮是否以中止收场：记录区的 settle 措辞按它分「完成 / 已停止」
    const [stopped, setStopped] = useState(false)
    // 在途的 AbortController：点停止、关窗与组件卸载都靠它中止——中止经 signal 传导到 Node 半的执行循环
    const abort = useRef<AbortController | null>(null)
    useEffect(() => () => { abort.current?.abort() }, [])
    // 中止不落宿主那个 error 态的「失败」——用户主动停止不是失败，故改 done 态 + 中性措辞「已停止」
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
        // 记下本次的档位开关取值：结果回来时不能现读，否则用户在途中拨了开关，文案就会张冠李戴
        const allEfforts = efforts
        // 每次发起都清空记录，免得上一轮的残留行混进这一轮
        setLines([])
        setTotal(0)
        setStopped(false)
        options.setBusy('verify')
        const controller = new AbortController()
        abort.current = controller
        verifyModels(verifyTargets(candidates, picked, allEfforts), (frame) => {
            if (frame.type === 'opened') {
                setTotal(frame.total)
                return
            }
            setLines((current) => [...current, verifyLineOf(frame, t)])
        }, controller.signal)
            .then((summary) => {
                // undefined = 被中止（点停止 / 关窗 / 断连），不是失败：保留进度与弹层
                if (summary === undefined) {
                    setStopped(true)
                    return
                }
                // 关档位报模型数；开档位级别分母取 plannedEfforts，一个级别都没计划时退回模型口径
                const stats = t(allEfforts && summary.plannedEfforts > 0 ? 'verifyDoneLevels' : 'verifyDoneModels', {
                    models: summary.models,
                    tested: summary.tested,
                    efforts: summary.efforts,
                    levels: summary.plannedEfforts,
                })
                // 结论只留在弹层内，不写卡片状态行：弹层跑完不关、结论追加成记录区末行，用户当场就看得见。
                // 明细由 Node 半直接给出（只收明确判为不支持的），前端不自己从 results 里筛
                options.onUnsupported(summary.unsupportedEfforts)
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
    // 停止：中止在途验证但不关窗——已验到哪一步值得留在记录里，故按下即在记录区留一行
    const stop = () => {
        if (abort.current === null) return
        abort.current.abort()
        setLines((current) => [...current, t('verifyStoppedLine')])
    }
    // 关闭即丢弃本次勾选与记录，并把档位开关一并复位；在途时关窗同时中止（跑完后控制器已置空，是空操作）
    const close = () => {
        abort.current?.abort()
        setOpen(false)
        setPicked(new Set())
        setLines([])
        setTotal(0)
        setEfforts(false)
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
    return {
        open, picked, efforts, setEfforts, lines, total, running: options.busy === 'verify',
        terminalLabels, onOpen, run, stop, close, togglePick, toggleGroup,
    }
}
