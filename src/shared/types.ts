/** 跨半共享的类型声明与纯类型守卫（零 Node 依赖、零 schemastery、零非基线 `@deepseek-ai/*`）。两半均直连本层（统一经 `@/shared/types` 别名导入）。
 * Node 专属类型（`ModelEntry` / `CacheRecord` / 冻结历史 v7 / `isCapacity` 等）留在 `src/types.ts`。
 * 宿主类型面一律 type-only 导入 devDep 的宿主包（构建期擦除），不在本仓另行声明 */

/** 判断是否为普通数据对象（非数组、非 null、非类实例） */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const proto: unknown = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

/** 从 `llm-pi-ai` 的 user 层收窄取 `providers` 段（Node 半 restore 的捕获/恢复与浏览器半 `providerIdsOf` 的命中判定共用同一口径，杜绝两处形状错配）；user 非纯对象、无 providers 或 providers 非纯对象一律返回 undefined */
export function providersOf(user: unknown): Record<string, unknown> | undefined {
    if (!isPlainObject(user)) return undefined
    const providers = user.providers
    return isPlainObject(providers) ? providers : undefined
}

/** 按字段分别控制的规则开关 */
export interface FieldRules {
    reasoning: boolean
    /** 上下文窗口与输出上限，二者一体受此开关控制 */
    context: boolean
    /** 图片/多模态（input 模态声明） */
    image: boolean
}

/** 兼容性规则：每条对应宿主 provider 路由 compat 下的一个字段。组内新增键向后兼容，不递增 CONFIG_VERSION（见 docs/versioning.md） */
export interface CompatRules {
    /** 为 true 时给该 provider 路由写 `compat.supportsDeveloperRole: false`（禁用 developer 角色，退回旧版 system 角色）；为 false 时移除该字段（而非保留不管）；仅作用于 `api === 'openai-completions'` 的路由，只写路由级 */
    disableDeveloper: boolean
    /** 为 true 时给该 provider 路由写 `compat.supportsStore: false`，使请求体不含 `store` 键；为 false 时移除该字段。宿主在该字段为 true 时仍发 `store: false`，故本开关去掉的是键本身而非取值——不识 `store` 的端点（LiteLLM 一类）拒的是键。与 disableDeveloper 同协议、同为把宿主乐观默认翻成保守，仅作用于 `api === 'openai-completions'` 的路由，只写路由级 */
    disableStore: boolean
}

/** 用户体验规则：体验行为开关，对所有提供方一致、不支持按提供方排除 */
export interface UserExperienceRules {
    /** 记住每模型上次手动选择的推理级别并在切换模型时自动恢复；为 false 时不再保存新记忆，但已记住的仍会自动恢复（关闭时卡片会询问是否清空） */
    rememberEfforts: boolean
    /** 切换模型时若未设置推理级别、也无记住的级别、且目标模型公告 `high` 档位，则自动设为 `high`。仅在「model-change」分支生效，不干预同模型切换级别（effort-change）。默认 true */
    defaultHigh: boolean
    /** 模型/提供方被删除时随之忘记该模型的推理级别记忆：开启时按宿主全量模型列表剪枝（`src/memory.ts`，列表里不再存在的条目删除、目录读失败的保留）。默认 true，口径见 docs/decisions.md「推理级别记忆」 */
    forgetRemoved: boolean
    /** 子智能体跟随父 Agent：为 true 时，宿主「允许 Agent 为子智能体选择模型」关闭着的组合里，委派出去的子 Agent 每次请求整条沿用父 Agent 当前生效的提供方 + 模型 + 推理级别（而非建子那一刻的快照）。默认 false */
    followParent: boolean
    /** 让 AI 自主调节推理档位：为 true 时向宿主注入两枚工具（查询当前模型可用档位 / 设置档位，与 UI 模型选择器同一入口）及一段系统提示词，由 AI 按任务难度自行决定何时切换、切到哪个档位；为 false 时卸载全部注入。默认 false */
    selfTune: boolean
    /** 隐藏官方 API：为 true 时，名单内（见 `src/official-filter.ts`）未配置密钥的官方提供方在 UI 模型选择列表里不显示（拦截 `ctx.llm.listModels` 返回空，宿主把模型数为 0 的组滤掉）。判定与「设置→模型」小红点同口径。默认 true */
    hideOfficial: boolean
    /** 本地化推理级别名：为 true 时把推理档位显示名换成中文——档位名由宿主适配器按档位 id 现算并随模型信息下发，本插件在 Node 半遮蔽 `ctx.llm.resolveModelInfo` 换名（见 `src/effort-name.ts`），UI 菜单与 AI 的 list-models 工具同受影响。只换显示名，档位 id 与 `defaultEffort` 原样保留（它们是发往模型的线上值）。默认 true */
    localizeEfforts: boolean
    /** 同时显示原档位名：为 true 时，本地化推理级别开启后把中文与英文原档位一起显示（`中文名 · 原档位`，如 `最大 · Max`）；关闭则只显示中文。默认 true */
    showOriginalEfforts: boolean
    /** 尽量匹配：精确匹配失败（无命中/歧义）时收集候选合成参数填充（候选等权、60% 口径，作用于 Node 半填充，见 docs/decisions.md「参数来源」）。默认 false */
    looseMatch: boolean
}

