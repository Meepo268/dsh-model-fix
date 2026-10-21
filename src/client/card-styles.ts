import { PLUGIN_NAME } from '@/shared/constants'

/** 卡片样式层：内嵌样式表 + 幂等注入 + 两处展示数值；色值只用 --dsw-alias-* 令牌，字面量仅作令牌缺失时的浅色守卫。 */

/** 说明气泡宽度上限（px），按瓦片列宽收窄以免宿主 Tooltip 的半视口默认值盖住开关区 */
export const TIP_MAX_WIDTH = 300

const STYLE_ID = 'dsh-model-fix-card-css'

/** 内嵌样式表（dsh-mf- 前缀防撞）。取值逐条照官方同类组件：外层卡＝宿主「设置 → 插件 → 内置插件」的插件卡，内层瓦片＝「插件列表」的插件行卡；基准取旧版宿主管感，仅瓦片底色与折叠钮焦点环两处例外照现行值，逐条出处见 docs/ui-fusion.md。官方源码引用但主题未定义的令牌（label-error、bg-layer-4）禁止照抄 */
const STYLE_TEXT = [
    // 外壳逐字照官方插件卡 .card（不写 max-width，宽度由所在 section 约束，官方同样不写）
    '.dsh-mf-card{list-style:none;border:0.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:16px;background:var(--dsw-alias-bg-layer-3,#fff);transition:border-color .16s, background .16s}',
    '.dsh-mf-card:hover{border-color:var(--dsw-alias-label-dimmed,#e1e5ee)}',
    '.dsh-mf-cardOpen{border-color:var(--dsw-alias-label-dimmed,#e1e5ee);background:var(--dsw-alias-bg-layer-2,#fff)}',
    // header：左侧名称叠描述，右侧未保存胶囊与旋转 chevron
    '.dsh-mf-header{display:flex;align-items:center;gap:12px;box-sizing:border-box;width:100%;padding:14px 16px;border:1px solid transparent;border-radius:12px;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}',
    // 配置服务不可用时的静态头（div 渲染，无展开语义）
    '.dsh-mf-headerStatic{cursor:default}',
    '.dsh-mf-headText{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
    '.dsh-mf-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,#0f1115)}',
    '.dsh-mf-desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#81858c)}',
    '.dsh-mf-chevron{flex:none;color:var(--dsw-alias-label-tertiary,#81858c);transition:transform .16s}',
    '.dsh-mf-chevronOpen{transform:rotate(180deg)}',
    // 展开体：顶部 0.5px 分隔线隔开摘要与正文，12px 上边距撑开与瓦片的距离
    '.dsh-mf-body{margin:0 16px;padding:12px 0 8px;border-top:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));display:flex;flex-direction:column;gap:12px}',
    // 状态行
    '.dsh-mf-notice{margin:0;padding:0 16px 12px;font-size:12px;line-height:18px}',
    '.dsh-mf-noticeSuccess{color:var(--dsw-alias-state-success-primary,#22c55e)}',
    '.dsh-mf-noticeError{color:var(--dsw-alias-state-error-primary,#ec1313)}',
    '.dsh-mf-line{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c)}',
    '.dsh-mf-warn{color:var(--dsw-alias-state-warn-label,#dd8629)}',
    // 配置组瓦片逐条照官方「插件列表」项卡（ui-settings-plugin-inventory）；描边走官方 elevation 令牌链，字面兜底复刻其计算结果
    '.dsh-mf-items{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:10px}',
    '.dsh-mf-item{min-width:0;overflow:hidden;border:0;border-radius:14px;background:var(--dsw-alias-settings-card-fill,#fff);box-shadow:var(--dsw-elevation-stroke,0 0 0 0.5px var(--dsw-alias-border-l4,rgba(0,0,0,.16)))}',
    // 展开态（官方 data-open 驱动）：描边换 l1 并叠两层柔光
    '.dsh-mf-item[data-open="true"]{--dsw-elevation-stroke-color:var(--dsw-alias-border-l1,rgba(0,0,0,.04));box-shadow:var(--dsw-elevation-panel,0 0 0 0.5px var(--dsw-alias-border-l1,rgba(0,0,0,.04)),0 3px 8px 0 rgba(0,0,0,.03),0 0 16px 0 rgba(0,0,0,.02))}',
    '.dsh-mf-item[data-open="true"]>.dsh-mf-itemHead{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
    '.dsh-mf-itemHead{box-sizing:border-box;position:relative;display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:52px;padding:12px 14px;color:var(--dsw-alias-label-primary,#0f1115)}',
    '.dsh-mf-itemHead:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
    // 整行折叠按钮：透明覆盖层承担点击与键盘，尾区关掉 pointer-events 只放开开关本体（无 button 嵌套）
    '.dsh-mf-itemToggle{position:absolute;inset:0;padding:0;border:none;border-radius:14px;background:none;cursor:pointer}',
    // 整行折叠钮照官方 .cardContent:focus-visible 补环；offset -2px 画行内缘，不被瓦片 overflow:hidden 裁剪
    '.dsh-mf-itemToggle:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,rgb(65,118,230)));outline-offset:-2px}',
    // 标题偏离官方省略号截断（用户裁定）：两列窄栅格里 nowrap+ellipsis 会砍掉组名，改为 overflow-wrap:anywhere 换行
    '.dsh-mf-itemTitle{min-width:0;overflow-wrap:anywhere;font-size:14px;line-height:20px;font-weight:600}',
    '.dsh-mf-itemTrailing{position:relative;z-index:1;display:inline-flex;flex:none;align-items:center;gap:7px;pointer-events:none;color:var(--dsw-alias-label-tertiary,#81858c)}',
    '.dsh-mf-itemSwitch{pointer-events:auto}',
    '.dsh-mf-itemChevron{flex:none;transition:transform 140ms var(--ds-ease-in-out,ease)}',
    '.dsh-mf-item[data-open="true"] .dsh-mf-itemChevron{transform:rotate(180deg)}',
    // 展开体填充官方 .cardDetails 的模块底色
    '.dsh-mf-itemBody{border-top:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));padding:10px 14px 12px;display:grid;gap:6px;background:var(--dsw-alias-bg-module-platform,#f5f6f7)}',
    '.dsh-mf-itemHint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#81858c)}',
    '.dsh-mf-itemRow{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#0f1115)}',
    // Pill 组容器：组内行数（真键 + 恒定展示行）≥ 5 时 Switch 行整体替换为胶囊矩阵（flex-wrap 自动换行，恒定展示行排最前）
    '.dsh-mf-pillGroup{display:flex;flex-wrap:wrap;gap:6px}',
    // 恒定展示 pill 的禁用线索：宿主 Pill 无 :disabled 样式，置灰值取宿主 Switch 的 .switch:disabled 同值
    '.dsh-mf-pillLocked{opacity:.5}',

    // 行内标签组照官方 settings-form .labelGroup；标签过长换行（裁定同瓦片标题）
    '.dsh-mf-itemLabelGroup{display:inline-flex;align-items:center;gap:4px;min-width:0}',
    '.dsh-mf-itemLabel{min-width:0;overflow-wrap:anywhere}',
    // 说明键度量照官方 .helpButton（24×24 无边框图标钮）；hover 底改取 interactive-bg-hover（官方 bg-layer-4 主题未定义）
    '.dsh-mf-help{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:none;color:var(--dsw-alias-label-tertiary,#81858c);cursor:pointer}',
    '.dsh-mf-help:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-secondary,#61666b)}',
    '.dsh-mf-help:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,rgb(65,118,230)));outline-offset:1px}',
    // 输入框照 ModelsSection 的 .input，删除钮照同页 .iconButton（hover 用 .iconButtonDanger 变体）
    '.dsh-mf-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:14px;line-height:22px}',
    '.dsh-mf-input:focus{border-color:var(--dsw-alias-state-business-primary,rgb(65,118,230));outline:none}',
    '.dsh-mf-input::placeholder{color:var(--dsw-alias-label-dimmed,#e1e5ee)}',
    '.dsh-mf-input:disabled{opacity:.6;cursor:default}',
    '.dsh-mf-fieldError{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#ec1313)}',
    // 一行一项：状态点在胶囊外（官方 trailing 同为兄弟节点），删除钮 margin-left:auto 贴右
    '.dsh-mf-tagRow{position:relative;display:flex;align-items:center;gap:7px;min-width:0}',
    // 宿主 .tag 是 nowrap 的 inline-flex，flex 项不收缩时长 id 会顶掉删除钮并被瓦片裁掉：给 min-width:0 可收缩、文字换行
    '.dsh-mf-tag{min-width:0}',
    '.dsh-mf-tagText{white-space:normal;overflow-wrap:anywhere}',
    '.dsh-mf-remove{box-sizing:border-box;flex:none;width:28px;height:28px;margin-left:auto;display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;border-radius:var(--dsw-radius-sm,8px);background:0 0;color:var(--dsw-alias-label-tertiary,#81858c);cursor:pointer}',
    '.dsh-mf-remove:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.05));color:var(--dsw-alias-state-error-primary,#ec1313)}',
    '.dsh-mf-remove:disabled{cursor:default;opacity:.4}',
    // 只给读屏器的状态文案（照同页 .hiddenLabel 的裁剪手法）
    '.dsh-mf-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    '@media (max-width:680px){.dsh-mf-items{grid-template-columns:minmax(0,1fr)}}',
    '@media (prefers-reduced-motion:reduce){.dsh-mf-itemChevron{transition:none}}',
    '.dsh-mf-bar{display:flex;align-items:center;justify-content:flex-start;gap:8px;padding:12px 0 0;border-top:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
    '.dsh-mf-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px}',
    '.dsh-mf-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    // footer 键度量照官方 SettingsForm .save；force 红字透明底照 .dangerButton 语义；discard 官方无同款，度量与 save 成对
    '.dsh-mf-discard,.dsh-mf-save,.dsh-mf-force{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md,12px);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}',
    '.dsh-mf-discard:focus-visible,.dsh-mf-save:focus-visible,.dsh-mf-force:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,rgb(65,118,230)));outline-offset:1px}',
    '.dsh-mf-discard{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:none;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.dsh-mf-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary,#0f1115);border-color:var(--dsw-alias-label-dimmed,#e1e5ee)}',
    '.dsh-mf-save{background:var(--dsw-alias-label-primary,#0f1115);color:var(--dsw-alias-bg-layer-3,#fff)}',
    '.dsh-mf-force{background:none;color:var(--dsw-alias-state-error-primary,#ec1313)}',
    '.dsh-mf-force:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.05))}',
    '.dsh-mf-discard:disabled,.dsh-mf-save:disabled,.dsh-mf-force:disabled{opacity:.4;cursor:default}',
    // 末尾项目链接行：border-top 即分割线，footer 下间距归零、让给本行 padding-top，两条分割线到最近内容距离相等
    '.dsh-mf-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 0 4px;border-top:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
    '.dsh-mf-metaLeft{display:inline-flex;align-items:center;gap:8px;min-width:0}',
    // 仓库地址与跳转键同为描边小片，一律 12px，不做主次层级
    '.dsh-mf-chip{display:inline-flex;align-items:center;gap:6px;min-width:0;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:8px;padding:3px 10px;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b);text-decoration:none;white-space:nowrap}',
    'a.dsh-mf-chip:hover{color:var(--dsw-alias-label-primary,#0f1115);border-color:var(--dsw-alias-label-dimmed,#e1e5ee)}',
    '.dsh-mf-chipAddress{overflow:hidden;text-overflow:ellipsis}',
    // 版本标记底色取 border-l3 的 50% 透明（等同开关 :disabled 压在卡片底的观感）；不能用 opacity 整体压，会连字一起变淡
    '.dsh-mf-chipVersion{background:color-mix(in srgb, var(--dsw-alias-border-l3,rgba(0,0,0,.12)) 50%, transparent)}',
    '.dsh-mf-linkIcon{flex:none;display:block;width:12px;height:12px;color:currentColor}',
    // 危险确认键照官方 .deleteConfirm
    '.dsh-mf-confirmDanger:not(:disabled){border-color:var(--dsw-alias-state-error-primary,#ec1313);color:var(--dsw-alias-state-error-primary,#ec1313)}',
    '.dsh-mf-confirmDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.05))}',
    // 验证弹层逐条照官方 models 页候选框（fetchDialog / candidate* 类）；宿主滚动条变量无浅色真值，按官方原样透传
    '.dsh-mf-verifyDialog{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);max-width:520px}',
    // 宿主 .body 无 gap 且 flex 内 margin 不折叠（紧挨两段 margin 直接相加），故正文各段 margin 归零、段距统一收在本容器 gap:12px 一处
    '.dsh-mf-verifyBody{display:flex;flex-direction:column;gap:12px}',
    // 选项卡条照官方插件视图选项卡（.tabs/.tab），下划线指示条压在分隔线上；面板只取官方 min-width:0（不取其 padding-top:2px，段距由 verifyBody 的 gap 给）
    '.dsh-mf-verifyTabs{border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));align-items:flex-end;gap:22px;margin-top:2px;display:flex}',
    '.dsh-mf-verifyTabsRow{display:flex;align-items:center}',
    // margin-left:auto 放在组上（放单个键上会把行间空白均分到键间）
    '.dsh-mf-verifyTools{display:flex;gap:8px;margin-left:auto}',
    '.dsh-mf-verifyTab{color:var(--dsw-alias-label-tertiary,#81858c);font:inherit;cursor:pointer;background:0 0;border:0;padding:7px 1px 9px;font-size:13px;line-height:20px;position:relative}',
    '.dsh-mf-verifyTab:hover,.dsh-mf-verifyTab[data-active="true"]{color:var(--dsw-alias-label-primary,#0f1115)}',
    '.dsh-mf-verifyTab[data-active="true"]:after,.dsh-mf-verifyTab:focus-visible:after{background:var(--dsw-alias-label-primary,#0f1115);content:"";border-radius:2px 2px 0 0;height:2px;position:absolute;bottom:-1px;left:0;right:0}',
    '.dsh-mf-verifyTab:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,rgb(65,118,230)));outline-offset:2px;color:var(--dsw-alias-label-primary,#0f1115);border-radius:2px}',
    '.dsh-mf-verifyPanel{min-width:0}',
    // 候选列表：项间距 0，行距靠官方 candidateLabel 的 6px 8px 内边距；官方 .candidateList 的 2px 紧凑档不取
    '.dsh-mf-verifyList{display:flex;flex-direction:column;max-height:240px;margin:0;padding:0;list-style:none;overflow-y:auto}',
    // 验证弹层比宿主默认 380px 宽一档（模型 id 带斜杠，窄框会折行与开关挤在一起）；本插件 <style> 后于宿主样式表注入，同优先级下覆盖宿主 .dialog 的 width
    '.dsh-mf-verifyDialog{width:min(560px,100%)}',
    // 提供方分组头（官方候选框无分组，此处自加一行标题标明归属）：排布照官方 candidateToolbar，纵向内边距与候选行同档
    '.dsh-mf-verifyGroup{display:flex;align-items:center;gap:8px;padding:6px 8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,#81858c)}',
    '.dsh-mf-verifyGroupAll{margin-left:auto}',
    '.dsh-mf-verifyRow{border-radius:var(--dsw-radius-md,12px)}',
    '.dsh-mf-verifyLabel{display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer}',
    '.dsh-mf-verifyId{flex:auto;min-width:0;overflow:hidden;font-family:var(--ds-font-family-code);font-size:13px;text-overflow:ellipsis;white-space:nowrap}',
    // 空态 margin 归零（气口由容器 gap 给）
    '.dsh-mf-verifyEmpty{margin:0;color:var(--dsw-alias-label-secondary,#61666b);text-align:center;font-size:13px;line-height:20px}',
    '.dsh-mf-verifyQuota{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label,#dd8629)}',
    '.dsh-mf-verifyOption{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.dsh-mf-verifyOptions{display:flex;align-items:center;gap:12px;min-width:0;margin:0}',
    '.dsh-mf-verifyButtons{display:flex;align-items:center;gap:8px}',
    // 记录区 margin 归零：宿主 TerminalBlock .block 自带 margin:16px 0，会与容器 gap 相加
    '.dsh-mf-verifyLog{margin:0;--dsl-terminal-output-max-height:360px}',
    // warn 语义键：卡片 footer 触发键与弹层确认键共用，仅换 warn 令牌描边/字色；hover 用 10% 稀释（宿主无 warn 悬停底令牌）；叠加 .dsh-mf-discard 时靠 :not(:disabled) 特异性压过默认
    '.dsh-mf-warn:not(:disabled){border-color:var(--dsw-alias-state-warn-label,#dd8629);color:var(--dsw-alias-state-warn-label,#dd8629)}',
    '.dsh-mf-warn:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-warn-label,#dd8629) 10%, transparent)}',
    // 弹层面板：宽度与 flex 参与复刻宿主 SettingsRoot.module.css `.panel`；高度由内容撑开、640px 封顶（min 保留窄视口收敛，calc 分支给顶栏留与 .root padding 同的上下气），超封顶在包裹层滚动
    // flex:none：Modal .root 是 align-items:center 的 flex 容器，不加则按内容高度参与对齐、面板不居中
    // Modal 走 headless（卡片直接作 children，宿主标题栏/关闭钮/content/body 一律不渲染），故 .dialog 的 padding:0 0 24px 与 gap:20px 在此清空（原为 chrome 而设）
    // 底色/圆角/阴影取 .panel 令牌：bg-layer-2 与 .card 的 bg-layer-3 分层，容器本身可见，点中容器即不再误落到遮罩
    '.dsh-mf-composerDialog{flex:none;display:flex;flex-direction:column;width:800px;max-height:min(640px,calc(100vh - 2 * max(24px,var(--dsh-frame-overlay-top,24px))));max-width:calc(100vw - 48px);padding:0;gap:0;overflow:hidden;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
    // 滚动容器是包裹层：面板顶到 max-height 时，卡片溢出在此滚动
    '.dsh-mf-composerBody{display:flex;flex-direction:column;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden}',
    // 面板内的卡片去掉自身描边与底色，透出面板的 --dsw-alias-bg-layer-2，
    // 与设置面板的内容列同观感（那边 .nav/.content 亦无 own fill，面板底色透出）
    '.dsh-mf-composerBody>.dsh-mf-card{border-color:transparent;background:transparent}',
    // 输入框工具行 chip（conversation.input.left）：几何复刻宿主 PlanModeControl `.chip`（对称 padding 0 8px、min-width 34px）；配色按语义分档，各态见下方逐条注释
    '.dsh-mf-composerChip{display:inline-flex;align-items:center;gap:4px;min-width:34px;height:28px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm);font-size:13px;font-weight:500;line-height:20px;cursor:pointer}',
    '.dsh-mf-composerChip:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}',
    '.dsh-mf-composerChip:disabled{cursor:default;opacity:.6}',
    // 弱化档·深（模型优化）：透明底 + label-secondary 字；hover 出 interactive-bg-hover
    '.dsh-mf-composerChip[data-state="muted"]{background:transparent;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.dsh-mf-composerChip[data-state="muted"]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
    // 弱化档·浅（跟随灯未生效）：同为透明底，字色降到 label-caption（同宿主当前推理级别的色调）
    '.dsh-mf-composerChip[data-state="off"]{background:transparent;color:var(--dsw-alias-label-caption,#adb2b8)}',
    '.dsh-mf-composerChip[data-state="off"]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
    // 生效态：success 绿底 + 字；状态点 6px；hover 用 color-mix 同 PlanChip 手法（宿主无 success 悬停底令牌）
    '.dsh-mf-composerChip[data-state="on"]{background:var(--dsw-alias-state-success-tertiary,#d3f8d6);color:var(--dsw-alias-state-success-primary,#22c55e)}',
    '.dsh-mf-composerChip[data-state="on"]:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-success-tertiary,#d3f8d6) 94%, var(--dsw-alias-state-success-primary,#22c55e) 6%)}',
    // 失败态：warn 琥珀底 + 字（同 .dsh-mf-warn 令牌）；与生效态同样画状态点，靠色相区分而非形状
    '.dsh-mf-composerChip[data-state="fail"]{background:var(--dsw-alias-state-warn-tertiary,#fff1d6);color:var(--dsw-alias-state-warn-label,#dd8629)}',
    // 状态点（只在 on/fail 态画）：6px 圆点，background:currentColor，随 chip 色变化
    '.dsh-mf-composerChip[data-state="on"]::before,.dsh-mf-composerChip[data-state="fail"]::before{content:"";display:block;flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}',
].join('\n')

/** 幂等注入样式：每次渲染校验 DOM 实况——宿主 HMR 会按 data-plugin 摘走旧节点，节点在则同步内容 */
export function ensureStyles(): void {
    if (typeof document === 'undefined') return
    let tag = document.getElementById(STYLE_ID)
    if (tag === null) {
        tag = document.createElement('style')
        tag.id = STYLE_ID
        tag.dataset.plugin = PLUGIN_NAME
        document.head.appendChild(tag)
    }
    if (tag.textContent !== STYLE_TEXT) tag.textContent = STYLE_TEXT
}
