/** 跨半共享的纯常量（零 Node 依赖、零 schemastery、零非基线 `@deepseek-ai/*`）；Node 专属常量仍留 `src/constants.ts`。
 * 加 `node:`、`schemastery` 或非基线 `@deepseek-ai/*` 值导入会破坏浏览器半产物——勿加（门禁见 `eslint.config.ts`） */

/** 模型配置读写目标命名空间（harness 的 llm-pi-ai） */
export const API_NS = 'llm-pi-ai'
/** 自有配置命名空间（带发布者前缀，避免与其他插件抢占通用名字；fix 即填充/修复），由插件导出的 Config schema 注册（src/index.ts） */
export const PLUGIN_NS = 'tikaflow-model-fix'

/** 插件名（= npm 包名）：Node 半日志前缀与 User-Agent、浏览器半 `export const name` 与样式标签 HMR 标记共用 */
export const PLUGIN_NAME = 'dsh-model-fix'

/** 验证进度流的路由：Node 半经 `connection.fetch` 注册的 exact 路径（宿主要求落在 `/api` 之下）；浏览器半用 `VERIFY_STREAM_URL` 那一份——宿主约定浏览器一律走文档相对路由 */
export const VERIFY_STREAM_ROUTE = `/api/${PLUGIN_NS}/verify`
/** 同一路由的文档相对形式（去掉前导斜杠），供浏览器半 `fetch` 直接使用 */
export const VERIFY_STREAM_URL = VERIFY_STREAM_ROUTE.slice(1)

/** 「探测档位」进度流的路由：与验证流同型（同一 exact 注册面、同样的 `buffered` 请求体与 SSE 回包），只是执行器与用途不同 */
export const PROBE_STREAM_ROUTE = `/api/${PLUGIN_NS}/probe`
/** 同一路由的文档相对形式（去掉前导斜杠），供浏览器半 `fetch` 直接使用 */
export const PROBE_STREAM_URL = PROBE_STREAM_ROUTE.slice(1)

/** 推理级别取值，与 harness 的 ModelThinkingLevel 一致（由低到高：浏览器半取「最低档位」即取首个命中项） */
export const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 推理级别中文名：键取宿主算显示名的同一形式（id 首字母大写），与本仓对宿主 UI 呈现的英文逐字对得上。Node 半换名见 `src/effort-name.ts` */
export const EFFORT_NAMES_ZH: Readonly<Record<string, string>> = {
    Off: '关',
    Minimal: '极低',
    Low: '低',
    Medium: '中',
    High: '高',
    Xhigh: '极高',
    Max: '最大',
    Default: '默认',
}

/** 「中文名 · 原档位名」的分隔符（与宿主分隔符口径一致）。浏览器半 Default 伪菜单项与 Node 半档位换名两处拼装同一形态，放共享层防走样 */
export const EFFORT_NAME_SEP = ' · '

/** RPC 端点名：跨 Node 半（注册分发）与浏览器半（发起调用）共享，统一放 shared 层避免两端写裸字符串（一端改漏另一端 runtime 报 unknown-endpoint） */

/** 卡片「强制更新」按钮调用的 endpoint 名 */
export const ENDPOINT_FORCE_UPDATE = 'forceUpdate'
/** 卡片「重置推理级别」按钮调用的 endpoint 名 */
export const ENDPOINT_RESET_MODELS = 'resetModels'
/** 卡片「恢复备份」按钮调用的 endpoint 名 */
export const ENDPOINT_RESTORE_MODELS = 'restoreModels'
/** 浏览器半启动时上报探测语言的 endpoint 名（Node 侧没有 locale 服务） */
export const ENDPOINT_REPORT_LOCALE = 'reportLocale'
/** 「参数来源」弹层读取整份快照的 endpoint 名（只读） */
export const ENDPOINT_SOURCES = 'sources'
/** 写一个模型的参数来源 pin 的 endpoint 名（空串 = 回到自动） */
export const ENDPOINT_SET_SOURCE = 'setSource'

/** 宿主自此版本起自带「未配置密钥的官方提供方自动隐藏」；≥ 此值时本插件的「隐藏官方API」空转 */
export const HOST_AUTO_HIDE_SINCE = '0.2.1-alpha.2'

/** settings 写回冲突与语言上报共用的重试次数（跨半共享）。值变更须同步两端 */
export const MAX_ATTEMPTS = 3

/** 三个写回端点的等待上限（毫秒，跨半共享）：宿主 `rpc.call` 自身无计时器，不给就有永久占着卡片占用态的挂死路径（取舍见 docs/decisions-config.md「写回端点」） */
export const WRITEBACK_MS = 10_000
