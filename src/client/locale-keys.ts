/**
 * 卡片文案的键契约（浏览器半）：命名空间、键名联合、宿主 ui-slots 的类型表并入，
 * 以及「配置项 → 文案键」的四张映射。
 *
 * 这里只管「有哪些键、配置项对上哪个键」，键各自说了什么见 locale-zh.ts 与 locale-en.ts。
 * 四张映射按用途分：同一轴上「标题」与「释义」本是两句话，故行名与行内释义、组标题与组释义各成一张。
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { Group, RowKey } from '@/client/model'

/** 卡片词典命名空间 */
export const CARD_NS = 'settings.modelFix'

/** 卡片文案键集合 */
export type CardKey =
    | 'title'
    | 'tabLabel'
    | 'description'
    | 'colAutoFill'
    | 'colAllowUpdate'
    | 'colCompat'
    | 'colExcludes'
    | 'colUserExperience'
    | 'masterAll'
    | 'hintAutoFill'
    | 'hintAllowUpdate'
    | 'hintCompat'
    | 'hintExcludes'
    | 'hintUserExperience'
    | 'rowReasoning'
    | 'rowContext'
    | 'rowImage'
    | 'rowDisableDeveloper'
    | 'rowDisableStore'
    | 'rowRememberEfforts'
    | 'rowDefaultHigh'
    | 'rowForgetRemoved'
    | 'rowFollowParent'
    | 'rowSelfTuneEffort'
    | 'rowHideOfficial'
    | 'rowLocalizeEfforts'
    | 'rowShowOriginalEfforts'
    | 'tipReasoning'
    | 'tipContext'
    | 'tipImage'
    | 'tipDisableDeveloper'
    | 'tipDisableStore'
    | 'tipRememberEfforts'
    | 'tipDefaultHigh'
    | 'tipForgetRemoved'
    | 'tipFollowParent'
    | 'tipSelfTuneEffort'
    | 'tipHideOfficial'
    | 'tipLocalizeEfforts'
    | 'tipShowOriginalEfforts'
    | 'excludePlaceholder'
    | 'excludeAdd'
    | 'excludeInvalid'
    | 'excludeDuplicate'
    | 'excludeHits'
    | 'excludeHit'
    | 'excludeUnmatched'
    | 'excludeRemove'
    | 'save'
    | 'saving'
    | 'saveDone'
    | 'cancel'
    | 'unsaved'
    | 'expand'
    | 'collapse'
    | 'force'
    | 'forceBusy'
    | 'forceConfirm'
    | 'forceGo'
    | 'close'
    | 'forceDone'
    | 'forceNone'
    | 'forceFailed'
    | 'reset'
    | 'resetBusy'
    | 'resetConfirm'
    | 'resetGo'
    | 'resetDone'
    | 'resetFailed'
    | 'restore'
    | 'restoreBusy'
    | 'restoreConfirm'
    | 'restoreGo'
    | 'restoreDone'
    | 'restoreFailed'
    | 'verify'
    | 'verifyTitle'
    | 'verifyDesc'
    | 'verifyTabModels'
    | 'verifyTabRecords'
    | 'verifyQuota'
    | 'verifyEfforts'
    | 'verifyEffortsTip'
    | 'verifyGo'
    | 'verifyStop'
    | 'verifySelectAll'
    | 'verifyDeselectAll'
    | 'verifyEmpty'
    | 'verifyRecordEmpty'
    | 'verifyCommand'
    | 'verifyLine'
    | 'verifyLinePlain'
    | 'verifyLineProvider'
    | 'verifySkipped'
    | 'verifyOutUsable'
    | 'verifyOutUnsupported'
    | 'verifyOutUnreachable'
    | 'verifyOutQuota'
    | 'verifyOutCredential'
    | 'verifyOutRateLimit'
    | 'verifyOutTimeout'
    | 'verifyOutOther'
    | 'verifyStopped'
    | 'verifyStoppedLine'
    | 'verifyDoneModels'
    | 'verifyDoneLevels'
    | 'verifyFailed'
    | 'verifyFinished'
    | 'pruneTitle'
    | 'pruneConfirm'
    | 'pruneGo'
    | 'pruneDone'
    | 'pruneFailed'
    // 探测式填充：两个发起键共用一套行模板与结论词（复用 verifyOut* / verifySkipped / verifyStopped），
    // 只有开关、范围键与收尾几行是它自己的说法
    | 'probe'
    | 'probeTitle'
    | 'probeDesc'
    | 'probeQuota'
    | 'probeOffNote'
    | 'probePlan'
    | 'probeEmpty'
    | 'probeAutoWrite'
    | 'probeAutoWriteTip'
    | 'probeIgnoreExcludes'
    | 'probeIgnoreExcludesTip'
    | 'probeDropUnsupported'
    | 'probeDropUnsupportedTip'
    | 'probeUnfilled'
    | 'probeAll'
    | 'probeStop'
    | 'probeCommand'
    | 'probeDone'
    | 'probeFilled'
    | 'probeFillSkipped'
    | 'probeFillFailed'
    | 'probeStoppedLine'
    // 宿主 TerminalBlock 的展示文案：键名与 terminalLabels(t) 逐条对齐官方安装页的映射（`DSH/packages/client/ui-plugin-manager/…/locales.ts`）
    | 'terminalCommandLine'
    | 'terminalSignal'
    | 'terminalExitCode'
    | 'terminalNoExitCode'
    | 'terminalRunning'
    | 'terminalFailed'
    | 'terminalDone'
    | 'terminalCopy'
    | 'terminalCopied'
    | 'terminalNoOutput'
    | 'terminalCollapseAria'
    | 'terminalCollapse'
    | 'terminalExpandAria'
    | 'terminalExpand'
    | 'clearEffortsTitle'
    | 'clearEffortsConfirm'
    | 'clearEffortsKeep'
    | 'clearEffortsGo'
    | 'clearEffortsDone'
    | 'clearEffortsFailed'
    | 'loading'
    | 'unavailable'
    | 'readOnly'
    | 'star'
    | 'feedback'
    | 'issueBody'
    // 输入框工具行的两枚 chip：常驻入口 + 跟随状态灯（亮绿＝实际生效中、灰＝未生效）
    | 'chipModelOpt'
    | 'chipModelOptTitle'
    | 'chipFollowOn'
    | 'chipFollowOnTitle'
    | 'chipFollowOff'
    | 'chipFollowOffTitle'
    | 'chipFollowFail'
    // 「UI 与行为」组：四个可见性开关 + 一条恒定展示行（插件管理，不绑配置、不可关闭）
    | 'colBehavior'
    | 'hintBehavior'
    | 'rowShowInModels'
    | 'rowShowInBuiltinPlugins'
    | 'rowShowInComposer'
    | 'rowShowFollowStatus'
    | 'rowShowInPluginManager'
    | 'tipShowInModels'
    | 'tipShowInBuiltinPlugins'
    | 'tipShowInComposer'
    | 'tipShowFollowStatus'
    | 'tipShowInPluginManager'

declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        'settings.modelFix': CardKey
    }
}

/** 组内行键的展示文案映射（组件按 GROUP_KEYS 取键） */
export const ROW_KEYS: Record<RowKey, CardKey> = {
    reasoning: 'rowReasoning',
    context: 'rowContext',
    image: 'rowImage',
    disableDeveloper: 'rowDisableDeveloper',
    disableStore: 'rowDisableStore',
    rememberEfforts: 'rowRememberEfforts',
    defaultHigh: 'rowDefaultHigh',
    forgetRemoved: 'rowForgetRemoved',
    followParent: 'rowFollowParent',
    showInModels: 'rowShowInModels',
    showInBuiltinPlugins: 'rowShowInBuiltinPlugins',
    showInComposer: 'rowShowInComposer',
    showFollowStatus: 'rowShowFollowStatus',
    selfTune: 'rowSelfTuneEffort',
    hideOfficial: 'rowHideOfficial',
    localizeEfforts: 'rowLocalizeEfforts',
    showOriginalEfforts: 'rowShowOriginalEfforts',
}

/** 配置组（瓦片）标题键映射 */
export const COLUMN_KEYS: Record<Group, CardKey> = {
    autoFill: 'colAutoFill',
    allowUpdate: 'colAllowUpdate',
    compat: 'colCompat',
    behavior: 'colBehavior',
    userExperience: 'colUserExperience',
}

/** 配置组释义键映射（瓦片展开体首行） */
export const HINT_KEYS: Record<Group, CardKey> = {
    autoFill: 'hintAutoFill',
    allowUpdate: 'hintAllowUpdate',
    compat: 'hintCompat',
    behavior: 'hintBehavior',
    userExperience: 'hintUserExperience',
}

/** 行内设置项的 tooltip 释义键映射（瓦片展开体每行的帮助气泡） */
export const TIP_KEYS: Record<RowKey, CardKey> = {
    reasoning: 'tipReasoning',
    context: 'tipContext',
    image: 'tipImage',
    disableDeveloper: 'tipDisableDeveloper',
    disableStore: 'tipDisableStore',
    rememberEfforts: 'tipRememberEfforts',
    defaultHigh: 'tipDefaultHigh',
    forgetRemoved: 'tipForgetRemoved',
    followParent: 'tipFollowParent',
    showInModels: 'tipShowInModels',
    showInBuiltinPlugins: 'tipShowInBuiltinPlugins',
    showInComposer: 'tipShowInComposer',
    showFollowStatus: 'tipShowFollowStatus',
    selfTune: 'tipSelfTuneEffort',
    hideOfficial: 'tipHideOfficial',
    localizeEfforts: 'tipLocalizeEfforts',
    showOriginalEfforts: 'tipShowOriginalEfforts',
}
