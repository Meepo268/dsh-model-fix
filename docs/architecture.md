# 架构：目录职责、数据流与跨半边界

宿主契约在 `docs/host/`（按面分片），设计动机另在专题文档。

## 目录职责

### Node 半（`src/`）

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 入口：`Config` schema + 单一 `apply`（备份 → 配置源与段变更接线 → 各功能安装 → 启动链） |
| `src/config.ts` | 配置解析（快照优先级）与配置源持有 |
| `src/migrate.ts` | 启动迁移、旧快照清理与自愈（排除列表去重） |
| `src/upgrade.ts` | 冻结的升级台阶链（v7 → 当前版） |
| `src/catalog.ts` | models.dev 目录拉取、缓存读写与分组 / 端点索引 |
| `src/lookup.ts` | 模型 id 匹配（端点 → 提供方 → 全局三级级联）与档位转换 |
| `src/upstream.ts` | 上游声明：`GET {baseURL}/models` 回包解析（纯函数）+ 按 URL 缓存/去重的抓取（best-effort） |
| `src/stamp.ts` | 参数指纹：四字段指纹采集/序列化、来源等级与 `mayReplace` 覆盖判定、按字段合并写入 |
| `src/source.ts` | 参数来源解析：pin（自动 / 只认上游 / 指定目录条目）与声明/目录两路的取用 |
| `src/compat.ts` | 路由 compat 纯写入计划 |
| `src/fix.ts` | 填充与写回：纯计划 `planFill` 出 op，`fix` 只做编排 |
| `src/memory.ts` | 推理级别记忆失效清理：存活清单 → 纯 `planPruneMemory` → 只写 `efforts` 键 |
| `src/empty.ts` | 空壳字段判据 `stripEmptyFields`，所有写回路径共用 |
| `src/reset.ts` | 重置推理级别（仅剔除 `reasoningEfforts`） |
| `src/restore.ts` | 启动备份捕获与恢复 |
| `src/guard.ts` | 事件流守卫：写回期间短路整条事件链 |
| `src/host.ts` | settings 写回必经的 `queueTask` 收口（HMR 事务感知） |
| `src/section.ts` | settings 节读取收口（读不到一律 `undefined`） |
| `src/writeback.ts` | 写回 `llm-pi-ai` 段的统一外壳（计划 → 写回 → 冲突限次重试） |
| `src/verify.ts` | 「验证模型」执行器（只读） |
| `src/probe.ts` | 「探测档位」执行器：兜底备份 → 预声明 → 逐档探测 → 收敛写回 |
| `src/fill.ts` | 探测档位的两次写回（预声明 / 收敛） |
| `src/probe-backup.ts` | 探测的崩溃兜底：备份与启动回退 |
| `src/probe-verdict.ts` | 验证与探测共用的判定层（失败分类、两级短路判据） |
| `src/probe-plan.ts` | 共用的计划层（入参校验、展开、分组、配额） |
| `src/probe-report.ts` | 共用的汇报层（逐组结论、全局统计） |
| `src/probe-engine.ts` | 共用执行引擎（单次请求受理判定、并发、进度帧） |
| `src/rpc.ts` | 三个写回端点 + 两条 SSE 进度流端点（channel 自注册） |
| `src/rpc-route.ts` | RPC 信封解码与路由分发 |
| `src/refresh.ts` | 目录保鲜刷新（窗口过期才拉取，失败限次重试） |
| `src/official-filter.ts` | 「隐藏官方API」：遮蔽 `listModels`，未配密钥返回空清单；宿主已自带时整层不装 |
| `src/host-version.ts` | 宿主版本判据（Node 半）：经 `pluginPackages` 读宿主版本 |
| `src/effort-name.ts` | 档位名本地化：遮蔽 `resolveModelInfo`，按开关 + 界面语言换显示名 |
| `src/subagent.ts` | 「跟随父智能体」：`agent/request` 瀑布最外层改写路由 |
| `src/self-tune.ts` | 「自主调节档位」：装/卸两枚工具与一段系统提示词 |
| `src/types.ts` | 当前版本配置形态与冻结的旧版类型 |
| `src/constants.ts` | Node 半常量 |

### 跨半共享层（`src/shared/`）

零 Node 依赖、零 schemastery、零非基线 `@deepseek-ai/*` 值导入；两半统一经 `@/shared/*` 直连本层。

| 路径 | 职责 |
| --- | --- |
| `src/shared/constants.ts` | 命名空间、路由、码位、档位键集等跨半字面量 |
| `src/shared/errors.ts` | `errorText` 与 `isSettingsConflict`（两半写回重试共用） |
| `src/shared/config-schema.ts` | 当前版本 schema、默认值、键清单、解析与存储物化 |
| `src/shared/types.ts` | 跨半类型声明与纯类型守卫（含各规则组行键表） |
| `src/shared/version.ts` | 宿主版本比较与「宿主是否已自带隐藏」判据 |
| `src/shared/verify-progress.ts` | 探测/验证的进度帧契约与逐字段解码 |

