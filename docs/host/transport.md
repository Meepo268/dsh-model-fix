# 宿主契约：连接、路由与模块装载

（契约基线：devDep `0.1.7-rc.2`，差异见 `drift.md`）

## connection：RPC channel 与进度流

- `ctx.get('connection')`（`HostConnectionService`）。connection 的 `inject` 只有 `['credentials']`、**不含 `webServer`** ⇒ 本仓必须同时 inject `['connection','webServer']`（`src/rpc.ts`），不能走宿主 `connection.rpc.handle`（它在 connection 服务 ctx 上求值 `owner.webServer`，必抛）。
- `HostConnectionHandle` 中本仓只读 `requestRejection` 与 `fetch`。
- `requestRejection` 返回 `401 | 403 | undefined`（先 Host/Origin 围栏再浏览器认证）；宿主拒绝时响应体逐字 `unauthorized` / `forbidden`，`src/rpc-route.ts` 围栏段照抄。
- `connection.fetch.register(route)`：`path` 须 `/api` 下绝对路径，重复注册抛，返回**异步 disposer**；`buffered` 请求体受宿主 JSON 体上限约束。回调收到标准 WHATWG `Request`；**`request.signal` 在客户端断开时 abort**（挂在 `res` 的 `close` 而非 `req`——`req.close` 请求体读完即触发，会把刚开的流掐掉）。
- RPC 信封（本仓在 `src/rpc-route.ts` 手搓）：`ClientRequest{ type:'client-request'; rpcId; method; payload }`、`ServerResponse{ type:'server-response'; rpcId; result }`、`ConnectionRpcResult<T> = { ok:true; value } | { ok:false; error: { code; message; details } }`。`rpcId` 是本仓自复刻哨兵 `invalid-request`（非宿主常量）；错误码与路由常量见 `literals.md`。
- 浏览器侧 `rpc.call(channel, endpoint, payload, signal?)` 把 channel+endpoint 拼成**文档相对**路径 POST；非 2xx 抛 `transport failure`、rpcId 不符抛 `rpcId mismatch`（卡片把 reject 与 `ok:false` 同路处理）。`signal` 只作用于这一次 fetch：中止即 reject 但 handler 照跑完，故写回端点按 `WRITEBACK_MS` 只解卡片占用态。

## webServer：prefix 路由

- `ctx.get('webServer')`（`WebServer`）。
- `register(route: WebRoute)` 同步 disposer；`WebRoute{ kind:'exact'|'prefix'; path: 绝对路径无尾斜杠; handler }`；重复 `(kind,path)` 抛。路由查找：先 exact 表、再 prefix 表取最长前缀。handler 拥有完整响应生命周期（可持有响应不结束，如 SSE）。
- gzip 中间件显式跳过 `text/event-stream`，另 `content-range` 存在也跳过；压缩默认关闭 ⇒ SSE 不被缓冲，但不能靠压缩规避背压。

## 模块装载：`window.__ModuleLoader__` 与 `dsh.client.inject`

- 契约（`DSH/packages/client/modules/src/index.ts`）：`ClientModuleLoaderTarget{ mode:'queue'|'live'; pendingQueue; load(registration); create(options) }`；`load` 参数（`src/client/manifest.ts`）：`ClientBundleRegistration{ id /* 插件包名 */; chunk?; factory: (require) => Record<string, unknown> }`。
- 产物形态由宿主构建注入：banner `window.__ModuleLoader__.load({ id: …, factory: (require) => {`、intro `var module = { exports: {} }; var exports = module.exports;`、footer `return module.exports; } });` ⇒ 本仓 `tsdown.config.ts` 的 banner/intro/footer 逐字复刻这三行。
- 宿主读 `materialize(id).exports`：`unwrapExports` = `exports.default ?? exports`（`__esModule` 再解一层）⇒ **default export 会丢掉 inject**（宿主 postmortem `0001-acp-default-export-drops-inject.md` 有案）；客户端半导出必须具名 `{ name?, inject?, Config?, apply }`，`apply` 必需（缺了抛 `invalid plugin…`）；`name` 不强制等于包名（只影响显示名）。
- 重复注册抛 `client-modules: duplicate factory registration…`；另有 `loaded without registering "…" via __ModuleLoader__.load`、成环 `module arrival cycle`。
- `dsh.client.inject` 权威语义（`DSH/packages/util/package-manifest/src/types.ts`）：`inject` = 「Informational package-name dependencies, not Cordis service injection.」⇒ 它**不是 cordis 服务名、不决定激活顺序**；本仓库槽位所有者包是为保证这些包先物化。声明 `dsh.client` 却缺 `lib/client.js` 会让宿主激活期聚合抛错 ⇒ **build 必须先于安装**。
