# 宿主契约：浏览器半服务面

契约基线 devDep `0.1.7-rc.2`（差异见 `drift.md`）；本片覆盖 slots、locale、configForms、会话与布局类服务。

## slots：六席注册

`ctx.slots`（`DSH/packages/client/ui-renderer/src/client/registry.ts`，`SlotRegistry`）。

- `register` 是原型赋值、内部包 `ctx.effect` ⇒ **register 必须能挂 effect 生命周期**；向未声明 slot 注册直接抛 `slot "…" is not declared`。
- `inject(key, callback)`：回调返回清理函数（可生成器做原子装卸），内部包 effect。带 inject 的 register 重载用 `BaseOptions{ name; children?; store?; locale?; registrant? }`，**没有 binding 对象参数**；工厂参数按席位类型给 `sessionId` 或 `sessionId | undefined`，声明 store 时追加 `actions`。
- props 合成：`hooks` 被渲染器绑成 `use<Name>` 选择器 hook（组件看不到裸 observable）；**只有 `register({ locale: NS })` 声明了命名空间，props 上才出现 `t`**。
- 条目字段（`KindOptions`）：list `{ id; order?; label?; priority? }`、keyed `{ key; priority? }`、chain `{ select; priority? }`；`SlotLabel = string | (() => string)`（每次渲染求值）。keyed 拼接 `rowConfigKey(bundle, rowId) = \`${bundle}#${rowId}\`` ⇒ 本仓 `${PLUGIN_NAME}#${PLUGIN_NS}` 逐字成立。
- 本仓六席：

| slot key | SlotMap 定义 | kind | 条目字段 |
| --- | --- | --- | --- |
| `settings.models.footer` | `DSH/packages/client/ui-settings-models/src/client/slot-contract.ts`（**不在 ui-settings**，搜定义别漏） | list | `id` / `order?` / `label?` / `priority?` |
| `plugins.bundle.config` | `DSH/packages/client/ui-plugin-manager/src/client/slot-contract.ts`（owner props `PluginConfigViewProps`） | keyed | `key`（包名）/ `priority?` |
| `plugins.row.config` | 同上（JSDoc：keyed by `<package>#<row id>`） | keyed | 同上 |
| `settings.plugins.tab` | `DSH/packages/client/ui-settings/src/client/contract/slots.ts` | list | `id` / `order?` / `label?` / `priority?` |
| `conversation.input.left` | `DSH/packages/client/ui-conversation/src/client/contract/slots.ts`（无 owner props） | list | `id` / `order?` / `label?` / `priority?` |
| `settings.launcher` | `DSH/packages/client/ui-settings/src/client/contract/slots.ts`（owner props `SettingsLauncherOwnerProps`） | single | `priority?`（遮蔽用） |

- 席位声明者是宿主外壳 `ui-settings-general`（它的 `children` 表声明 `settings.launcher`）⇒ 注册必须写在 `ctx.slots.inject('settings.launcher', …)` 回调里。
- **single 席位的遮蔽（shadowing）**：同一格可共存于不同 `priority`，**数字最小者渲染**（账本按 priority 升序稳定排序，渲染器取 `entriesOfSlot(key)[0]`）；同 priority 再注册才抛错。宿主账号包注册 launcher 时未设 priority（默认 0），本仓以 `priority: -1` 注册即遮蔽它。
- `StoredEntry.registrant` 是运行时盖的**注册方 fiber 名**（`options.registrant ?? fiber.name`）⇒ 据此判「账本里有没有本插件之外的占位者」。`ctx.slots.entries(key)` 与 `ctx.slots.subscribe(key, fn)` 均为公开面。

## locale：词典与 `t`

