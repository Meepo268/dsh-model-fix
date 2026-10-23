# 宿主契约：LLM 面

契约基线 devDep `0.1.7-rc.2`（差异见 `drift.md`）；本片覆盖 `ctx.llm` 的验证请求、模型清单与 `resolveModelInfo`。

## 验证请求

- `ctx.llm`（`DSH/packages/llm/llm/src/index.ts`，`LlmRuntime`），`inject` 非可选但本仓只做 type-only 引用。
- `stream(options): AsyncIterable<StreamChunk>`。适配器抛错被宿主归一化成 finish 帧（`signal.aborted || code==='ABORTED'` → `aborted`，否则 `error`）——**本仓拿到的只有 finish 帧，不接异常**。
- `GenerateOptions` 依宿主类型面（typecheck 兜漂移）；本仓只传 `provider / model / reasoningEffort / messages / signal`（`AbortSignal.any` 组合外部与自建超时）。
- `StreamChunk` 里索引字段名是 `index` 不是 `blockIndex`；本仓只认 `block-start` 判受理。
- `FinishReasonMap` 按 `kind` 分派须留 fallback；`failure` 只在 `aborted` / `error` 两支存在 ⇒ 读前必须判 `kind`。`aborted` 不当失败（外部中止与自建超时都归它），按 `signal.aborted` 区分并单列 `'aborted'`。
- `LlmFailure` 分类只能按 `code`：`status` 在 pi-ai 路径恒缺（上游压平成 `{message, code}`）⇒ 不可用 status 缺失推断不可达（实测踩过错：一次 400 未识别掉兜底被误判断线）。
- 失败码来源三类（清单见 `literals.md`）：宿主 `error.ts` 核心常量、`index.ts` 抛出的码、`retry-policy.ts` 默认可重试集。
- 本仓走 `llm-pi-ai` 路由，错误经宿主 `classifyPiAiError` 按文案正则归一化；pi-ai 上游把 Error 压进 `error.message`、无 `status` 与 `cause`。凭据无效只认 `INVALID_CREDENTIAL` 与 `MISSING_CREDENTIAL`，不认 `AUTH`。
- `ReasoningEffortId`（`DSH/packages/llm/llm/src/brand.ts`）：品牌类型 + 运行期工厂（不校验）。本仓只 type-only 引用、`as ReasoningEffortId` 断言，不引运行期构造器。
- 档位 id 取值由适配器自定；本仓档位名来自 models.dev 目录，不是宿主枚举。不传 `reasoningEffort` 时宿主按 `defaultEffort` 物化——「不带档位 = 不发该字段」。
- **宿主按模型公告的档位本地校验**（`resolveCallWithInfo`）：`info.reasoning === undefined` 带档即抛 `UNSUPPORTED_REASONING_EFFORT`；档位不在 `reasoning.efforts` 也抛 ⇒ 未声明的档位不出网，「探测档位」必须先预声明。

## 模型清单面（记忆剪枝的判据）

- `listProviders()` 同步、当前全部活路由；`listModels(provider)` 直穿 adapter 无缓存，provider 未注册抛 `NO_ADAPTER`（剪枝须当「读不到」）；`listConfigurableProviders()` 同步声明序（「隐藏官方API」读它取 settingsNs / settingsPath 定位凭据段；目录条目是声明而非活路由，未声明无从判定、照常显示）。
- `listModels` 是原型方法，可用实例自有属性遮蔽（`llm.listModels = wrapped` 全部消费者生效）——「隐藏官方API」即据此实现，安装带 `Symbol.for` 标记幂等。**宿主若把它改成箭头函数类字段，遮蔽失效**。
- UI 模型目录唯一生成链路（`DSH/packages/api/session-controller/src/types/catalog.ts`）：`buildModelCatalog` 逐 provider `listModels` + `resolveModelInfo`，末了滤掉模型数为 0 的组 ⇒ 返回空清单即组从目录消失。本仓刻意不用它：逐模型 `resolveModelInfo` 可能打网络，且默认参数求值执行未 inject 的 `ctx.agentDefaultModel`。
- 目录刷新由浏览器侧宿主服务负责：`llm/adapters-updated`、`settings/document-updated`、`credentials/record-updated`、`credentials/reference-updated` 任一到达即 `catalog.refresh()` ⇒ 插件改开关 / 配密钥后 UI 自动重取，零事件接线。
- `llm/adapters-updated`：provider 拓扑变化在每个 commit 点（含 dispose）触发，payload-free ⇒ 到达时拓扑已是新的。模型级增删不触发它 ⇒ 记忆剪枝除挂它外还挂 `settings/document-updated(llm-pi-ai)`。

## `resolveModelInfo`：档位显示名的唯一出口

- `reasoning.efforts[].name` 只在它返回里出现（`buildModelCatalog` 原样搬进目录载荷；UI 菜单 / 触发器标题 / subagent 工具全取它）⇒ 遮这一处全链覆盖（与 `official-filter` 遮 `listModels` 同一 `LlmRuntime` 实例、同一形态）。
- 消费者影响面已核实：除 `tool-subagent` 的 list-models 把 `effort.name` 拼进给 AI 的文本外，其余消费者只取 `context` 与 `inputModalities` ⇒ 开关开时 AI 看到的档位名也是中文（已知取舍）。
- `defaultEffort` 不可翻译：它是档位 id，`LlmRuntime` 校验它落在 `efforts[].id` 内（不合法抛 `INVALID_MODEL_REASONING`）。
- 名字来路：适配器按档位 id 现算（`id` 首字母大写），配置侧只有 id 无名字字段；宿主词典刻意不本地化档位名。`normalizeModelInfo` 只校验/分离、返回新建对象，换名不动入参。
- 另作「档位自调」的查询工具入口（`src/self-tune.ts`）：解析任一活路由的模型信息（档位来自适配器元数据），出参不含 `defaultEffort`，失败 catch 兜成 `resolve-failed` 不外抛。
- Node 侧语言判定三路（`locale.preference` → 浏览器上报 → `en`）：宿主 locale 插件把显式选择存 `locale` 段 `preference` 字段（随 settings 文档持久）；`locale` 服务只在浏览器半提供，Node 侧读不到自动探测结果，故未显式选择时由浏览器启动时经 `reportLocale` RPC 上报（进程内易失）。
