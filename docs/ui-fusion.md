# UI 无痕融合纪律

总纲：**官方用导出组件就用同一组件；官方自绘且无同款导出原语就在本地逐字复刻其源码——数值零自造**，只有数据、文本与业务逻辑属于我们。

## 色值与取值基准

- 颜色只用宿主 `--dsw-alias-*` 令牌；具体数值一律以 `src/client/card-styles.ts` 的 `STYLE_TEXT` 为准。
- 取值基准是「同一类组件」而非「同一页面」：外层卡照「内置插件」的插件卡，内层瓦片照「插件列表」的插件行卡。
- 官方源码引用但主题未定义的令牌（`label-error`、`bg-layer-4`）禁止照抄。

## 卡片与瓦片

- 瓦片 summary 行要同时容纳整组开关与整行可点：透明空 `<button>` 绝对覆盖整行 + `aria-labelledby`；**禁止把 `role="switch"` 嵌进 `<button>`**（非法 HTML）。
- 瓦片文案过长一律换行（`overflow-wrap:anywhere`），不照官方截断（官方 `nowrap + ellipsis` 会把两列窄栅格里的组名与行标签砍半）。
- 瓦片形状按语义选：布尔矩阵有组总控开关、动态集合用输入框。一张瓦片只有一种形状，不为「某些行当下不生效」另立置灰态（生效条件写进说明气泡）；恒定不可改的展示行除外，置灰取宿主 `.switch:disabled` 同值。
- 说明气泡走宿主 `Tooltip`，锚点复刻官方 settings-form `.helpButton`；必须 `portal`（瓦片 `overflow:hidden` + 阴影层叠会裁掉气泡）并用 `maxWidth` 收窄。
- 有限取值不用原生 `<select>`：宿主「语言」行就是 `ui-primitives` 的 `Menu` 包按钮锚点，锚点样式照官方 `.selector`。

## 弹层与焦点

- 宿主 Modal 的初始焦点控件标 `data-modal-autofocus`，不用 React `autoFocus`（模态层先存触发控件再移焦点，`autoFocus` 抢在前面会毁掉关闭后的回焦）。
- 输入框弹层用宿主 Modal 的 headless 形态：卡片直接作 children，宿主标题栏 / 关闭钮 / content / body 一律不渲染。

## 文案与称谓

- UI 称谓跟随官方：provider-id 叫「提供方 / Provider ID」，功能名「排除提供方」（en: Excluded providers）。
- 「取消」全卡片只留一个 `cancel` 键；`close` 只作宿主 Modal × 的 `closeLabel`；确认键保持动作化。
- 对外报告状态的文案一律句号收尾；例外两类：加载省略号、诊断记录区逐条结果。

## 悬浮按钮组

`src/client/floating-buttons.tsx` 是唯一不走宿主 slot 的 UI（AppFrame 中心列的角落无席位可挂），故直插 DOM + 独立 React 根。

- 元素 id / class 一律以 `tikaflow-model-fix` 起头。
- 定位上下文是宿主中心列，逐字照宿主 `ui-chat` 的 `.toBottom`；层级 `z-index: 999`（低于宿主 Modal 的 1000）。
- 列表纵向向上排、按钮间距 8px。
- 按钮提示走宿主 `Tooltip`（`side="right"`、`portal`、宽度上限复用 `TIP_MAX_WIDTH`），不用原生 `title`。
- 卡片入口图标是插件图标（`public/icon.svg`，构建期内联；渐变填充改 `currentColor`）。
- 「返回对话」按钮在会话非空闲时改用宿主 `StateDot` 原语；图标用宿主导出的 `IconChevronLeftOutlineRegular`。

## 经典设置

`src/client/classic-setting.tsx` 是 1:1 复刻宿主 `dsh-v0.2.0-rc.2` 外壳的回退触发器：

- 结构照该版 `SettingsRoot.tsx` 的 fallback，数值照该版 `SettingsRoot.module.css` 与 `chrome.module.css`。
- 图标与文案照该版 `chrome.tsx`（`IconSettingsOutlineMedium` + 「设置」）。
- 色值只用 `--dsw-alias-*` 令牌，字面量仅作浅色守卫。