- `ctx.locale`（`DSH/packages/client/locale/src/client/index.ts`，`LocaleRuntime`）：事件 `'locale/change'`，**字典注册不发该事件**。
- `register(ns, dicts)` 返回幂等 disposer；**重复注册抛错** ⇒ 一律经 `ctx.effect` 挂。
- `bind(ns)` 每 ns 缓存同一函数引用（身份稳定，可放 label thunk 依赖数组）；`bind` 出来的 `t` **按调用时刻的语言求值**，故语言切换后要重渲才能拿到新文案。
- `subscribe(fn)` / `getSnapshot()` 是 LocaleFace 契约（快照带 `revision`，变更才换引用）；退订挂自己的 `ctx.effect`。
- 本仓私接面（非公开类型面，宿主改名即静默失效）：`ctx.locale` 实例上的 `dicts`、`publish`、`snapshot`——因 `register` 禁止同 ns+locale 重复注册，改宿主既有词条值只能 mutate 已注册对象再手动 `publish`。第二层键是 `localeKey()` 的小写结果（`'zh'`）。`src/client/locale-patch.ts` 即走这条路改宿主 `model` NS 的 `effort.providerDefault`（宿主 `ModelSelect.tsx` 自合成的 Default 伪菜单项取该词条，不经数据层，Node 半遮蔽碰不到）。本仓以本地 `LocaleRuntimeHack` 接口 + `as unknown as` 转换。
- 类型面（`DSH/packages/client/ui-slots/src/index.ts`）：`LocaleNamespaceMap` 声明合并点（`src/client/locale-keys.ts` 扩展）、`Translate<K>`；调用形态 `t(key, params?)`。官方范本：`label: () => t('…')` + `locale: NS` + `ctx.effect(() => ctx.locale.register(NS, { zh, en }))`。

## configForms：配置表单

- `get<T>(entryId)` 只有 entryId 一个形参；查无 NS 不抛错（`status='unavailable'`，与 loading 可区分——本仓卡片依赖此差异）。decode 只存在于包内 `ConfigFormSpec`，不对外 ⇒ 本仓解码全在 `src/client/scope.ts` 的 `makeScope`。
- `ConfigFormSnapshot<T>`：`status / value / base / user / revision / writable`（devDep 版本另有 `mode`，较新宿主已移除）。
- 写方法 `mutate` / `set` / `unset` 返回 **boolean**：被拒或跳过返回 false、**传输失败 reject**。写入实际路径 `this.ctx.remote.settings.mutate(ns, ops, revision)`；持久化模式 `isLoopback ? 'host' : 'memory'` ⇒ 非 loopback 下本仓所有保存返回 false（以 `writable === true` 才允许保存）。
- **`mutate` 入参形态**：宿主签名写的 `SettingsPathOpView` 来自未装的 `@deepseek-ai/dsh-api-remotes/client`（`skipLibCheck` 下退化成 `any`），故不能用 `Parameters<>` 取形态；`src/client/scope.ts` 直接标成 `dsh-settings` 的 `/types` 子路径同名导出（两包各持一份同形声明）。

## sessions / modelDirectories：记忆的存取

- `ctx.sessions`（`ISessions`）：`list / retainInfo(id) / scope(id) / binding(id)`——**未知/未保留会话 `binding` 返回 undefined 不抛错**。
- 投影 `modelSelection`（schema 为 provider / model / reasoningEffort）：**wire 视图 `next = state.pending ?? state.lastUsed`**；face 身份稳定、永不为 undefined。
- `ctx.modelDirectories`（`ModelDirectoryResolver`）：`directoryFor(sessionId)` **对未知 id 显式抛错**（与 sessions.binding 相反，记忆链路 try/catch 依赖两者各自口径）。
- `ModelDirectory`：`store / load() / select(selection)（失败写 `status='error'` 并返回原始失败，不抛）/ assertAvailable`（抛 `model selection is unavailable for addressed subagent sessions`）。目录只用于写入/恢复侧，失效清理走 `ctx.llm` 清单。

## layout：中心面板选择（返回对话按钮）

