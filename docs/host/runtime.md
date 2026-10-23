# 宿主契约：settings 与 cordis 基础面

宿主侧引用写 `DSH/<宿主仓库内路径>`（虚拟锚点；本仓不检出宿主源码，锁的是「契约来自宿主哪个文件」）。契约基线 devDep `0.1.7-rc.2`（差异见 `drift.md`）；其余宿主面：`llm.md`、`agent.md`、`transport.md`、`client.md`。

## settings：读写

`ctx.settings`（`DSH/packages/settings/settings/src/index.ts`，类 `SettingsForms`），`inject` 非可选。

- `describe(options?)` → `SettingsDescriptor[]`；本仓只用 `{ ns, user, revision }`，刻意不传 `redactSecrets`（要明文 user 层比对）。读取收口 `src/section.ts`，读不到返回 `undefined` 不抛。
- `mutate(ns, ops, expectedRevision?)` 返回 **void**（变更数自己数）。`SettingsPathOp` 与客户端线 `SettingsPathOpView` 类型不兼容，`src/client/scope.ts` 转发时逐字段浅拷贝。
- revision 不符抛 `SettingsConflictError`（`code='SETTINGS_CONFLICT'`）；重试判据收口 `src/shared/errors.ts` 的 `isSettingsConflict`。
- 写入语义（`applyPathOp`）：
  - 根必须纯对象（`isPlainObject` 排除数组）⇒ 自有配置只能是 `version-N → 快照` 映射，不能用列表。
  - `unset` 只删本键、不折叠空父对象 ⇒ 删空壳必须整段 `unset`（`src/compat.ts` 整段 unset、`src/empty.ts` 空壳判据都建立在这条上）。
  - 只许写 volatile 字段（`isVolatilePath`）。本仓两处写入都在 volatile 子树：自有段根 volatile ⇒ 整段可写；`llm-pi-ai` 段的 `providers` volatile ⇒ `providers.<id>.models` 与 `compat` 可写。
  - `fix` 按 provider 整段 `set` 覆盖 `models`、不写数组下标中间段，是「下标支持与否」两种读法的安全子集。
- `providers.<id>.baseURL` 是该路由的端点（`PiAiProviderProfile.baseURL`，缺省时宿主回落内置目录默认端点）。本仓**只读不写**，用作填充的端点匹配依据（`src/lookup.ts` 阶段一）。字段名是 `baseURL`（大写 URL）、路由级、不随模型逐条配置。

## settings：变更事件与装载时序

- `settings/document-updated` payload `(ns, revision)`，`ns` 是品牌字符串；本仓只取第一参分流。只在 RAW 段变更时发（自动生成段不发）——「守卫期间短路整条事件链」的必要前提。
- 自有 NS 登记晚于 `apply`：宿主无命名空间注册事件、无 ready promise，NS 由 Loader 异步登记 ⇒ `src/migrate.ts` 有界轮询（见 `MIGRATE_WAIT_MS`）等 `describe()` 出现 `PLUGIN_NS`，读不到早退。迁移必须先于填充（旧格式会被按新 schema 误解析）。
- 宿主事件可能在自己 HMR 事务的 AsyncLocalStorage 上下文里同步派发 ⇒ 全部 settings 写回收口 `src/host.ts` 的 `queueTask`。

## hmr：`executing`（私有面）

`ctx.get('hmr')` 服务类的 **private** 字段 `executing = new AsyncLocalStorage<boolean>()` 标记「当前异步上下文正在跑一次 HMR 事务」。`src/host.ts` 经模块级 `_hmrExecuting`（`src/index.ts` 子 fiber 注入）用：是 `AsyncLocalStorage` 则 `als.exit(task)` 否则裸 `task()`。**私有字段非公共面，宿主改名即静默降级**。

## cordis 基础面

- `ctx.effect(execute, label?)`：execute 立即执行，disposer 调用时或 fiber 卸载时（先到者）**逆序**执行；已卸载抛 `INACTIVE_EFFECT`。「注册必须挂 effect」的纪律基于这一条。
- `ctx.inject(deps, callback)`：等价 `this.plugin({ inject, apply: callback })`。**未满足的服务保持 PENDING（无超时）** ⇒ 卡片等 `configForms` 必须能长期停在「加载中 / 不可用」。依赖全部就绪后才执行回调（缺席则不执行）⇒ 回调内 `ctx.get(服务名)` 必可取到；依赖变更时回调被卸载重跑，回调内副作用须自带退订。

## Config 装载：`z.any().volatile()`

派生表单与可编辑投影（`volatileForm` / `projectForm`）⇒ `Config` 必须 `z.any().volatile()`：根 volatile 使整段原样通过投影（用 dict 则未声明键被抹成 `{}`），这也是自有段可被 `mutate` 写回的前提。

## cordis：config 的实时引用

`apply(ctx, config)` 第二参是 `Volatile<T>` 引用不是裸对象（volatile schema 产出 `createVolatile(value)`，返回**冻结**的 `{ get: () => current }`）⇒ 必须每次 `config.get()`，不能缓存解引用（`src/index.ts` 把 getter 交给 `setConfigSource`）。引用身份稳定、就地更新（emit `loader/volatile-update`，仅发给 owning fiber）⇒ volatile 变更**不重启 fiber**。根 volatile 受支持，`.volatile()` 不能叠加。

## cordis.patch.yml 的 id ↔ 命名空间

命名空间 = patch 条目 id（`EntryOptions{ id }` → `import(name)` → `registry.plugin(plugin, config, …)`）；settings 侧只读 `entry.fiber.config`。登记门槛：fiber 未 ACTIVE 或 schema 为 undefined 的 entry 被跳过 ⇒ 命名空间晚于插件 `apply`（`src/migrate.ts` 有界轮询的原因）。

## 装载与 HMR 契约

- Node 半 `export const inject = ['settings','llm','credentials']`；`configForms` 只作子 fiber 标记（不进父级 inject）；`connection` / `webServer` 在 `src/rpc.ts` 子 fiber 内声明。
- **子 fiber 卸载不清理父 ctx 上的注册**（`_unload` 只清自身 disposables）：一次性注册（`locale.register`、slot 注册）必须挂会随重建而卸载的那个 fiber，否则第二次注册抛 `already has locale`。取服务不受限（属性读沿父链上溯）。
- **遮蔽 `ctx.llm` 上的方法在 HMR 重载后会套第二层**：重载整函数重跑，服务属性不随 fiber 卸载复原 ⇒ 遮蔽层各带一枚 `Symbol.for` 品牌标记作幂等（`official-filter` 遮 `listModels`、`effort-name` 遮 `resolveModelInfo`）；卸载一律不动服务上的属性——链式遮蔽下动属性会抹掉别人的遮蔽。
- **宿主 `ObservableSnapshot.subscribe` 一律不推首值** ⇒ 所有订阅后必须手动补跑一次（含 `ctx.locale.subscribe`、`sessions.retainInfo.subscribe`）。
- 浏览器半样式经模块级幂等 `<style>` 注入并带 `data-plugin` 标记供宿主 HMR 认领；`ctx.locale.register` 重复注册抛错，disposer 必须经 `ctx.effect` 挂。