### 浏览器半（`src/client/`）

| 路径 | 职责 |
| --- | --- |
| `src/client/index.tsx` | 入口：席位注册、卡片、词典、调用面接线、scope 释放，全挂 `configForms` 子 fiber |
| `src/client/card.tsx` | 四处席位 + 两处弹层共用的可折叠卡片外壳（草稿与保存、写回动作、瓦片与弹层挂接） |
| `src/client/tile.tsx` | 瓦片层：布尔矩阵组 / 动态排除集合两种形态 |
| `src/client/card-meta.tsx` | 卡片联系行（仓库 / 版本 / 反馈） |
| `src/client/card-styles.ts` | 卡片样式层：全部样式数值的唯一出处 |
| `src/client/confirm.tsx` | 四层二次确认的共用外壳 |
| `src/client/diagnose-dialog.tsx` | 验证 / 探测弹层的共用外壳（双选项卡 + 记录区） |
| `src/client/probe-dialog.tsx` | 探测弹层组装层 |
| `src/client/card-verify.ts` | 验证的整轮编排 hook |
| `src/client/card-probe.ts` | 探测的整轮编排 hook |
| `src/client/card-records.ts` | 两条诊断记录区的纯文案层 |
| `src/client/card-notice.ts` | 卡片状态行助手 |
| `src/client/composer.tsx` | 输入框工具行的「模型优化」入口与「跟随」状态灯 |
| `src/client/model.ts` | 快照↔配置纯映射（候选拍取、收敛目标、未填充判据） |
| `src/client/effort.ts` | 记忆纯逻辑（查表、写后形态、档位公告判定） |
| `src/client/scope.ts` | ConfigForm 的 decode 与写回转发包装 |
| `src/client/memory-listener.ts` | 记忆存取监听（换模型恢复、换级别写回 + 自动设置） |
| `src/client/rpc-carrier.ts` | 浏览器半调 Node 半的唯一出口 |
| `src/client/effort-name.ts` | 浏览器界面语言上报（补 Node 侧探测盲区） |
| `src/client/host-version.ts` | 宿主版本判据（浏览器半）：读 `__DSH_BOOT__.release.version` |
| `src/client/locale-patch.ts` | 宿主 model NS 词典的 Default 词条本地化 |
| `src/client/locale-keys.ts` | 卡片文案键契约（键并入宿主 `LocaleNamespaceMap`） |
| `src/client/locale-zh.ts` `src/client/locale-en.ts` | 卡片词典（中 / 英） |
| `src/client/visibility.tsx` | 「UI 与行为」组：三个 slot 上四个部件的挂载 / 卸载 |
| `src/client/floating-buttons.tsx` | 悬浮按钮组容器：中心列左侧直插 DOM + 独立 React 根；管定位 / 布局 / 渲染，导出 `addButton` |
| `src/client/floating-button.ts` | 悬浮按钮的响应式数据契约与工厂（React 外部存储形态） |
| `src/client/back-to-chat.tsx` | 「返回对话」按钮条目：自持 layout 依赖与配置 / 语言订阅，出响应式数据交容器渲染 |
| `src/client/float-card.tsx` | 悬浮按钮组里的卡片入口条目：图标取插件图标，点击打开与「模型优化」chip 同一张配置卡 |
| `src/client/card-panel.tsx` | 配置卡弹层面板：输入框 chip 与悬浮按钮共用（宿主 Modal 的 headless 形态） |
| `src/client/classic-setting.tsx` | 「经典设置」入口：以 `priority: -1` 遮蔽 `settings.launcher` 上的账号入口，渲染 1:1 复刻宿主 `dsh-v0.2.0-rc.2` 外壳回退按钮的触发器 |

### 构建与静态资源

| 路径 | 职责 |
| --- | --- |
| `tsconfig.json` | TS 编译与 `paths` 别名 |
| `tsdown.config.ts` | 双配置构建（Node 半 + 浏览器半）+ `alias` / `define` / banner-intro-footer |
| `tsdown.test.config.ts` | 测试专用单对象配置 |
| `eslint.config.ts` | ESLint 扁平配置（含跨半纯度四条自定义规则） |
| `scripts/build-externals.mjs` | 两半外置宿主包清单（tsdown 与 eslint 共用的单一来源）：`NODE_EXTERNALS` / `CLIENT_EXTERNALS` |
| `scripts/build-cache.mjs` | 重建随包缓存：拉 models.dev 全量数据并跑运行期同一个构建器（jiti 直跑 TS，逻辑不复制） |
| `scripts/check-version.mjs` | pre-commit 钩子：README 钉死的 tarball 链接须与 `package.json` 的 version 同号 |
| `scripts/check-tag.mjs` | pre-push 钩子：一次只许推一个标签，且须为 v + 语义化版本并与 version 同号 |
| `public/models-cache.json` | 构建期复制进 `lib/` 的目录缓存（首启离线可用；`pnpm build:cache` 重建） |
| `public/icon.svg` | 插件图标：随构建复制进 `lib/`，浏览器半另由构建期内联同一份标记 |
| `cordis.patch.yml` | 包根静态资源，不经 tsdown；补丁行 `id` 即 settings 命名空间键 |
| `locale/*.json` | 包根静态资源，不经 tsdown |