/** UI 可见性规则：控制各 UI 部件在宿主各处的挂载。不改变插件行为，只决定 UI 在不在——关闭即卸载对应席位的注册，功能本体照常运行 */
export interface BehaviorRules {
    /** 在「设置 → 模型」页脚显示配置卡片；关闭即卸载该席位的注册 */
    showInModels: boolean
    /** 在「设置 → 内置插件」显示配置选项卡；关闭即卸载该席位的注册 */
    showInBuiltinPlugins: boolean
    /** 在对话框工具栏显示「模型优化」入口 chip；关闭即卸载该条目 */
    showInComposer: boolean
    /** 在内容区左侧的悬浮按钮组里显示卡片入口（点击打开同一张配置卡）；关闭即不显示该按钮。默认 true */
    showInFloat: boolean
    /** 在对话框工具栏显示「跟随」状态灯；关闭即卸载该条目 */
    showFollowStatus: boolean
    /** 在内容区左侧显示「返回对话」悬浮按钮；关闭即不显示该按钮 */
    backToChat: boolean
    /** 经典设置入口：开启时侧栏底部只显示「设置」按钮（遮蔽宿主账号入口，故意见反馈与登录不可见），关闭即恢复宿主账号菜单。默认 true */
    classicSetting: boolean
}

/** 每模型推理级别记忆：provider id → model id → harness ModelThinkingLevel 字符串 */
export type EffortMemory = Record<string, Record<string, string>>

/** 当前运行时配置（仅对象写法） */
export interface PluginConfig {
    /** 开启后以 models.dev 最新数据为准更新已有配置 */
    allowUpdate: FieldRules
    /** 开启后自动填充缺失的推理级别/容量/图片字段 */
    autoFill: FieldRules
    /** 兼容性规则，作用于 provider 路由的 compat（与模型参数填充无关，不受 allowUpdate/autoFill 影响） */
    compat: CompatRules
    /** 排除的提供方 id：命中的提供方本插件不做任何操作（填充、覆盖、compat 增删、强制更新一律跳过），等效于对该提供方关闭插件。语义是预防性的：只影响本值生效之后的行为，此前已写入的模型参数与路由 compat 一律保留、不撤销（插件无字段来源记录，无从区分插件写入与用户手写） */
    excludes: string[]
    /** 每模型推理级别记忆：provider → model → 级别。运行时记忆而非用户配置，结构非法时解析侧宽松回落 {}（不让记忆坏值连累配置自愈重写丢配置） */
    efforts: EffortMemory
    /** UI 可见性规则（只管各 UI 部件挂不挂载，不改插件行为） */
    behavior: BehaviorRules
    /** 用户体验规则（前端行为开关，不支持按提供方排除） */
    userExperience: UserExperienceRules
}

/** 当前版本的存储快照：运行时配置字段 + 显式版本号 */
export interface PluginConfigSnapshot {
    configVersion: number
    allowUpdate: FieldRules
    autoFill: FieldRules
    compat: CompatRules
    excludes: string[]
    efforts: EffortMemory
    behavior: BehaviorRules
    userExperience: UserExperienceRules
}

/** 命名空间下的整段配置：version-N -> 对应版本的配置快照（保留低版本历史与更高新版本，便于无损回退） */
export type VersionedSection = Record<string, unknown>
