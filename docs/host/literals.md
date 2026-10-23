# 宿主字面量：依赖宿主的键与码

改这些字面量必须确认宿主侧同名同值。宿主行为假设分面登记在 `runtime.md` / `llm.md` / `agent.md` / `transport.md` / `client.md`，本文不重复。

## 命名空间

| 常量 | 值 | 宿主语义 |
| --- | --- | --- |
| `PLUGIN_NS` | `tikaflow-model-fix` | 自有 settings 命名空间 = `cordis.patch.yml` 的 `id`；浏览器半 `configForms.get(ns)` 与 Node 半写回 NS 同一字面量（`src/shared/constants.ts`） |
| `API_NS` | `llm-pi-ai` | 宿主自带段；本仓只读 user 层、在同段写 `providers.<id>.models` 与路由 `compat` |
| `PLUGIN_NAME` | `dsh-model-fix` | npm 包名；Node 半日志前缀与 User-Agent、浏览器半 `export const name`、样式标签 HMR 标记共用 |
| `CARD_NS` | `settings.modelFix` | locale 命名空间 |

## 路由 compat 字段（`src/constants.ts`）

`supportsDeveloperRole` / `supportsStore`（宿主侧 `PiAiCompatProfile` 的 `COMPLETIONS_COMPAT_GATE`，只在 `openai-completions` 消费）。写 `false` = 请求体不带 `store` 键 / 系统提示用 `system`；宿主对未标注端点按「支持」推断（`model.compat.字段 ?? detected.字段` 合并），本仓翻成保守。字段名、检测取向或合并口径变化须同步。

## 子智能体

- 服务名：`subagentModelSelection` / `agents` / `sessionProjections`（经子 fiber 注入，全就绪才注册监听）。
- 投影键 `'modelSelection'`；`SessionHeader.origin = 'subagent'`。
- 浏览器半读宿主段 `subagent-model-selection-settings` 的 `enabled` 布尔（`src/client/composer.tsx`，段缺席视为未开启）。

## 档位自调

- 服务名 `tools` / `systemPrompt` / `sessionController` / `sessionProjections`（任一缺席 ⇒ 子 fiber PENDING 静默）。
- 工具名 `query_reasoning_efforts` / `set_reasoning_effort`（同名重复注册抛错，故装载幂等——已加载时自有段变更跳过，只在开关真翻转时装/卸）。
- 提示词段名 `model-fix:effort-tuning`、`order: 3200`。

## RPC

- channel `/tikaflow-model-fix`。
- 流路由（`connection.fetch` exact 路由，须落 `/api` 下）：`VERIFY_STREAM_ROUTE = /api/tikaflow-model-fix/verify`、`PROBE_STREAM_ROUTE = /api/tikaflow-model-fix/probe`；浏览器 `fetch` 用同名的 `*_URL`（`ROUTE.slice(1)` 的文档相对路径）。两条流共用 `src/rpc.ts` 的 `progressStreamFetch`；探测那条入口先查守卫（一轮写两次配置），已开回 409 + 中文文案。
- endpoint：`forceUpdate` / `resetModels` / `restoreModels` / `reportLocale`，结果信封 `{ ok: true, value: { changed } }`。
- 本仓错误码（`ConnectionRpcResult` 的 `error.code`）：`model-fix/write-in-progress`、`model-fix/force-update-failed`、`model-fix/reset-models-failed`、`model-fix/restore-models-failed`、`model-fix/unknown-endpoint`。
- 宿主错误码：`SETTINGS_CONFLICT`；信封层 `gateway/bad-request`；传输层 `gateway/internal`；`invalid-request`（本仓自复刻的非法 rpcId 哨兵，非宿主常量）。

## LLM 失败码

按 `failure.code` 判，不看 `status`、不比对文案：`UNSUPPORTED_REASONING_EFFORT`、`QUOTA`、`ACCOUNT_QUOTA`、`INVALID_CREDENTIAL`、`MISSING_CREDENTIAL`、`TRANSPORT`、`STREAM_CLOSED`、`RATE_LIMIT`、`TIMEOUT`、`INVALID_REQUEST`。

## slot 与逐字复制的宿主制品

- slot 席位名：`client.md` 六席表；`plugins.row.config` 的 `key` 拼接规则 `${包名}#${patch 条目 id}`。
- 逐字复制的宿主正则：`EXCLUDE_ID_PATTERN`（宿主 models 页提供方 id 校验）、`ENDPOINT_SEGMENT`（宿主 RPC 路径段校验）；宿主改这两处须同步。
- 逐字复制的宿主构建串：`transport.md`「模块装载」的 banner / intro / footer 三行。
- 官方 API key 环境名回退常量 `DEFAULT_OFFICIAL_API_KEY_ENV`（宿主 `llm-deepseek-api-key` 的 `Config.apiKeyEnv` 默认值 `"DEEPSEEK_API_KEY"`）。