- 契约（`DSH/packages/client/ui-layout/src/client/service.ts`）：`selectPanel(panelId: string | null): void`。`null` 即选中会话界面、不改当前会话；非 `null` 选已注册的全局面板。本插件只用 `selectPanel(null)`。`panelInfo.getSnapshot().activePanelId === null` 即**主视图**。
- 服务面按契约取用，不引宿主包也不本地声明类型（该包不在 devDep 清单，其类型面会顶掉浏览器半 `ctx.sessions` 增补）；`src/client/back-to-chat.tsx` 在子 fiber 内 `child.get('layout')` 取用。宿主改名不再有编译期信号，靠本节登记兜底。
- 经子 fiber `ctx.inject(['layout'], …)` 门控：服务到位按钮才可见，缺席则静默 PENDING。
- DOM 锚点：`[data-slot="main"]` 锚点的父元素即 AppFrame 中心列（宿主 CSS Module 类名随构建 hash 变化，不可按类名找）。中心列没有 `position`（其定位上下文是整帧 `.frame`），按钮组要贴中心列左侧 ⇒ 就地补一条 inline `position: relative`（该元素只由宿主 className 渲染，inline style 不被覆盖，卸载时还原原值）。宿主 Modal 的 `z-index` 是 1000，按钮组取 999。

## uiSession：主视图会话与会话状态

- `ctx.uiSession`（类 `UiSession`）：缺席则静默 PENDING（按钮按空闲显示）。`adapter.current.props.sessionId` 即**当前主视图会话**；子智能体被打开时 mainView 落到子会话上 ⇒ 主视图会话可以是子智能体。
- `sessionStatus`：`Map<SessionId, { running; pendingInteraction; completionUnread }>`。宿主工作区会话行的状态判定（`ui-workspace/src/client/rows/Rows.tsx` 的 `sessionStatuses`，**未导出**）依次为 pendingInteraction → `warning`、running → `ongoing`、子智能体在跑 → `ongoing`、`completionUnread` → `done`、其余 `idle`；本仓本地复刻同一套判定，状态文案沿用 `ui-workspace/src/client/locales.ts` 的 `status.*` 键。
- `completionUnread` 只给**非主视图**会话置（`isMain` = `retainedBy.mainView > 0`）。
- 层级事实：`origin === 'subagent'` 才标记子智能体（**fork 子会话也带 `parentId` 但 origin 不是它**）；`parentId` 只到**直接父**（list 只透传 header 一层），父目录未物化时 retain 回退分支不写它 ⇒ 该窗口内按当前会话显示。工作区不渲染子智能体行 ⇒ 永显示主视图会话行。会话标题取 `byId[id].displayTitle`（持久化标题 → descriptor label → 会话 id）。
- 子智能体目录投影 `subagentCatalog` 只在 `@deepseek-ai/dsh-subagent` 的类型面声明（该包会把 Node 侧 `ctx.sessions` 增补带进来），本仓按契约复制最小面。

## uiWorkspace：换主视图会话

- 契约（`DSH/packages/client/ui-workspace/src/client/navigation.ts`）：`openSession(target: SessionTarget): void`，`SessionTarget = SessionId | SubagentAddress`。内部 `replaceMain(target, …, 'reveal')`：retain 新会话为 `mainView` → 释放前一个 reference → `selectPanel(null)`。本插件只传 `SessionId`。
- 换 mainView 只有这一个入口：`UiWorkspaceService.mainReference` 是私有字段。
- 经子 fiber `ctx.inject(['uiWorkspace'], …)` 取用，缺席则静默 PENDING——**不门控按钮可见性**：缺席时子智能体视图下的点击退化为 `selectPanel(null)`。
- 本地不声明类型也不引宿主包：它经 `@deepseek-ai/dsh-subagent/client` 把 Node 侧 `ctx.sessions` 增补带进 typecheck 程序，故本地声明最小面 `UiWorkspaceNav`。

## 会话页签：当前页签判定与切换

- 当前页签读 localStorage `dsh.conversation.{sid}` 的 `view` 字段（宿主 per-session store 的持久化值）。
- 切页签派发宿主页签按钮的原生 click：宿主 `actions.setView` 只经 slot 内部 store 绑定下发，插件侧不可达。
- 页签条锚点 `[data-conversation-tabs]`，其内首枚 `button[role="tab"]` 即「对话」（宿主 `conversation.view` 席位按 `order` 排，`ui-chat` 的 `chat` 为 order 0；宿主若调整该 order，本定位即失效）。
