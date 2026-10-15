/**
 * 跨半共享的类型声明与纯类型守卫（零 Node 依赖、零 schemastery、零非基线 `@deepseek-ai/*`）。
 * 两半均**直连**本层（统一经 `@/shared/types` 别名导入），不经任何 facade 中转；
 * Node 专属类型（`ModelEntry` / `CacheRecord` / 冻结历史 v3–v7 / `isCapacity` 等）留在 `src/types.ts`。
 * 宿主类型面（Connection RPC 契约等）一律 type-only 导入 devDep 的宿主包（构建期擦除），不在本仓另行声明。
 */

/** 判断是否为普通数据对象（非数组、非 null、非类实例） */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const proto: unknown = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

/**
 * 从 `llm-pi-ai` 的 user 层收窄取 `providers` 段（Node 半 restore 的捕获/恢复与浏览器半 `providerIdsOf`
 * 的命中判定共用同一口径，杜绝两处形状错配）。user 非纯对象、无 providers 或 providers 非纯对象一律返回 undefined。
 */
export function providersOf(user: unknown): Record<string, unknown> | undefined {
    if (!isPlainObject(user)) return undefined
    const providers = user.providers
    return isPlainObject(providers) ? providers : undefined
}

/** 按字段分别控制的规则开关 */
export interface FieldRules {
    /** 推理级别字段 */
    reasoning: boolean
    /** 上下文窗口与输出上限，二者一体受此开关控制 */
    context: boolean
    /** 图片/多模态（input 模态声明） */
    image: boolean
}

/**
 * 兼容性规则：每条对应宿主 provider 路由 compat 下的一个字段。
 * 同组新增键对既有形态只是「多一个可选字段」，向后兼容，因此不需要递增 CONFIG_VERSION。
 */
export interface CompatRules {
    /**
     * 为 true 时给该 provider 的路由写入 `compat.supportsDeveloperRole: false`（禁用 developer 角色，
     * 退回旧版 API 兼容的 system 角色）；为 false 时**移除**该字段（而非保留不管）。
     * 仅作用于 `api === 'openai-completions'` 的路由，且只写路由级、不写模型级。
     */
    disableDeveloper: boolean
    /**
     * 为 true 时给该 provider 的路由写入 `compat.supportsStore: false`，使请求体不含 `store` 键；
     * 为 false 时**移除**该字段（而非保留不管）。
     * 宿主在该字段为 true 时发送的仍是 `store: false`，故本开关去掉的是**这个键本身**而非改它的取值——
     * 不识 `store` 的端点（LiteLLM 代理一类）拒的是键。与 disableDeveloper 同协议、同为把宿主的乐观默认翻成保守，
     * 仅作用于 `api === 'openai-completions'` 的路由，且只写路由级、不写模型级。
     */
    disableStore: boolean
}

/**
 * 用户体验规则：纯前端行为开关（不写入提供方/模型数据）。
 * 与填充规则不同，该组作用于会话侧操作、对所有提供方一致，**不支持按提供方排除**（见卡片释义）。
 */
export interface UserExperienceRules {
    /**
     * 记住每模型上次手动选择的推理级别并在切换模型时自动恢复；
     * 为 false 时前端不再保存新的记忆，但已记住的仍会自动恢复（关闭开关时卡片会询问是否清空，清空后即无记忆可恢复）。
     */
    rememberEfforts: boolean
    /**
     * 切换模型时若未设置推理级别、也无记住的级别、且目标模型公告 `high` 档位，则自动把推理级别设为 `high`。
     * 仅在「model-change」分支生效，不干预同模型切换级别（effort-change，含手动选「default」）。
     * 默认 true。
     */
    defaultHigh: boolean
    /**
     * 模型/提供方被删除时随之忘记该模型的推理级别记忆：开启时**按宿主全量模型列表剪枝**
     * （`src/memory.ts`，Node 半）——列表里不再存在的 provider / model 条目一律删除
     * （缺席即删除，故也覆盖 llm-pi-ai 之外的模型）；单个提供方目录读失败时其条目原样保留
     * （读不到 ≠ 不存在）。关闭则完全不剪枝，已删除模型的记忆原样保留（若后来重建同名模型会恢复该记忆）。
     * 默认 true。
     */
    forgetRemoved: boolean
    /**
     * 子智能体跟随父 Agent：为 true 时，宿主「允许 Agent 为子智能体选择模型」关闭着的组合里，
     * 委派出去的子 Agent 每次请求都整条沿用父 Agent **当前**生效的提供方 + 模型 + 推理级别
     * （而非建子那一刻的快照）。默认 false（即不干预，行为与没装本插件一致）。
     */
    followParent: boolean
    /**
     * 让 AI 自主调节推理档位：为 true 时向宿主注入两枚工具（查询当前模型可用档位 / 设置档位，
     * 与 UI 模型选择器同一入口）及一段系统提示词，由 AI 按任务难度自行决定何时切换、切到哪个档位；
     * 为 false 时卸载全部注入。默认 false（即不注入，行为与没装本插件一致）。
     */
    selfTune: boolean
    /**
     * 隐藏官方 API：为 true 时，名单内（见 `src/official-filter.ts`）未配置密钥的官方提供方
     * 在 UI 模型选择列表里不显示——拦截宿主目录生成时该提供方的模型清单（`ctx.llm.listModels`）返回空，
     * 宿主随即把模型数为 0 的组从目录里滤掉。判定与「设置→模型」小红点同口径。
     * 默认 true（即默认隐藏；配了官方密钥即自动照常显示）。
     */
    hideOfficial: boolean
    /**
     * 本地化推理级别名：为 true 时把推理档位的显示名换成中文（关 / 高 等）——档位名由宿主适配器按
     * 档位 id 现算（首字母大写）并随模型信息下发，本插件在 Node 半遮蔽 `ctx.llm.resolveModelInfo`
     * 换名（见 `src/effort-name.ts`），UI 菜单与 AI 的 list-models 工具同受影响。
     * 只换显示名，档位 id 与 `defaultEffort` 原样保留（它们是发往模型的线上值）。默认 true。
     */
    localizeEfforts: boolean
    /**
     * 同时显示原档位名：为 true 时，本地化推理级别开启后把中文与英文原档位一起显示，
     * 格式 `中文名 · 原档位`（如 `最大 · Max`）；关闭则只显示中文。便于用户对照每个中文
     * 具体对应哪个档位。默认 true。
     */
    showOriginalEfforts: boolean
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
    /**
     * 排除的提供方 id：命中的提供方本插件**不做任何操作**（填充、覆盖、compat 增删、强制更新一律跳过），
     * 等效于对该提供方关闭插件。语义是**预防性**的：只影响本值生效之后的行为，
     * 此前已写入的模型参数与路由 compat 一律保留、不撤销（插件无字段来源记录，无从区分插件写入与用户手写）。
     */
    excludes: string[]
    /**
     * 每模型推理级别记忆：provider → model → 级别。运行时记忆而非用户配置，
     * 结构非法时解析侧宽松回落 {}（不让记忆坏值连累配置自愈重写丢配置）。
     */
    efforts: EffortMemory
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
    userExperience: UserExperienceRules
}

/** 命名空间下的整段配置：version-N -> 对应版本的配置快照（保留低版本历史与更高新版本，便于无损回退） */
export type VersionedSection = Record<string, unknown>
