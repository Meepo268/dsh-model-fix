/**
 * 验证与探测档位两条记录区的纯文案层（浏览器半）：TerminalBlock 展示文案、探测结论→文案键
 * 对照表、单条结论记录行合成。零状态、零 React，只吃翻译函数与进度帧。
 */

import type { TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CardKey } from '@/client/locale-keys'
import { isProviderBlocking } from '@/shared/verify-progress'
import type { ProbeOutcome, VerifyProbedFrame } from '@/shared/verify-progress'

/** 宿主 TerminalBlock 的展示文案（该包无语言回退，文案经 t() 提供）。
 *  0.2.1-alpha.2 起新增必填字段 `commandLine`，而 devDep 停在 0.1.7-rc.2、编译面看不到它，
 *  故并入期望类型以避开 excess-property 检查。详见 docs/host-api.md */
export type TerminalLabels = TerminalBlockLabels & { commandLine: (line: number) => string }

export function terminalLabelsOf(t: TranslateNS<'settings.modelFix'>): TerminalLabels {
    return {
        commandLine: (n) => t('terminalCommandLine', { n: String(n) }),
        signal: (signal) => t('terminalSignal', { signal }),
        exitCode: (code) => t('terminalExitCode', { code: String(code) }),
        noExitCode: t('terminalNoExitCode'),
        running: t('terminalRunning'),
        failed: t('terminalFailed'),
        done: t('terminalDone'),
        copy: t('terminalCopy'),
        copied: t('terminalCopied'),
        noOutput: t('terminalNoOutput'),
        // 宿主类型必填的 4 个字段：空值
        collapseAria: '',
        collapse: '',
        expandAria: () => '',
        expand: () => '',
    }
}

/** 每种探测结论对应的展示词；判别值与 `ProbeOutcome` 一一对应，漏一个即类型报错。
 * `aborted` 只占类型位：中止一律不入账，不会出现在记录区 */
const OUTCOME_KEYS: Record<ProbeOutcome, CardKey> = {
    usable: 'verifyOutUsable',
    'unsupported-effort': 'verifyOutUnsupported',
    unreachable: 'verifyOutUnreachable',
    quota: 'verifyOutQuota',
    credential: 'verifyOutCredential',
    'rate-limit': 'verifyOutRateLimit',
    timeout: 'verifyOutTimeout',
    aborted: 'verifyOutAborted',
    other: 'verifyOutOther',
}

/**
 * 一条探测结论的记录行：provider 级失败（不可达 / 凭据无效）不带模型与档位——整组不成立而非单个
 * 模型的问题；带 `skipped` 时补一句「还剩几条没验」。
 */
export function verifyLineOf(frame: VerifyProbedFrame, t: TranslateNS<'settings.modelFix'>): string {
    const result = t(OUTCOME_KEYS[frame.outcome])
    const line = isProviderBlocking(frame.outcome)
        ? t('verifyLineProvider', { provider: frame.provider, result })
        : frame.effort === undefined
            ? t('verifyLinePlain', { provider: frame.provider, model: frame.model, result })
            : t('verifyLine', { provider: frame.provider, model: frame.model, effort: frame.effort, result })
    return frame.skipped === undefined ? line : `${line}${t('verifySkipped', { count: String(frame.skipped) })}`
}
