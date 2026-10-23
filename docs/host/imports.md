# 宿主类型导入清单

`@deepseek-ai/*` 一律 type-only 导入 devDep 面（构建期擦除，升宿主时 typecheck 即暴露不兼容）；「合并」= `import type {} from '…'` 只做 `declare module` 扩充，零运行期依赖。改动本表任一行的同轮同步本文。

## Node 半

| 宿主模块 | 导入符号 | 形式 | 使用处 |
| --- | --- | --- | --- |
| `@deepseek-ai/cordis` | `Context` / `Context as ClientContext` | type-only | Node 半各模块；`src/client/index.tsx`、`memory-listener.ts`、`rpc-carrier.ts` |
| `@deepseek-ai/schemastery` | 默认导出 `z` | **值导入** | `src/index.ts`（`Config`）、`src/upgrade.ts`（v7 冻结 schema） |
| `@deepseek-ai/dsh-settings` | `SettingsPathOp`、`SettingsDescriptor` | type-only | 各写回端点与 `src/client/scope.ts`（前者）；`src/section.ts`（后者） |
| `@deepseek-ai/dsh-settings/types` | `SettingsPathOpView` | type-only | `src/client/scope.ts`（**只引 `/types` 子路径**，包根未导出） |
| `@deepseek-ai/dsh-util-values` | `deepEqualJson`（值）、`JsonValue`（type-only） | 值 + type-only | `src/fix.ts` `migrate.ts` `compat.ts` `restore.ts` `probe-backup.ts`（前者）；`src/client/scope.ts`（后者） |
| `@deepseek-ai/dsh-llm` | `LlmRuntime`、`ReasoningEffortId`、`LlmResolvedModelInfo`、`LlmModelInfo` | type-only | `probe-engine.ts`、`verify.ts`、`probe.ts`、`effort-name.ts`、`official-filter.ts`；`src/rpc.ts` 另有合并导入 |
| `@deepseek-ai/dsh-llm` | `LlmCallConfig` / `LlmCallConfigAdapterDefaults` / `ReasoningEffortId` | type-only | `src/subagent.ts`（**必须包根**：`/types` 子路径不含 `LlmCallConfig`） |
| `@deepseek-ai/dsh-llm/types` | `LlmFailure` | type-only | `probe-verdict.ts`、`probe-engine.ts`（**只在 `/types`**，包根未再导出） |
| `@deepseek-ai/dsh-client-connection` | `ConnectionRpcResult`、`HostConnectionService` | type-only | `rpc.ts`、`rpc-route.ts`、`rpc-carrier.ts`、`card.tsx` |
| `@deepseek-ai/dsh-host-webserver` | `WebServer` | type-only | `src/rpc.ts` |
| `@deepseek-ai/dsh-credentials` | `credentialRef`、`isCredentialRefName` | **值导入** | `src/official-filter.ts`（Node 半宿主值导入，故登记进 `NODE_EXTERNALS`） |
| `node:http` | `IncomingMessage`、`ServerResponse` | type-only | `src/rpc-route.ts` |

## 浏览器半

