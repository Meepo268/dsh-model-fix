# 宿主漂移：观察项与升级检查清单

查阅的宿主源码可能比 devDep 新（`0.1.7-rc.2`）：差异记入「观察项」，**不顺手改代码、不据此升 devDep**（README 支持范围与类型面基线是两件事）。升宿主大版本按「检查清单」逐条过。

## 观察项

- **settings 路径 op 数组下标中间段**：较新版本已支持。本仓按 provider 整段 `set` 在两种语义下都成立；0.2.x 后若改用下标写法须先在 devDep 版本实测。
- **平台模块表**：本仓两份副本比宿主 `platform.ts` 少一项 `@deepseek-ai/dsh-client-ui-dockkit`——当前无碍，宿主若把本仓在用的模块移出表则会被打进浏览器包。升宿主时两份一起逐位比对。
- **官方 provider 的 `models` 有默认兜底**（`llm-deepseek` 的 `.default(DEFAULT_MODELS)`）：清空配置来隐藏它实测不生效，故本仓拦目录生成链路。该兜底若被去掉，这条观察可撤。
- **`NODE_EXTERNALS` 含 `@deepseek-ai/dsh-credentials`**：tsdown 默认只外置 dependencies/peerDependencies、devDependencies 会被内联（实测 0.22.14 内联出的 `credentialRef` 与宿主服务面脱钩），故加进 `NODE_EXTERNALS`。升 tsdown 时复核 `lib/index.js` 首行仍是外置 import。
- **pi-ai 适配器的 `listModels` 对未解析凭据改为返回空清单**（alpha.3：rc.2 是直接抛出）：`official-filter` 按 `describe().configured` 判定、不看是否抛，功能不变；`memory.ts` 把「读失败」与「成功但空」分开处理，alpha.3 下未配凭据的自定义提供方记忆被清——按「凭据缺失即用不了模型、删记忆是对的」口径接受。
- **宿主自 `0.2.1-alpha.2` 起原生隐藏「未配密钥的官方 API 组」**：本仓功能保留作老宿主兜底。`deepseek-account` 自带登录门，宿主凭据判定显式跳过它 ⇒ **不得加进 `HIDDEN_OFFICIAL_PROVIDERS`**。
- **`Pill` 的形态由 `onClick` 是否存在决定**（无则静态 `span`、有则 `button`；无 `:disabled` 规则）⇒ 卡片「恒定展示行」用「不传 `onClick`」表达不可操作态，置灰走本地 `.dsh-mf-pillLocked`。
- **「经典设置」依赖宿主两件事**：账号包服务缺席则 fiber PENDING、不认领 `settings.launcher`，侧栏底显示外壳自己的回退触发器（本仓复刻的正是它）；以及遮蔽规则（`priority` 升序、最小者渲染；`registrant` = 注册方 fiber 名）。宿主改这两条须复核 `src/client/classic-setting.tsx`。
- **`settings.models.footer` 的 SlotMap 定义在 `dsh-client-ui-settings-models` 而非 ui-settings**——搜 slot 定义时别只搜后者。

## 升级检查清单

### 打包与模块表

- 逐位比对 `BROWSER_HOST_BASELINE`（`eslint.config.ts`）与 `CLIENT_EXTERNALS`（`scripts/build-externals.mjs`）同宿主 `platform.ts`（已比对 `0.2.1-alpha.3`：宿主表仅多 `dockkit` 一项）。
- 复核 `lib/index.js` 首行仍是外置 import。

### 类型与符号

- 对所有宿主类型导入跑 typecheck；**值导入的符号漂移 typecheck 抓不到**，须人工比对 `@deepseek-ai/dsh-client-ui-primitives` 用到的全部符号。
- 逐字段比对 `TerminalBlockLabels`。待收：`card-verify.ts` 与 `card-probe.ts` 两处 `useMemo` 多带的 `commandLine`，升 devDep 后一并改。
- 复核 `@deepseek-ai/dsh-session` 包根与 `@deepseek-ai/dsh-api-session-controller/client` 对 `Context.sessions` 的声明合并是否仍冲突（未解则保留 `imports.md` 的四处契约复制）。

### 运行时面

- 复核 `uiWorkspace.openSession` 仍是换 `mainView` 的唯一入口（`UiWorkspaceService.mainReference` 是私有字段）。
- 复核适配器是否仍兑现 `options.signal`（超时两级硬闸靠它传中止）。
- 复核 `ctx.sessions.binding()`（返回 `undefined`）与 `ctx.modelDirectories.directoryFor()`（抛错）的失败契约，互换会让记忆链路 try/catch 失准。

### LLM

- 复核 `classifyPiAiError` 的文案正则（它决定 `TRANSPORT` / `STREAM_CLOSED` 的归一化来源）；码清单见 `literals.md`。

### slots / locale

- 复核六个 slot key、`rowConfigKey` 拼接、`PropsLocale`（`t` 只在声明 `locale:` 时上 props）；另复核 `settings.launcher` 的遮蔽规则与 `registrant` 盖名方式。

### 子智能体注入面

- `agent/request` 仍可 prepend 且种子仍 `deepFreeze`；未打 scope 标签的 ctx 仍全局收事件；`ctx.agents.get()` 仍返回富面 `Agent`；`session.requestHeader()` 仍只反映父已发过的请求；`sessionProjections.stateOf` 的 `modelSelection` 形状与 pending 语义未变；`subagentModelSelection` 缺席/抛错语义未变。

### 档位自调

- `tools.register` definition 形状与 `systemPrompt.section` 形状；`selectModel` 失败仍抛 `RemoteError`；`resolveModelInfo` 返回的 `reasoning` 形状未变。

### 功能专属

- 「隐藏官方API」四条：`llm.listModels` 仍是原型方法；`buildModelCatalog` 仍滤空组；`credentials.describe` 与 `credentialRef` / `isCredentialRefName` 签名未变（已核 `0.2.1-alpha.3`）；宿主自 `0.2.1-alpha.2` 起 `discoverModels` 在 `MISSING_CREDENTIAL` 时返回 `[]`（本层据此空转）。
- 宿主版本读取面两条：`pluginPackages.packageOf(specifier, parentURL)` 仍返回带 `version` 的包；`__DSH_BOOT__.release.version` 仍是版本号字符串。任一改形 ⇒ 降级为「版本未知」⇒ 不空转。
- 「本地化推理级别」三条：远程方法仍装成可配置访问器；「方法先于依赖方装载」的同步窗口仍在；档位显示名仍由适配器按 id 现算（宿主若自带本地化词条或渲染插槽，本层可撤）。
