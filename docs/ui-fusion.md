# UI 无痕融合纪律

总纲：**官方用导出组件就用同一组件；官方自绘且无同款导出原语（或不导出）就在本地逐字复刻其源码——数值零自造**，只有数据、文本与业务逻辑属于我们。运行时值导入宿主原语的理由与风险面（#130）见 [`host-api.md`](host-api.md)「宿主类型导入清单」。

- 颜色只用宿主 `--dsw-alias-*` 令牌；字面量兜底取舍见 `card-styles.ts` 文件头注释。
- 取值基准是「同一类组件」而非「同一页面」：外层卡照「内置插件」的插件卡，内层瓦片照「插件列表」的插件行卡。具体数值一律以 `card-styles.ts` 的 `STYLE_TEXT` 为准。
- 瓦片 summary 行要同时容纳整组开关与整行可点：透明空 `<button>` 绝对覆盖整行 + `aria-labelledby`；**禁止把 `role="switch"` 嵌进 `<button>`**（非法 HTML）。
- 瓦片文案过长一律换行（`overflow-wrap:anywhere`），不照官方截断（官方 `nowrap + ellipsis` 在两列栅格窄列会把组名与行标签砍半——用户裁定）。
- 释义走宿主 `Tooltip`，锚点复刻官方 settings-form `.helpButton`；必须 `portal`（瓦片 `overflow:hidden` + 阴影层叠会裁掉气泡）并用 `maxWidth` 收窄（否则盖住同行开关）。
- 有限取值不用原生 `<select>`：宿主「语言」行就是 `ui-primitives` 的 `Menu` 包按钮锚点，将来枚举型设置项按总纲直接用同一组件；锚点样式照官方 `.selector`。瓦片形状按语义选：布尔矩阵有组总控开关、动态集合用输入框，一张瓦片只有一种形状，不为「某些行当下不生效」另立置灰态（生效条件写进说明气泡；恒定不可改的展示行除外——它恒在同一形状内，置灰取宿主 `.switch:disabled` 同值，见 [decisions.md](decisions.md)「宿主与卡片」）。
- 宿主 Modal 的初始焦点控件标 `data-modal-autofocus`，不用 React `autoFocus`（模态层先存触发控件再移焦点，`autoFocus` 抢在前面会毁掉关闭后的回焦）。
- 卡片外壳不写 `max-width`（宽度由所在 section 约束，官方同样不写）。
- UI 称谓跟随官方：provider-id 叫「提供方 / Provider ID」，功能名「排除提供方」（en: Excluded providers）。「取消」全卡片只留一个 `cancel` 键；`close` 只作宿主 Modal × 的 `closeLabel`；确认键保持动作化。状态文案句号收尾的口径见 [decisions.md](decisions.md)「宿主与卡片」。
- 悬浮按钮组（`src/client/floating-buttons.tsx`）：唯一不走宿主 slot 的 UI —— 它要贴在**宿主 React 树之外的容器**（AppFrame 中心列）的角落，无席位可挂，故直插 DOM + 独立 React 根（宿主图标是 React 组件，渲染需根）；元素 id/class 一律以 `tikaflow-model-fix` 起头。定位上下文是宿主中心列，逐字照宿主 `ui-chat` 的 `.toBottom`；层级 `z-index: 999`（低于宿主 Modal 的 1000）。列表纵向向上排、按钮间距 8px。按钮提示走宿主 `Tooltip`（`side="right"`、`portal`、宽度上限复用 `card-styles.ts` 的 `TIP_MAX_WIDTH`），不用原生 `title`。卡片入口图标是插件图标（`public/icon.svg`，构建期内联；渐变填充改 `currentColor`）；「返回对话」按钮在会话非空闲时改用宿主 `StateDot` 原语。
- 「返回对话」按钮（`src/client/back-to-chat.ts`）：组内条目，图标用宿主导出的 `IconChevronLeftOutlineRegular`（总纲：官方有导出组件就用同一组件）。
- 「经典设置」按钮（`src/client/classic-setting.tsx`）：1:1 复刻宿主 `dsh-v0.2.0-rc.2` 外壳的回退触发器——结构照该版 `SettingsRoot.tsx` 的 fallback，数值照该版 `SettingsRoot.module.css` 与 `chrome.module.css`，图标与文案照该版 `chrome.tsx`（`IconSettingsOutlineMedium` + 「设置」）。现行宿主的回退按钮与该版同形。色值只用 `--dsw-alias-*` 令牌，字面量仅作浅色守卫。