| 宿主模块 | 导入符号 | 形式 | 使用处 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-client-ui-primitives` | `import * as primitives`、`TerminalBlockLabels`、`StateDot`、`StateDotState` | **值导入** + type-only | `src/client/` 各卡片文件（浏览器半唯一的运行期宿主 UI 依赖） |
| `@deepseek-ai/dsh-client-ui-settings/client` | `ConfigForm`、`ConfigFormSnapshot` | type-only | `src/client/index.tsx`、`scope.ts` |
| `@deepseek-ai/dsh-client-connection/client` | `ClientConnectionRpc` | type-only | `src/client/rpc-carrier.ts` |
| `@deepseek-ai/dsh-client-ui-slots` | `TranslateNS` + 合并（`LocaleNamespaceMap` 纳入 `CARD_NS`） | type-only + 合并 | 各卡片文件；合并：`src/client/locale-keys.ts` |
| `@deepseek-ai/dsh-api-session-controller/client` | 合并（`ctx.sessions`）、`SessionListState` | 合并 + type-only | 合并：`memory-listener.ts`、`back-to-chat.tsx`；后者：`back-to-chat.tsx` |
| `@deepseek-ai/dsh-api-session-controller/types` | `ModelSelection`、`ModelSelectionProjection`、`ModelProviderGroup` | type-only | `memory-listener.ts`、`effort.ts` |
| `@deepseek-ai/dsh-client-ui-model-selection/client` | `ModelDirectory` | type-only | `memory-listener.ts` |
| `@deepseek-ai/dsh-session/types` | `SessionId` | type-only | `memory-listener.ts`、`back-to-chat.tsx`、`subagent.ts`、`test/subagent.test.ts`（**只引 `/types`**：包根会把 Node 侧 `SessionStore` 增补带进来） |
| `@deepseek-ai/dsh-client-ui-session/client` | 合并（`ctx.uiSession`）、`UiSession` | 合并 + type-only | `back-to-chat.tsx`（其类型面只引安全子路径，不顶掉 `ctx.sessions` 增补） |
| `@deepseek-ai/dsh-client-ui-renderer/client` | 合并（`ctx.slots`） | 合并 | `src/client/index.tsx` |
| `@deepseek-ai/dsh-client-locale/client` | 合并（`ctx.locale`） | 合并 | `index.tsx`、`effort-name.ts`、`back-to-chat.tsx` |
| `@deepseek-ai/dsh-client-ui-settings-models/client` | 合并（`settings.models.footer`） | 合并 | `src/client/index.tsx` |
| `@deepseek-ai/dsh-client-ui-plugin-manager/client` | 合并（`plugins.bundle.config` / `plugins.row.config`） | 合并 | `src/client/index.tsx` |
| `@deepseek-ai/dsh-client-ui-conversation/client` | 合并（`conversation.input.left`） | 合并 | `src/client/index.tsx` |

## 契约漂移点

- **`TerminalBlockLabels` 自 `0.2.1-alpha.2` 起新增必填 `commandLine`**；devDep 停在 `0.1.7-rc.2` 编译面看不到，故 `terminalLabelsOf` 以 `TerminalBlockLabels & { commandLine }` 声明（避开 excess-property 报错、保住其余字段必填），多余字段在 `0.1.7-rc.2` 上被静默忽略。

## 按契约复制、不引宿主包的四处

冲突根源一致：`@deepseek-ai/dsh-session` 包根对 `Context.sessions` 的声明合并与 `@deepseek-ai/dsh-api-session-controller/client` 冲突，会把浏览器半 `ctx.sessions` 的 `ISessions` 退化成 Node 侧 `SessionStore`。下列宿主包只要出现在 `src/` 的 type-only 导入里就触发（`test/` 未触发但不可依赖）。

| 复制位置 | 替代的宿主包 | 复制的面 |
| --- | --- | --- |
| `src/subagent.ts` | `dsh-agent`、`dsh-tool-subagent/model-selection-settings` | `SubagentHost` / `HostSelectionService` / `SubagentRequestListener` |
| `src/client/back-to-chat.tsx` | `dsh-client-ui-workspace`、`dsh-subagent` | `UiWorkspaceNav`（只取 `openSession(sessionId: SessionId)`） |
| `src/self-tune.ts` | `dsh-tools`、`dsh-system-prompt` | `HostToolsService` / `HostSystemPromptService` / `HostSessionController` / `HostSessionProjections` |
| `src/client/classic-setting.tsx` | `dsh-client-ui-layout` | `selectPanel` 最小面 |

⇒ `package.json` 不列这些包。升宿主时若该合并冲突已解，可改回直接导入并删本地复制。

## 其它装载旁注

- 浏览器半运行期宿主依赖只有 `react`、`react/jsx-runtime`、`react-dom/client` 与 `@deepseek-ai/dsh-client-ui-primitives`；ui-primitives 属宿主冻结模块表提供，卡片用宿主运行期对象而非打包副本（符号漂移由 typecheck 拦，风险是宿主改名后运行期 `undefined`，React #130 打空该 slot 条目）。
- `react-dom/client` 同属宿主平台模块表：本仓列 peer + devDep 只为类型与打包外置，运行期 `createRoot` 由宿主兑现。宿主若改名该导出，typecheck 不报错（类型来自本仓 devDep）。
- `ctx.llm` 只做 type-only 引用：`dependencies` 不长新条目；档位 id 用 `as ReasoningEffortId` 断言不引运行期构造器。
- 浏览器侧 `connection` 的 rpc 面经 `unknown` 桥接：宿主 `connection` 服务声明合并只有服务端面。
- `src/client/scope.ts` 的唯一残留收敛是 `unknown → JsonValue` 断言（写回值恒为配置段 JSON 值；浏览器半门禁不允许引同包 `isJsonValue`）。
