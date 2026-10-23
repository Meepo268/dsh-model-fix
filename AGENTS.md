# dsh-model-fix

## 项目简介

DSH 插件：按 [models.dev](https://models.dev) 为非官方（自定义）提供方的模型补全并同步推理级别与模型参数、维护路由 compat，管理会话侧的推理级别记忆，并在宿主设置页提供对应卡片。功能与用法见 [`README.md`](README.md)。

## 技术栈与目录骨架

Node.js（ESM）+ `@deepseek-ai/cordis`；tsdown 双配置构建到 `lib/`（Node 半 + 浏览器半）；TS 严格模式，产物不带 sourcemap；ESLint 10 扁平配置。

- `src/`：Node 半，入口 `src/index.ts`（导出 `Config` + 单一 `apply` 编排体）。
- `src/client/`：浏览器半（席位注册、卡片、词典），调 Node 半的唯一出口是 `src/client/rpc-carrier.ts`。
- `src/shared/`：跨半共享层，零 Node 依赖，禁反向 import Node 半。
- `test/`：纯函数与零 ctx 编排的测试（范围见 `workflow.md`「测试规范」）。

逐文件职责、数据流与跨半边界纪律见 [`docs/architecture.md`](docs/architecture.md)。

## 专题文档

下表是**唯一索引**：职责、判据与何时改全在这一张表，细则与理由一律在权威文档，本文件不重复正文。改动落在哪一行，就只更新那一份文档。

| 文档 | 职责 | 硬约束速查 | 何时读 / 何时改 |
| --- | --- | --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | 目录职责、数据流、跨半边界与导入打包纪律 | 跨半纯度：Node 半禁 `@/client` 值导入，浏览器半值导入只放行白名单与基线；导入别名：只用 `@/` 与 `@test/`，须同时声明在 tsconfig `paths` 与各 tsdown `alias`；宿主模块外置：单一来源 `scripts/build-externals.mjs`，按半各一份；对外依赖：官方包 optional peer + devDep 同版兜底，`dependencies` 保持为空 | 动目录/文件划分、导入关系、构建配置前读；上述内容变更时改 |
| [`docs/host-api.md`](docs/host-api.md) | 宿主契约：各面的实际用法与宿主源码引用、类型导入清单、字面量键码、漂移观察项 | 对宿主的一切依赖（服务调用与事件订阅、类型导入面、字面量键/码/路由/slot 名、运行时行为假设、版本基线与平台模块表）一律登记在此；NS 键 = `cordis.patch.yml` 的 `id` = `PLUGIN_NS`，两半共用；`dsh.client.inject` 是依赖包图边不是 cordis 服务名，缺 `lib/client.js` 会让宿主激活期聚合抛错 ⇒ build 必须先于安装 | 碰任何宿主服务/事件/类型/字面量前读；落在其登记范围内时同轮改，升宿主大版本另过一遍「升级宿主时的检查清单」 |
| [`docs/decisions.md`](docs/decisions.md) | 设计裁决：代码里看不出动机的前提与理由 | 改动任一功能模块前先读对应主题组 | 出现新取舍或推翻旧取舍时改 |
| [`docs/ui-fusion.md`](docs/ui-fusion.md) | UI 无痕融合纪律：复刻范围、同款来源与例外 | 官方用导出组件就用同一组件；官方自绘且无同款导出原语就在本地逐字复刻其源码——数值零自造 | 改卡片/瓦片/悬浮按钮/弹层等任何 UI 前读；新增复刻条目或发现例外时改 |
| [`docs/versioning.md`](docs/versioning.md) | 配置版本形态：递增判据、冻结类型与台阶链 | 只在真不兼容时递增 `CONFIG_VERSION`；组内新增键与新增顶级组两端都退得动，都不升版本 | 动 `CONFIG_VERSION` / 快照结构 / `src/upgrade.ts` 前读；上述变更时改 |
| [`docs/workflow.md`](docs/workflow.md) | 命令、工具链陷阱、Git 钩子与测试规范 | 只认 `pnpm` 已定义脚本、不得裸跑 bin，且必须直接在 shell 里执行、不得经 Node 子进程包裹 pnpm；提交前必跑 `pnpm all` | 跑验证、加脚本、加测试前读；命令或陷阱变化时改 |

`docs/` 下这些文件都不是构建产物，一律不进 `files`。

## 设计裁决索引

| 主题 | 条目 |
| --- | --- |
| 配置解析、填充与空壳字段 | [解析与填充](docs/decisions.md#解析与填充) |
| `excludes` 排除与动态列表 | [排除与列表](docs/decisions.md#排除与列表) |
| 模型参数来源与 id 匹配 | [参数来源](docs/decisions.md#参数来源) |
| 推理级别记忆的存取与剪枝 | [推理级别记忆](docs/decisions.md#推理级别记忆) |
| 子智能体推理级别 | [子智能体](docs/decisions.md#子智能体) |
| 档位自调 | [档位自调](docs/decisions.md#档位自调) |
| 重置 / 恢复的写回端点 | [写回端点](docs/decisions.md#写回端点) |
| 验证模型 | [验证](docs/decisions.md#验证) |
| 探测档位 | [探测档位](docs/decisions.md#探测档位) |
| 宿主接线与卡片行为 | [宿主与卡片](docs/decisions.md#宿主与卡片) |

## 文档纪律

- **单向引用**：引用只允许自顶向下，构成有向无环图：
  - `AGENTS.md` → `README.md` 与全部 `docs/` 专题文档（唯一索引，唯一可同时点名多份文档的文件）。
  - `README.md` 不出链（面向用户，自含）。
  - `docs/host-api.md`、`docs/versioning.md` 不出链到其它 `docs/`（自含的权威层）。
  - `docs/architecture.md` 只可引 `docs/host-api.md`。
  - `docs/decisions.md`、`docs/ui-fusion.md` 只可引 `docs/host-api.md`。
  - `docs/workflow.md` 只可引 `docs/architecture.md` 与 `docs/host-api.md`。
  - **禁止反向引用**（专题文档引 `AGENTS.md`）与**双向引用**（两份专题文档互引）。
- **单一权威**：同一事实只在一处登记，别处只放指针或一句结论。
- 内容不清晰时停止操作，列疑问点并给选项式提问，不靠猜补齐。
