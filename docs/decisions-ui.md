# 裁决：UI 侧（卡片、悬浮按钮与宿主融合）

UI 数值的唯一出处是 `src/client/card-styles.ts`；宿主契约见 `docs/host/client.md`。

## 卡片与编排

- **RPC channel 在已注入 webServer 的子 fiber 上自注册**（详见 `host/transport.md`）。
- **卡片按钮取「保存」不取「应用」**：写 settings 即前端职责终点。瓦片默认收起、同时只展开一个；「取消」键仅未保存时渲染。
- **输入框弹层直接嵌卡片**：面板高度内容撑开、640px 封顶；该席禁折叠。
- **开关必须落到「注册 / 撤销注册」**：宿主 tab 头按注册账本画，组件返回 `null` 只空内容。注册动作必须写在 `inject` 回调里。
- **`behavior` 组管 UI 装卸不是插件行为**：开关只决定部件在不在，功能本体照常运行。缺省方向与其它组相反（缺字段落**可见**）；显式 `false` 才卸载。
- **工具栏两枚 chip 各占一个席位条目**：宿主 list 席位按 `id` 记账。
- **chip 字色三档语义**：模型优化恒 `label-secondary`；跟随未生效降 `label-caption`；生效 success 绿、失败 warn 琥珀，另加 6px 状态点。
- **「插件管理」唯一不可关闭、故不落配置**：`lockedRows` 恒开展示行，不绑键、不进脏检测。它们计入 Pill 阈值并排在真键之前。
- **瓦片总控按 `every` 显示**：总开关本身无存储，只是批量操作。
- **不引入 `failed` 态、不做「恢复默认」**：五组布尔恒合法、原子写，失败时 `dirty` 已传达。
- **Tooltip 方向一律 `side="top"`**。

## 隐藏官方 API

- **拦 `listModels`、不改官方 provider 配置**：宿主目录生成链路滤空组，遮 `listModels` 即生效。
- **名单只放 `deepseek-official`**：`deepseek-account` 段无 `apiKeyEnv`，判定会回退同名常量误隐藏可用账号组。
- **不挂任何事件、判定逐次现算**：遮蔽处是全部消费者共用，缓存会让「刚翻转开关 / 刚配密钥」与旧结论不一致。
- **卸载只清状态位，不 `delete` 属性、不写回原函数**：遮蔽是链式的，动属性会抹掉别人的遮蔽。
- **宿主自 `0.2.1-alpha.2` 起自带同一行为 ⇒ 本层不装**：宿主 `discoverModels` 在 `MISSING_CREDENTIAL` 时返回空清单，目录滤空组即消失。判据 `hostHidesOfficialSince`；**版本未知按不空转处理**。
- **空转期 Pill 追加「DSH 已自带」尾注**：只改释义文案，开关语义与可见性不变。

## 本地化推理级别

- **换在 Node 半 `resolveModelInfo` 层**（唯一出口见 `host/llm.md`）。已知取舍：开关开时 AI 看到的档位名也是中文。
- **语言判定三路**：`locale.preference` → 浏览器上报 → `en`。
- **词表键取宿主显示名形式（id 首字母大写）**：非全小写档位宿主显示原样；`Default` 是宿主自合成伪菜单项，与七档同表维护。
- **「显示原档位名」追加 ` · 原名`**：Default 伪菜单项走浏览器半词典 patch，与 Node 半共用同一分隔符常量。

## 悬浮按钮组

- **直插 DOM 不走宿主 slot**：所要贴的容器无席位可挂；中心列是宿主 React 树的一部分，宿主重挂即换节点 ⇒ `MutationObserver` 盯着重新挂载。
- **按钮本体是独立 React 根**：图标是宿主 React 组件导出，渲染必须有根。
- **容器不持宿主依赖，条目各自自治**：容器只管定位、布局与渲染；谁订阅谁退订。
- **按钮数据是响应式的**：条目交出可改写的 `{ id, icon, title, active, onClick }`，容器用 `useSyncExternalStore` 读（快照引用稳定是 uSES 硬要求）。
- **卡片入口条目自带弹层**：条目自持独立 React 根 ⇒ 容器的按钮数据契约不扩面板字段。
- **`ctx.layout` 经子 fiber `inject` 门控**：可见性 = 配置开关 ∧ 服务到位。

## 返回对话按钮

- **锚主视图会话**：子智能体视图下锚点取**直接父**（只看一层 ⇒ 嵌套时逐级上退），状态与标题都按锚点取。非空闲时显示宿主 `StateDot`，空闲回退「左」箭头；hover 临时换左箭头。
- **点击行为分三支**：子智能体视图走 `ctx.uiWorkspace.openSession(父)`；主视图 + 根智能体 + 不在对话页签时切页签（宿主 `actions.setView` 插件侧不可达）；其余 `selectPanel(null)`。`uiWorkspace` 缺席时退化为 `selectPanel(null)`。

## 经典设置

- **靠 priority 遮蔽 `settings.launcher`**（规则见 `host/client.md`）：账号条目仍留账本，注销后自动复位 ⇒ 天然是「开关」语义。
- **遮蔽只在账本里另有占位者时才做**：宿主没挂账号包时注册只会把宿主自己的回退按钮换成复刻版；故按 `registrant` 判「有没有别人」。注册先后不可控 ⇒ 订阅账本变更、一变即重判。
- **按钮 1:1 复刻 `dsh-v0.2.0-rc.2` 外壳的回退触发器**（该版 web-profile 未挂载账号包，显示的就是它）。
