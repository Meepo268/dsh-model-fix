import { PLUGIN_NAME } from '@/shared/constants'

/**
 * 卡片的样式层：一份内嵌样式表与它的幂等注入，外加两处展示数值。
 *
 * 样式数值只此一处可查，是「UI 无痕融合纪律」的落地方式——改任何数值都改这一个文件，不必在组件里逐处找。
 * 色值一律只用 --dsw-alias-* 令牌，字面量仅作令牌缺失时的浅色守卫（取宿主主题真值）。
 */

/** 说明气泡宽度上限（px）：宿主 Tooltip 默认半视口，气泡会盖满整行开关区，故按瓦片列宽收窄 */
export const TIP_MAX_WIDTH = 300

/** 验证与探测两个弹层共用的记录区行数上限：跑满即滚动，够读完一轮的结论又不至于把弹层撑得过长 */
export const VERIFY_TERMINAL_LINES = 10

const STYLE_ID = 'dsh-model-fix-card-css'

/**
 * 内嵌样式表（类名 dsh-mf- 前缀防撞）。取值逐条照官方同类组件：外层卡＝旧版宿主
 * 「设置 → 插件 → 内置插件」的插件卡；内层瓦片＝旧版宿主「设置 → 插件 → 插件列表」的
 * 插件行卡——两处基准均取旧版观感（用户裁定），仅两处例外采纳现行值：瓦片底色
 * `--dsw-alias-settings-card-fill`、瓦片行折叠钮焦点环（照现行 .cardContent）。
 * 颜色一律只用 --dsw-alias-* 令牌，
 * 字面量仅作令牌缺失时的浅色守卫（取宿主主题 design-platform.css 真值）；官方源码引用但主题
 * 未定义的令牌（label-error、bg-layer-4）禁止照抄。
 */
