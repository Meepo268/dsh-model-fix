# 宿主契约：子智能体与档位自调注入面

契约基线 devDep `0.1.7-rc.2`（差异见 `drift.md`）。

## `agent/request`：子智能体路由改写

- 瀑布（`DSH/packages/core/agent/src/runtime-types.ts`）：`'agent/request'(this: Scoped<Agent>, payload: { agent; turn; step; signal }, next)`；派发器把 `payload.agent` 覆盖为运行期 Agent。
- 种子配置被 `deepFreeze(structuredClone(...))`（`DSH/packages/core/agent-loop/src/agent.ts` 的 `prepareRequest`）⇒ **中间件只能返回新对象**；`next()` 返回的是本次请求实际生效的 `LlmCallConfig`。
- 本仓 `{ prepend: true }` 钉最外层：`handler` 内 `await next()` 拿种子配置（未被更内层钩子改写）再决定覆盖。
- 全局覆盖靠 scope 过滤器（`scopeOf(ctx) === undefined` 全局收事件）⇒ 插件根 ctx 单个监听覆盖全部 Agent。`ctx.on` 的 `prepend` 选项：钩子表全局一张按注册先后排（outermost-first）⇒ HMR 重载后仍钉最外层。
- `agents` 服务（`DSH/packages/core/agent/src/index.ts`）：`get(id)` 返回**富面 Agent**（含 `options / session / ctx`）——`@deepseek-ai/dsh-agent/types` 子路径只导出精简 `{ id }`，必须包根导入。**本仓不引该包**（包根类型顶掉浏览器半 `ctx.sessions`，见 `imports.md`），在 `src/subagent.ts` 复制只读的 `session.header` / `requestHeader()` / `options`，经子 fiber 注入。
- 会话头与请求头（`DSH/packages/core/session/src/{types,index}.ts`）：`SessionHeader{ parentSession?; origin?: 'subagent' }`；`requestHeader(): EpochHeader{ config; adapterDefaults?; tools?; system? } | undefined`——**只反映父已发过的请求**（请求真正被准备时才写）。`adapterDefaults?.reasoningEffort === true` 表示档位是适配器默认值、本仓视为「未选」。
- 父会话待生效选择：服务名 `sessionProjections`，`stateOf(session, 'modelSelection')` 未注册键返回 undefined。`pending` 即「父下一次请求该用的路由」：UI 每次选择落 `model/selection` 事件置位，匹配请求头落库后清空。本仓不引该包类型，只在 `src/subagent.ts` 本地声明返回面。
- 「允许 Agent 为子智能体选择模型」（服务名 `subagentModelSelection`）：`current()` 在 `enabled && allowedModels.length === 0` 时抛错 ⇒ 本仓 try/catch 当关闭。三服务（`agents` / `sessionProjections` / `subagentModelSelection`）全就绪才注册监听。
- 死路备忘：改宿主 `subagentModelSelection` schema（strict 对象）；拦截 `llm/stream` 瀑布（绕过授权校验且与 session log 请求头失步）；`Config.agentOptions`（第三方拿不到别的 fiber 的 config 引用）；给 fork 子智能体开路由选择（宿主刻意不给：路由变更丢失继承前缀的 KV-Cache 复用）。

## 档位自调：四个服务

四服务（连同投影）由 `installSelfTune` 经 `ctx.inject` 子 fiber 统一声明（全就绪才执行，缺席 PENDING 静默）。下列只记服务契约，实现契约全部复制在 `src/self-tune.ts`。

- **`tools`**（`DSH/packages/core/tools/src/index.ts`）：`register(definition)` 返回同步 disposer，同名重复注册抛错。`definition`：`name / description（必填）/ parameters / output{ schema; render } / execute(args, exec)`——**register 不做参数校验**，信任边界在工具自己；`exec` 给 `signal` 与 `agent?`。`execute` 抛错的宿主处置未确认，故本仓按「可能不捕获」防御：读宿主投影/请求头失败归 `undefined`、工具回 `no-route`，不让异常冒泡出 `execute`。
- **`systemPrompt`**（`DSH/packages/core/system-prompt/src/index.ts`）：`section({ name, order, text })`，重名抛错；宿主 order 序列 `MCP_SERVERS=3100`、`TOOLS_SDK=5000`，本插件用 `order: 3200` 落位其间。
- **`sessionController.selectModel`**（`@deepseek-ai/dsh-api-session-controller` 的 `src/types/commands.ts`）：会话级模型选择生效——与 UI 选择器同一链路（落 `model/selection` 成投影 `pending`），返回值带 `{ selected }`；失败**抛 `RemoteError`**（子智能体持有会话 `session/agent-busy`、模型不支持所选档位 `session/model-unavailable`），本仓文案原样透传。
- **`sessionProjections`**：同上一节，自调的查询侧按同一条路由回落链取当前路由。

## credentials：凭据状态面

- `ctx.credentials` 在 `src/index.ts` 的 `inject` 里作顶级依赖（与 `settings` / `llm` 并列），不用 `ctx.get`：宿主基础配置无条件挂载它 ⇒ 缺失即异常部署，PENDING 暴露好过静默降级。
- `describe(ref): Promise<CredentialInfo{ configured; source?; writable }>`：按引用名描述、**永不回值**；解析分层 进程环境 → provider 存储 → `.env`，空值视为未配置。本仓只读 `configured`。判定口径与宿主模型页 `hasProviderApiKey` 同源（settingsNs 段沿 settingsPath 取 profile → `apiKeyEnv` → `describe().configured`）。
- `credentialRef(value)`（**值导入**）：裸字符串品牌化，语法外（POSIX 标识符）抛 `TypeError` ⇒ 调用前须过 `isCredentialRefName` 预检（同包值导出、不抛）；本仓语法外引用名一律放行不隐藏。
- 官方适配器默认引用名：`llm-deepseek-api-key` 的 `Config.apiKeyEnv` 默认 `"DEEPSEEK_API_KEY"`（volatile）⇒ 段缺该字段时本仓判定回退同名常量 `DEFAULT_OFFICIAL_API_KEY_ENV`。