## 数据流

- **段变更按 ns 分流**：自有段「自愈 → 填充 → 记忆清理」，`llm-pi-ai` 段「填充 → 保鲜刷新 → 记忆清理」，入口先判事件流守卫。
- **记忆三条链**：浏览器半 `memory-listener` 管存取；Node 半 `memory.ts` 按宿主全量模型列表做失效清理；两条诊断链路（验证只读 / 探测写回）共用 probe 四层，进度走 SSE。
- **请求期链**：`agent/request` 瀑布判定「跟随父智能体」；`self-tune` 按开关装/卸注入面。两者均不写配置。
- **只读遮蔽支线**：`official-filter` 遮 `listModels`、`effort-name` 遮 `resolveModelInfo`，判定逐次现算，不挂事件。
- **启动链**（`runStartupChain`）：迁移 → 读缓存 → 填充 → 探测兜底回退 → 保鲜刷新 → 记忆清理；备份捕获在这一切之前。

## 跨半边界

- Node 半禁 `@/client` 值导入；浏览器半禁 `@/`（`@/shared/*`、`@/client/*` 除外）与基线外 `@deepseek-ai/*` 的值导入，基线见 `eslint.config.ts` 的 `BROWSER_HOST_BASELINE`。
- `src/shared/` 只被两半 import，禁反向 import 两半。
- 浏览器半调 Node 半的唯一出口是 `src/client/rpc-carrier.ts`。
- `import type` 不计入纯度判定（由 `verbatimModuleSyntax` + `consistent-type-imports` 保证）。

## 导入与别名

- 源码导入只用 `@/`（→`src/`）与 `@test/`（→`test/`），禁相对路径。
- 别名须**同时**声明在 tsconfig `paths` 与各 tsdown 配置 `alias`（tsdown 不读 paths），键锚定 `@` 以免吞 `@deepseek-ai/*`。

## 构建与打包

- tsdown 双配置产物为 Node 半 `lib/index.js` 与浏览器半 `lib/client.js`。
- 宿主模块排除表单一来源 `scripts/build-externals.mjs`（tsdown 与 eslint 共用），按半各一份、只列该半运行期**实际值导入**的宿主包；浏览器半基座以宿主 `PLATFORM_MODULES`（冻结表）为准，漂移即运行期 require 未命中。
- 客户端半产物须具名导出 `{ name?, inject?, Config?, apply }`，`apply` 必需；**禁 default export**（宿主 `unwrapExports` 的 `exports.default ?? exports` 会吃掉 `inject`）。
- 浏览器半运行期宿主依赖只有 `react`、`react/jsx-runtime`、`react-dom/client` 与 `@deepseek-ai/dsh-client-ui-primitives`（其余宿主导入构建期擦除）。
- 宿主类型面一律 type-only 导入 devDep（构建期擦除），导入清单与理由见 `host/imports.md`。
- 代码合规归 lint，编译配置只管编译；跨半纯度由 `eslint.config.ts` 的四条自定义规则判定。
- 产物不带 sourcemap；`__PLUGIN_VERSION__` 由 tsdown `define` 内联 `package.json` version。

## 对外依赖

- `@deepseek-ai/cordis` / `schemastery` 取宿主本体声明的线，`peerDependencies` 记同版下限。
- 官方包一律 optional peer + devDep 同版兜底；`dependencies` 保持为空。
- 两处 `engines.dsh` 同值、range 一律 `>=`。
- **不写 `@deepseek-ai/dsh` peer**（pnpm 默认 `autoInstallPeers: true`，缺失 peer 会被真装并拖入整棵 CLI 树）；加 peer 后须手工把 `>=` 改回下限（pnpm 会把它归一成成品版本号）。

## settings 键位

- 命名空间键 = `cordis.patch.yml` 的 `id` = `src/shared/constants.ts` 的 `PLUGIN_NS`，两半写回共用同一字面量。
- `API_NS`（宿主自带段 `llm-pi-ai`）的读写位序与字面量由 `host/literals.md` 登记。