const STYLE_TEXT = [
    // 外壳逐字照官方插件卡 .card；不写 max-width（宽度由所在 section 约束，官方同样不写）
    '.dsh-mf-card{list-style:none;border:0.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:16px;background:var(--dsw-alias-bg-layer-3,#fff);transition:border-color .16s, background .16s}',
    '.dsh-mf-card:hover{border-color:var(--dsw-alias-label-dimmed,#e1e5ee)}',
    '.dsh-mf-cardOpen{border-color:var(--dsw-alias-label-dimmed,#e1e5ee);background:var(--dsw-alias-bg-layer-2,#fff)}',
    // header：名称叠描述，右侧未保存胶囊与旋转 chevron
    '.dsh-mf-header{display:flex;align-items:center;gap:12px;box-sizing:border-box;width:100%;padding:14px 16px;border:1px solid transparent;border-radius:12px;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}',
    // 配置服务不可用时的静态头（div 渲染，无展开语义）
    '.dsh-mf-headerStatic{cursor:default}',
    '.dsh-mf-headText{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
    '.dsh-mf-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,#0f1115)}',
    '.dsh-mf-desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#81858c)}',
    '.dsh-mf-chevron{flex:none;color:var(--dsw-alias-label-tertiary,#81858c);transition:transform .16s}',
    '.dsh-mf-chevronOpen{transform:rotate(180deg)}',
    // 展开体：左右内缩与 header 对齐；顶部 0.5px 分隔线隔开摘要与正文，12px 上边距撑开与瓦片的距离
    '.dsh-mf-body{margin:0 16px;padding:12px 0 8px;border-top:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));display:flex;flex-direction:column;gap:12px}',
    // 状态行：内联承载一切结果反馈
    '.dsh-mf-notice{margin:0;padding:0 16px 12px;font-size:12px;line-height:18px}',
    '.dsh-mf-noticeSuccess{color:var(--dsw-alias-state-success-primary,#22c55e)}',
    '.dsh-mf-noticeError{color:var(--dsw-alias-state-error-primary,#ec1313)}',
    '.dsh-mf-line{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c)}',
    '.dsh-mf-warn{color:var(--dsw-alias-state-warn-label,#dd8629)}',
    // 配置组瓦片：栅格、项卡外壳、描边/阴影、行与展开体逐条照官方「插件列表」项卡（ui-settings-plugin-inventory）。
    // 描边用官方 elevation 令牌链（0.5px 发丝画在 box-shadow 里），字面兜底复刻其计算结果——有令牌即同源换色，无令牌同观感
    '.dsh-mf-items{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:10px}',
    '.dsh-mf-item{min-width:0;overflow:hidden;border:0;border-radius:14px;background:var(--dsw-alias-settings-card-fill,#fff);box-shadow:var(--dsw-elevation-stroke,0 0 0 0.5px var(--dsw-alias-border-l4,rgba(0,0,0,.16)))}',
    // 展开态（官方 data-open 驱动）：描边换最浅的 l1 并叠两层柔光，summary 行保留淡底
    '.dsh-mf-item[data-open="true"]{--dsw-elevation-stroke-color:var(--dsw-alias-border-l1,rgba(0,0,0,.04));box-shadow:var(--dsw-elevation-panel,0 0 0 0.5px var(--dsw-alias-border-l1,rgba(0,0,0,.04)),0 3px 8px 0 rgba(0,0,0,.03),0 0 16px 0 rgba(0,0,0,.02))}',
    '.dsh-mf-item[data-open="true"]>.dsh-mf-itemHead{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
    '.dsh-mf-itemHead{box-sizing:border-box;position:relative;display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:52px;padding:12px 14px;color:var(--dsw-alias-label-primary,#0f1115)}',
    '.dsh-mf-itemHead:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
    // 整行折叠按钮：透明覆盖层承担点击与键盘；尾区抬 z-index 关掉 pointer-events、只放开开关本体（无 button 嵌套）
    '.dsh-mf-itemToggle{position:absolute;inset:0;padding:0;border:none;border-radius:14px;background:none;cursor:pointer}',
    // 整行折叠钮照官方 .cardContent:focus-visible 补环：覆盖层 inset:0 与官方卡头按钮同范围，offset -2px 画行内缘（不被瓦片 overflow:hidden 裁剪）
    '.dsh-mf-itemToggle:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,rgb(65,118,230)));outline-offset:-2px}',
    // 标题偏离官方的省略号截断（用户裁定）：瓦片是两列栅格，官方那套 nowrap+ellipsis 在窄列里会把组名砍掉半截。
    // 改为可换行——overflow-wrap:anywhere 让连续英文/长 id 也能断行（它同时压低 min-content，故窄列里不再横向溢出）；
    // 标题 min-width:0 可收缩、尾区 .dsh-mf-itemTrailing 是 flex:none，故开关与箭头恒定尺寸并由行内 align-items:center 与文案居中对齐
    '.dsh-mf-itemTitle{min-width:0;overflow-wrap:anywhere;font-size:14px;line-height:20px;font-weight:600}',
    '.dsh-mf-itemTrailing{position:relative;z-index:1;display:inline-flex;flex:none;align-items:center;gap:7px;pointer-events:none;color:var(--dsw-alias-label-tertiary,#81858c)}',
    '.dsh-mf-itemSwitch{pointer-events:auto}',
    '.dsh-mf-itemChevron{flex:none;transition:transform 140ms var(--ds-ease-in-out,ease)}',
    '.dsh-mf-item[data-open="true"] .dsh-mf-itemChevron{transform:rotate(180deg)}',
    // 展开体填充官方 .cardDetails 的模块底色（与同页 .editor/.setupCard 同令牌），使展开内容读成内层面板
    '.dsh-mf-itemBody{border-top:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));padding:10px 14px 12px;display:grid;gap:6px;background:var(--dsw-alias-bg-module-platform,#f5f6f7)}',
    '.dsh-mf-itemHint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#81858c)}',
    '.dsh-mf-itemRow{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#0f1115)}',
    // Pill 组容器：组内行数 ≥ 5 时，Switch 行整体替换为 Pill 胶囊矩阵（flex-wrap 自动换行，gap 与宿主 Pill 24px 高度同档）
    '.dsh-mf-pillGroup{display:flex;flex-wrap:wrap;gap:6px}',

    // 行内标签组：照官方 settings-form .labelGroup（inline-flex、gap 4px、min-width:0）；标签过长时换行（裁定同瓦片标题），
    // align-items:center 让说明键与换行后的整块文案居中对齐
    '.dsh-mf-itemLabelGroup{display:inline-flex;align-items:center;gap:4px;min-width:0}',
    '.dsh-mf-itemLabel{min-width:0;overflow-wrap:anywhere}',
    // 说明键：度量与形态照官方 settings-form .helpButton（24×24 无边框图标钮），hover 底色改取本卡 header 同款
    // interactive-bg-hover（官方写的 bg-layer-4 主题未定义，见本表抬头）
    '.dsh-mf-help{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:none;color:var(--dsw-alias-label-tertiary,#81858c);cursor:pointer}',
    '.dsh-mf-help:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-secondary,#61666b)}',
    '.dsh-mf-help:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,rgb(65,118,230)));outline-offset:1px}',
    // 输入框照 ModelsSection 的 .input，删除钮照同页 .iconButton（hover 用 .iconButtonDanger 变体）
    '.dsh-mf-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:14px;line-height:22px}',
    '.dsh-mf-input:focus{border-color:var(--dsw-alias-state-business-primary,rgb(65,118,230));outline:none}',
    '.dsh-mf-input::placeholder{color:var(--dsw-alias-label-dimmed,#e1e5ee)}',
    '.dsh-mf-input:disabled{opacity:.6;cursor:default}',
    '.dsh-mf-fieldError{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#ec1313)}',
    // 一行一项：状态点在胶囊外（官方 trailing 同为 [点][胶囊] 兄弟节点）；删除钮 margin-left:auto 贴右成列
    '.dsh-mf-tagRow{position:relative;display:flex;align-items:center;gap:7px;min-width:0}',
    // 排除项胶囊：宿主 .tag 是 inline-flex 且带 white-space:nowrap，作为 flex 项默认 min-width:auto 不收缩，
    // 长 id 会把删除钮顶出行尾、再被瓦片 overflow:hidden 裁掉。给 min-width:0 让它可收缩，行内文字改为换行（裁定同瓦片标题），
    // 删除钮自身 flex:none + margin-left:auto，恒定尺寸并贴住行尾
    '.dsh-mf-tag{min-width:0}',
    '.dsh-mf-tagText{white-space:normal;overflow-wrap:anywhere}',
    '.dsh-mf-remove{box-sizing:border-box;flex:none;width:28px;height:28px;margin-left:auto;display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;border-radius:var(--dsw-radius-sm,8px);background:0 0;color:var(--dsw-alias-label-tertiary,#81858c);cursor:pointer}',
    '.dsh-mf-remove:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.05));color:var(--dsw-alias-state-error-primary,#ec1313)}',
    '.dsh-mf-remove:disabled{cursor:default;opacity:.4}',
    // 只给读屏器的状态文案：照同页 .hiddenLabel 的裁剪手法
    '.dsh-mf-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    '@media (max-width:680px){.dsh-mf-items{grid-template-columns:minmax(0,1fr)}}',
    '@media (prefers-reduced-motion:reduce){.dsh-mf-itemChevron{transition:none}}',
    // 动作键行（强制更新 / 重置推理级别 / 恢复备份 / 验证模型 / 探测式填充）：独占一行、靠左起排，不设分割线——它承接上方瓦片，
    // 分隔线留给其下的取消/保存行；键渐多后在本行内换行落位，不相互挤压。
    // 本行不带自己的上间距：与瓦片的距离已由 .dsh-mf-body 的 gap:12px 给出，再叠一层会算成 24px
    '.dsh-mf-bar{display:flex;align-items:center;justify-content:flex-start;gap:8px}',
    // 取消/保存行：分隔线之下靠右收尾。上间距 8px——上一行动作键不再自带 12px，这一段的距离改由
    // .dsh-mf-body 的 gap:12px 给出，两段之间是 12+8；8px 是宿主 .section 内部相邻控件的档位
    '.dsh-mf-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:8px 0 0;border-top:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
    '.dsh-mf-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    // footer 键度量照官方 SettingsForm .save（圆角 radius-md + focus 环同源）；force 红字透明底照
    // models 页 .dangerButton 语义；discard 官方无同款（SettingsForm 不设 discard 键），度量与 save 成对
    '.dsh-mf-discard,.dsh-mf-save,.dsh-mf-force{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md,12px);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}',
    '.dsh-mf-discard:focus-visible,.dsh-mf-save:focus-visible,.dsh-mf-force:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,rgb(65,118,230)));outline-offset:1px}',
    '.dsh-mf-discard{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:none;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.dsh-mf-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary,#0f1115);border-color:var(--dsw-alias-label-dimmed,#e1e5ee)}',
    '.dsh-mf-save{background:var(--dsw-alias-label-primary,#0f1115);color:var(--dsw-alias-bg-layer-3,#fff)}',
    '.dsh-mf-force{background:none;color:var(--dsw-alias-state-error-primary,#ec1313)}',
    '.dsh-mf-force:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.05))}',
    '.dsh-mf-discard:disabled,.dsh-mf-save:disabled,.dsh-mf-force:disabled{opacity:.4;cursor:default}',
    // 卡片末尾的项目链接行（版权行语气）：border-top 即分割线。四段间距全部 12px ——
    // footer 的 padding-bottom 归零、间距整体让给本行的 padding-top，两条分割线各自到最近内容的距离相等
    '.dsh-mf-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 0 4px;border-top:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
    '.dsh-mf-metaLeft{display:inline-flex;align-items:center;gap:8px;min-width:0}',
    // 仓库地址与两个跳转键同为描边小片、一律 12px：这一行是版权/联系说明，不该有主次层级
    '.dsh-mf-chip{display:inline-flex;align-items:center;gap:6px;min-width:0;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:8px;padding:3px 10px;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b);text-decoration:none;white-space:nowrap}',
    'a.dsh-mf-chip:hover{color:var(--dsw-alias-label-primary,#0f1115);border-color:var(--dsw-alias-label-dimmed,#e1e5ee)}',
    '.dsh-mf-chipAddress{overflow:hidden;text-overflow:ellipsis}',
    // 版本标记加一层底色：取开关关闭态轨道色 border-l3 的半透明，等同开关 :disabled（opacity .5）压到
    // 卡片底上的观感，而文字/图标仍取全强度（不能用 opacity 整体压，会连字一起变淡）
    '.dsh-mf-chipVersion{background:color-mix(in srgb, var(--dsw-alias-border-l3,rgba(0,0,0,.12)) 50%, transparent)}',
    '.dsh-mf-linkIcon{flex:none;display:block;width:12px;height:12px;color:currentColor}',
    // 危险确认键：官方 .deleteConfirm 写法（outline 按钮 + 红描边红字 + danger hover）
    '.dsh-mf-confirmDanger:not(:disabled){border-color:var(--dsw-alias-state-error-primary,#ec1313);color:var(--dsw-alias-state-error-primary,#ec1313)}',
    '.dsh-mf-confirmDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.05))}',
    // 「验证模型」弹层：逐条照官方 models 页「获取可用模型」候选框（ModelsSection 的 fetchDialog / candidate* 类）。
    // 宿主滚动条变量无浅色真值可引，按官方原样透传、不自造字面量兜底
    '.dsh-mf-verifyDialog{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);max-width:520px}',
    // 正文纵向节奏：宿主 .body 是 flex column 且**没有 gap**，段间距全靠各自的 margin——而 flex 容器里
    // margin 不折叠，两段紧挨时各自的 margin 直接相加（探测弹层「范围提示 ↔ 额度提示」实测 24px 正是
    // 12+12）。故正文各段再套一层容器把 12px 收在一处、各段自身 margin 归零：容器内任何两段的净距恒为 12px；
    // 末段归零又让「面板 ↔ footer」只剩宿主 .dialog 的 gap:20px，与「描述 ↔ 正文」的 20px 相等，不必自造数值
    '.dsh-mf-verifyBody{display:flex;flex-direction:column;gap:12px}',
    // 选项卡条逐条复刻官方「设置 → 内置插件」的插件视图选项卡（PluginsSettingsSection 的 .tabs/.tab）：
    // 下划线指示条压在分隔线上（bottom:-1px）。面板那一侧只取官方的 min-width:0——官方的 padding-top:2px
    // 不取：本项目的正文一律 12px 更优先，选项卡条与面板是相邻两段，那 12px 由 .dsh-mf-verifyBody 的 gap 给
    // （未选中的面板带 hidden 即 display:none、不是 flex 项，换页后不留空段），面板自身不再补 padding
    '.dsh-mf-verifyTabs{border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));align-items:flex-end;gap:22px;margin-top:2px;display:flex}',
    '.dsh-mf-verifyTab{color:var(--dsw-alias-label-tertiary,#81858c);font:inherit;cursor:pointer;background:0 0;border:0;padding:7px 1px 9px;font-size:13px;line-height:20px;position:relative}',
    '.dsh-mf-verifyTab:hover,.dsh-mf-verifyTab[data-active="true"]{color:var(--dsw-alias-label-primary,#0f1115)}',
    '.dsh-mf-verifyTab[data-active="true"]:after,.dsh-mf-verifyTab:focus-visible:after{background:var(--dsw-alias-label-primary,#0f1115);content:"";border-radius:2px 2px 0 0;height:2px;position:absolute;bottom:-1px;left:0;right:0}',
    '.dsh-mf-verifyTab:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,rgb(65,118,230)));outline-offset:2px;color:var(--dsw-alias-label-primary,#0f1115);border-radius:2px}',
    '.dsh-mf-verifyPanel{min-width:0}',
    // 候选列表：项间距用默认（不写 gap，即 0），行内纵向内边距仍逐条取官方 candidateLabel 的 6px 8px，
    // 相邻两行靠这层内边距自然分开。官方 .candidateList 的 2px 是「同屏尽量多列模型」的紧凑档，这里不取
    '.dsh-mf-verifyList{display:flex;flex-direction:column;max-height:240px;margin:0;padding:0;list-style:none;overflow-y:auto}',
    // 验证弹层比宿主默认的 380px 宽一档：候选列表里的模型 id 常带斜杠（如 z-ai/glm-5），窄框里会折行、
    // 与右侧开关挤在一起。宿主 .dialog 的 width 同为单类选择器，本插件的 <style> 后于宿主样式表注入，
    // 同优先级下后者胜出，故能覆盖
    '.dsh-mf-verifyDialog{width:min(560px,100%)}',
    // 提供方分组头：官方候选框本无分组，此处一行标题标明下一批条目归属（零自造色，仅用宿主 label 令牌）。
    // 排布照官方 candidateToolbar——align-items:center + gap:8px 的 flex 行；右侧分组全选键 margin-left:auto 顶到行尾。
    // 纵向内边距取官方 candidateLabel 的 6px 8px，与候选行同档
    '.dsh-mf-verifyGroup{display:flex;align-items:center;gap:8px;padding:6px 8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,#81858c)}',
    '.dsh-mf-verifyGroupAll{margin-left:auto}',
    '.dsh-mf-verifyRow{border-radius:var(--dsw-radius-md,12px)}',
    '.dsh-mf-verifyLabel{display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer}',
    '.dsh-mf-verifyId{flex:auto;min-width:0;overflow:hidden;font-family:var(--ds-font-family-code);font-size:13px;text-overflow:ellipsis;white-space:nowrap}',
    // 空态：margin 归零（上下气口交给容器的 12px 与宿主 .body 的外边距），其余逐条照官方 candidateEmpty。
    // 验证弹层两个面板的空态共用本类——「还没勾到模型」与「还没发起过」是同一件事的两面，读法也一致
    '.dsh-mf-verifyEmpty{margin:0;color:var(--dsw-alias-label-secondary,#61666b);text-align:center;font-size:13px;line-height:20px}',
    // 额度提示：逐条同官方插件卡的 .notice——warn 语义、12px/18px，margin 归零。
    // 验证弹层里它是正文首段，与下方选项卡组之间的 12px 由 .dsh-mf-verifyBody 的 gap 给；
    // 探测弹层里它与上一句提示紧挨，两段各自的 margin 在 flex 里会相加，同样只能靠容器定距
    '.dsh-mf-verifyQuota{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label,#dd8629)}',
    // 开关行：探测弹层的两个开关在正文内（开关自身不带外边距，段间距只由 .dsh-mf-verifyBody 的 gap 给）；
    // 验证弹层的「验证所有推理级别」在 footer 里，与那行 .dsh-mf-verifyActions 共用本类
    '.dsh-mf-verifyOption{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary,#61666b)}',
    // 探测弹层的两个开关并排：同属一组操作参数，按「小节内相邻块」的 12px 档定距；
    // 上间距同样交给 .dsh-mf-verifyBody 的 gap:12px，margin 归零
    '.dsh-mf-verifyOptions{display:flex;align-items:center;gap:12px;min-width:0;margin:0}',
    // 验证弹层 footer 只有一行（档位开关靠左、取消/验证两键靠右）：宿主 .footer 是单行 flex 且无 wrap，
    // 故自绘一行容器覆盖它的三个数值（width:100% + space-between 覆盖 flex-end）
    '.dsh-mf-verifyActions{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%}',
    '.dsh-mf-verifyButtons{display:flex;align-items:center;gap:8px}',
    // 记录区上下边距：宿主 TerminalBlock 的 .block 自带 margin:16px 0，在探测弹层里与正文容器的 12px 间距相加会算成
    // 28px；整条归零。验证弹层的记录区自成一个面板（面板内只此一段，16px 留白无处可抵），同样归零
    '.dsh-mf-verifyLog{margin:0}',
    // 注意语义键：卡片 footer 的「验证模型」触发键与弹层内的验证确认键共用，仅把描边/字色换成 warn 令牌；
    // hover 用其 10% 稀释（宿主无 warn 悬停底令牌，与 .dsh-mf-chipVersion 同一 color-mix 手法，不自造色值）。
    // 叠加在 .dsh-mf-discard 之上时靠 :not(:disabled) 的高特异性压过其默认描边/字色
    '.dsh-mf-warn:not(:disabled){border-color:var(--dsw-alias-state-warn-label,#dd8629);color:var(--dsw-alias-state-warn-label,#dd8629)}',
    '.dsh-mf-warn:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-warn-label,#dd8629) 10%, transparent)}',
    // 输入框工具行 chip（conversation.input.left）：几何逐条复刻宿主 PlanModeControl `.chip`（对称 padding 0 8px、min-width 34px），
    // 配色按两枚 chip 的三态语义分色：
    // · 弱化态（模型优化恒用、跟随关闭态复用）：透明底 + label-secondary 字；hover 出 interactive-bg-hover
    // · 生效态（跟随中）：success 绿底 + 字；补 6px 状态点（::before），与弱化态在形状上即可区分（灰态不画点）
    // · 失败态（写入被拒）：warn 琥珀色，原生 title 提示原因
    // 弹层面板：宽度与 flex 参与方式复刻宿主设置面板 SettingsRoot.module.css 的 `.panel`（左下角齿轮点开的那一个），
    // 高度改按内容收敛：设置面板是 800×800 的固定大框，本卡片内容远不足 800px，固定高度会让面板上下留出
    // 一大片容器自身区域（无内容即无滚动提示、点击落在容器上），故取 640px——够放下多数瓦片的常用视域，
    // 超出即在包裹层内滚动。min() 保留窄视口下的收敛，calc 分支给顶栏留出与 .root padding 相同的上下空气。
    // flex:none：Modal 的 .root 是 align-items:center 的 flex 容器，不加则本项按内容高度参与对齐、面板不居中。
    // Modal 走 headless（卡片直接作 children，宿主的标题栏/关闭钮/content/body 一律不渲染），
    // .dialog 自带的 padding:0 0 24px 与 gap:20px 在此清空（头尾留白与子项间距原为 chrome 而设）。
    // 底色/圆角/阴影取 .panel 的令牌（--dsw-alias-bg-layer-2 与 .card 的 bg-layer-3 分层，容器本身可见，
    // 点击命中容器即不再误落到遮罩）。
    '.dsh-mf-composerDialog{flex:none;display:flex;flex-direction:column;width:800px;height:min(640px,calc(100vh - 2 * max(24px,var(--dsh-frame-overlay-top,24px))));max-width:calc(100vw - 48px);padding:0;gap:0;overflow:hidden;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
    // headless 下 children 直挂 .dialog（flex 列且已封顶），滚动容器由本包裹层承担：
    // 伸展到面板全高，故内容不足时容器自身即是滚动视口（内容居上，不塌成内容高）
    '.dsh-mf-composerBody{display:flex;flex-direction:column;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden}',
    // 面板内的卡片去掉自身描边与底色，透出面板的 --dsw-alias-bg-layer-2，
    // 与设置面板的内容列同观感（那边 .nav/.content 亦无 own fill，面板底色透出）
    '.dsh-mf-composerBody>.dsh-mf-card{border-color:transparent;background:transparent}',
    '.dsh-mf-composerChip{display:inline-flex;align-items:center;gap:4px;min-width:34px;height:28px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm);font-size:13px;font-weight:500;line-height:20px;cursor:pointer}',
    '.dsh-mf-composerChip:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}',
    '.dsh-mf-composerChip:disabled{cursor:default;opacity:.6}',
    // 弱化态：透明底 + label-secondary 字；hover 出 interactive-bg-hover
    '.dsh-mf-composerChip[data-state="muted"]{background:transparent;color:var(--dsw-alias-label-secondary,#61666b)}',
    '.dsh-mf-composerChip[data-state="muted"]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
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
