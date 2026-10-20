// lookup.ts 纯函数测试：模型 id 匹配（精确/词干/前缀三级）、提供方提示与推理级别转换、参数来源候选枚举
import { collectCandidates, entryBySourceKey, lookup, normalizeId, sourceKey, stripNamespace, toReasoningEfforts } from '@/lookup'
import type { IndexedCatalog, IndexEntry } from '@/types'
import { check, stable } from '@test/helper'

/** 构造目录条目（第三参补容量等其余字段） */
function entry(id: string, efforts: string[] = [], extra: Partial<IndexEntry> = {}): IndexEntry {
    return { id, efforts, ...extra }
}

/** 构造分组索引（匹配键按 lookup 的归一规则建，与 catalog.ts 建索引同口径） */
function indexed(groups: Record<string, IndexEntry[]>): IndexedCatalog {
    return {
        catalog: {},
        groups: new Map(Object.entries(groups).map(([provider, entries]) => [provider, {
            ids: entries.map((item) => normalizeId(item.id)),
            byId: new Map(entries.map((item) => [normalizeId(item.id), item])),
        }])),
    }
}

/** 以模型 id 列表构造分组索引 */
function catalog(groups: Record<string, string[]>): IndexedCatalog {
    return indexed(Object.fromEntries(Object.entries(groups).map(([provider, ids]) => [provider, ids.map((id) => entry(id))])))
}

/** 执行本文件的全部用例 */
export function run(): void {
    // ---------- 精确匹配（含归一化：大小写、-latest/-openai-compact 后缀噪音） ----------
    check('lookup 精确命中', lookup(catalog({ deepseek: ['deepseek-chat'] }), 'deepseek', 'deepseek-chat')?.id === 'deepseek-chat')
    check('lookup 归一化大小写', lookup(catalog({ deepseek: ['deepseek-chat'] }), 'deepseek', 'DeepSeek-Chat')?.id === 'deepseek-chat')
    check('lookup 去 -latest 后缀', lookup(catalog({ openai: ['gpt-5'] }), 'openai', 'gpt-5-latest')?.id === 'gpt-5')
    check('lookup 去 -openai-compact 后缀', lookup(catalog({ openai: ['gpt-5'] }), 'openai', 'gpt-5-openai-compact')?.id === 'gpt-5')

    // ---------- provider+id 失败时全局匹配 ----------
    check('provider 不在目录 -> 全局唯一命中', lookup(catalog({ deepseek: ['deepseek-chat'] }), 'custom-router', 'deepseek-chat')?.id === 'deepseek-chat')
    check('provider 命中但模型不在 -> 全局唯一命中', lookup(catalog({ deepseek: ['deepseek-reasoner'], anthropic: ['claude-sonnet-4'] }), 'deepseek', 'claude-sonnet-4')?.id === 'claude-sonnet-4')

    // ---------- 目录 id 自带命名空间前缀（目录中过半 id 如此）：完整 id 必须先在组内命中 ----------
    check('目录 id 带前缀 -> 完整 id 组内命中', lookup(catalog({ deepinfra: ['tencent/Hy3'] }), 'deepinfra', 'tencent/Hy3')?.id === 'tencent/Hy3')
    check('目录 id 带前缀 -> 匹配大小写无关', lookup(catalog({ deepinfra: ['tencent/Hy3'] }), 'deepinfra', 'TENCENT/hy3')?.id === 'tencent/Hy3')
    check('本地带前缀而目录不带 -> 仍退回裸名命中', lookup(catalog({ zai: ['glm-5'] }), 'zai', 'z-ai/glm-5')?.id === 'glm-5')
    // 末段唯一匹配：provider 严格匹配即已定域，裸名等于目录 id 末段且唯一时收下
    check('provider 严格匹配 + 裸名等于唯一末段 -> 命中', lookup(catalog({ deepinfra: ['tencent/Hy3'] }), 'deepinfra', 'Hy3')?.id === 'tencent/Hy3')
    check('末段匹配大小写无关', lookup(catalog({ deepinfra: ['tencent/Hy3'] }), 'deepinfra', 'hy3')?.id === 'tencent/Hy3')
    check('末段多个不同条目 -> 判歧义无匹配', lookup(catalog({ deepinfra: ['a/Hy3', 'b/Hy3'] }), 'deepinfra', 'Hy3') === undefined)
    check('provider 不在目录时不启用末段匹配 -> 全局兜底多命中仍无匹配', lookup(catalog({ deepinfra: ['tencent/Hy3'], other: ['tencent/Hy3'] }), 'custom-router', 'Hy3') === undefined)
    check('末段匹配不跨提供方错配（他组同末段条目不得入选）', lookup(catalog({ deepinfra: ['tencent/Hy3'], 'tencent-tokenhub': ['hy3'] }), 'deepinfra', 'Hy3')?.id === 'tencent/Hy3')

    // ---------- 跨提供方不错配：同名条目在多家网关重复，兜底须过唯一性门槛 ----------
    check('兜底多命中 -> 判歧义无匹配', lookup(catalog({ a: ['Hy3'], b: ['Hy3'] }), 'custom-router', 'Hy3') === undefined)
    check('兜底唯一命中 -> 放行', lookup(catalog({ a: ['Hy3'] }), 'custom-router', 'Hy3')?.id === 'Hy3')
    check('带前缀 id 命中本组参数而非他组同名条目', lookup(
        indexed({ 'tencent-tokenhub': [entry('hy3', [], { contextWindow: 256000 })], deepinfra: [entry('tencent/Hy3', [], { contextWindow: 262144 })] }),
        'deepinfra', 'tencent/Hy3',
    )?.contextWindow === 262144)

    // ---------- 官方提供方提示：模型名前缀优先在 hinted 提供方内匹配 ----------
    check(
        '前缀提示优先官方提供方',
        lookup(catalog({ openai: ['gpt-5-mini'], 'custom-ai': ['gpt-5-turbo'] }), 'custom-ai', 'gpt-5-mini')?.id === 'gpt-5-mini',
        lookup(catalog({ openai: ['gpt-5-mini'], 'custom-ai': ['gpt-5-turbo'] }), 'custom-ai', 'gpt-5-mini'),
    )
    check('o 系列前缀提示 openai', lookup(catalog({ openai: ['o3'] }), 'custom-ai', 'o3')?.id === 'o3')
    check('裸 o 前缀不命中（候选表逐项列 o1/o3/o4 而非裸 o）', lookup(catalog({ openai: ['o3'] }), 'custom-ai', 'ollama-3') === undefined)
    check('多候选提供方依序尝试（moonshotai 无条目回落 moonshotai-cn）', lookup(catalog({ 'moonshotai-cn': ['kimi-k3'] }), 'custom-ai', 'kimi-k3')?.id === 'kimi-k3')
    check('多候选提供方第一候选优先', lookup(catalog({ moonshotai: ['kimi-k3'], 'moonshotai-cn': ['kimi-k3'] }), 'custom-ai', 'kimi-k3')?.id === 'kimi-k3')
    check('qwen 前缀提示 alibaba 依序回落 alibaba-cn', lookup(catalog({ 'alibaba-cn': ['qwen3-max'] }), 'custom-ai', 'qwen3-max')?.id === 'qwen3-max')
    // qwen3 代版本号粘在 qwen 后（qwen3.x / qwen3-x），`qwen` 行的分隔符判据罩不住，须单列；
    // 无提示时同名常落多网关 -> 兜底判歧义放弃，有提示则官方组依序优先
    check('qwen3 点形前缀提示 alibaba（消多网关镜像歧义）', lookup(
        catalog({ alibaba: ['qwen3.8-max'], aihubmix: ['qwen3.8-max'] }), 'custom-ai', 'qwen3.8-max',
    )?.id === 'qwen3.8-max')
    check('qwen3 连字符形（qwen3-coder）同走提示', lookup(
        catalog({ alibaba: ['qwen3-coder-flash'], aihubmix: ['qwen3-coder-flash'] }), 'custom-ai', 'qwen3-coder-flash',
    )?.id === 'qwen3-coder-flash')
    check('glm 前缀提示 zai 依序回落 zhipuai', lookup(catalog({ zhipuai: ['glm-5'] }), 'custom-ai', 'glm-5')?.id === 'glm-5')
    check('minimax 大写裸名小写后命中候选表', lookup(catalog({ minimax: ['MiniMax-M3'] }), 'custom-ai', 'MiniMax-M3')?.id === 'MiniMax-M3')
    check('gemini 前缀提示 google', lookup(catalog({ google: ['gemini-3-flash'] }), 'custom-ai', 'gemini-3-flash')?.id === 'gemini-3-flash')
    check('mimo 前缀提示 xiaomi（官方组优先于网关镜像，消跨提供方歧义）', lookup(
        indexed({ xiaomi: [entry('mimo-v2.6-flash')], aihubmix: [entry('mimo-v2.6-flash')] }),
        'custom-ai', 'mimo-v2.6-flash',
    )?.id === 'mimo-v2.6-flash')
    // 头部厂商镜像常多家重复：无提示行时同名落多网关 -> 兜底判歧义放弃；有提示则官方组依序优先
    check('llama 前缀提示 llama（Meta 官方组消网关镜像歧义）', lookup(
        catalog({ llama: ['llama-3.3-70b-instruct'], aihubmix: ['llama-3.3-70b-instruct'] }), 'custom-ai', 'llama-3.3-70b-instruct',
    )?.id === 'llama-3.3-70b-instruct')
    check('sonar 前缀提示 perplexity', lookup(
        catalog({ perplexity: ['sonar-pro'], aihubmix: ['sonar-pro'] }), 'custom-ai', 'sonar-pro',
    )?.id === 'sonar-pro')
    check('longcat 前缀提示 longcat（大写裸名归一小写后命中）', lookup(
        catalog({ longcat: ['LongCat-2.0'], aihubmix: ['LongCat-2.0'] }), 'custom-ai', 'LongCat-2.0',
    )?.id === 'LongCat-2.0')
    check('doubao 前缀提示 volcengine（前缀与提供方名不搭，指向火山引擎官方组）', lookup(
        catalog({ volcengine: ['doubao-seed-1-8'], aihubmix: ['doubao-seed-1-8'] }), 'custom-ai', 'doubao-seed-1-8',
    )?.id === 'doubao-seed-1-8')
    check('step 前缀提示 stepfun 系（首候选缺席时依序回落 stepfun-ai）', lookup(
        catalog({ 'stepfun-ai': ['step-5-preview'], aihubmix: ['step-5-preview'] }), 'custom-ai', 'step-5-preview',
    )?.id === 'step-5-preview')
    check('chatgpt 前缀提示 openai', lookup(catalog({ openai: ['chatgpt-4o-latest'] }), 'custom-ai', 'chatgpt-4o-latest')?.id === 'chatgpt-4o-latest')
    check('mistral 系衍生前缀提示 mistral（codestral）', lookup(catalog({ mistral: ['codestral-latest'] }), 'custom-ai', 'codestral')?.id === 'codestral-latest')

    // ---------- 词干匹配：去版本日期/长数字段后唯一命中 ----------
    check('词干剥离日期后缀', lookup(catalog({ deepseek: ['deepseek-chat-20250901'] }), 'deepseek', 'deepseek-chat')?.id === 'deepseek-chat-20250901')
    check('词干剥离长数字段', lookup(catalog({ deepseek: ['deepseek-chat-v3.1-2508'] }), 'deepseek', 'deepseek-chat')?.id === 'deepseek-chat-v3.1-2508')

    // ---------- digits 区分：同 base 多日期变体，凭 digits 精确命中而非歧义 undefined ----------
    check('digits 区分 8 位日期', lookup(catalog({ openai: ['gpt-5-20240813', 'gpt-5-20241120'] }), 'openai', 'gpt-5-20240813')?.id === 'gpt-5-20240813')
    check('digits 区分 4 位 MMDD', lookup(catalog({ openai: ['gpt-5-0813', 'gpt-5-1120'] }), 'openai', 'gpt-5-0813')?.id === 'gpt-5-0813')
    check('digits 区分 MM-DD', lookup(catalog({ openai: ['gpt-5-08-13', 'gpt-5-11-20'] }), 'openai', 'gpt-5-08-13')?.id === 'gpt-5-08-13')
    check('digits 区分 YYYY-MM-DD', lookup(catalog({ openai: ['gpt-5-2024-08-13', 'gpt-5-2024-11-20'] }), 'openai', 'gpt-5-2024-08-13')?.id === 'gpt-5-2024-08-13')
    // 数字串归一化：仅连字符写法不同的同日期（08-31 与 0831、2024-08-31 与 20240831）视作同一 digits
    check('digits 归一化 08-31 == 0831', lookup(catalog({ openai: ['gpt-5-08-13', 'gpt-5-11-20'] }), 'openai', 'gpt-5-0813')?.id === 'gpt-5-08-13')
    check('digits 归一化 2024-08-31 == 20240831', lookup(catalog({ openai: ['gpt-5-20240813', 'gpt-5-20241120'] }), 'openai', 'gpt-5-2024-08-13')?.id === 'gpt-5-20240813')
    check('digits 不同不误配', lookup(catalog({ openai: ['gpt-5-20240813', 'gpt-5-20241120'] }), 'openai', 'gpt-5-20240814') === undefined)
    // 本地带日期、目录有同 base 裸名 + 异日期变体：digits 比对排除异日期，仅裸名命中
    check('digits 排除异日期留裸名', lookup(catalog({ openai: ['gpt-5', 'gpt-5-20241120'] }), 'openai', 'gpt-5-20240813')?.id === 'gpt-5')
    // ---------- 中缀日期：日期夹在 id 中段（非末尾）同样提取并区分 ----------
    check('中缀日期精确命中', lookup(catalog({ openai: ['gpt-5-20240831-preview', 'gpt-5-20241120-preview'] }), 'openai', 'gpt-5-20240831-preview')?.id === 'gpt-5-20240831-preview')
    check('中缀日期变体凭 digits 区分', lookup(catalog({ openai: ['gpt-5-preview', 'gpt-5-20241120-preview'] }), 'openai', 'gpt-5-20240831-preview')?.id === 'gpt-5-preview')
    check('中缀日期多变体无裸名 -> 无匹配', lookup(catalog({ openai: ['gpt-5-20240831-preview', 'gpt-5-20241120-preview'] }), 'openai', 'gpt-5-preview') === undefined)

    // ---------- 前缀匹配：目录 id 只多一个数字快照后缀时唯一命中 ----------
    check('前缀匹配唯一命中（数字快照）', lookup(catalog({ openai: ['gpt-5-20250807'] }), 'openai', 'gpt-5')?.id === 'gpt-5-20250807')
    check('前缀不吃子型号（gpt-5 ↛ gpt-5-mini）', lookup(catalog({ openai: ['gpt-5-mini'] }), 'openai', 'gpt-5') === undefined)

    // ---------- 歧义不猜：词干/前缀命中多个或零个 -> 无匹配 ----------
    check('词干命中多个 -> 无匹配', lookup(catalog({ openai: ['gpt-5-mini', 'gpt-5-turbo'] }), 'openai', 'gpt-5') === undefined)
    check('前缀命中多个 -> 无匹配', lookup(catalog({ openai: ['gpt-5-mini', 'gpt-5-nano'] }), 'openai', 'gpt-5') === undefined)
    check('完全无命中 -> undefined', lookup(catalog({ openai: ['gpt-5'] }), 'openai', 'o3') === undefined)

    // ---------- 尽量匹配（loose=true）：多命中加权合成，无命中则 includes 扩展 ----------
    // 容量取「有值候选」的 60 分位（宁小勿大）；efforts / image 按权重计（官方 HINTS 值集合 ×5，其余 ×1）
    check('loose 关闭时歧义仍放弃（守卫）', lookup(catalog({ a: ['Hy3'], b: ['Hy3'] }), 'custom-router', 'Hy3', false) === undefined)
    {
        // 容量安全 N：5 家候选 ctx 分别 10/10/10/9/8（万），升序累计票数首次 ≥60% 的值即 10（60% 以上候选 ≤ 10）
        const ctx = indexed({
            gw1: [entry('m', [], { contextWindow: 100_000 })],
            gw2: [entry('m', [], { contextWindow: 100_000 })],
            gw3: [entry('m', [], { contextWindow: 100_000 })],
            gw4: [entry('m', [], { contextWindow: 90_000 })],
            gw5: [entry('m', [], { contextWindow: 80_000 })],
        })
        const looseCtx = lookup(ctx, 'relay', 'm', true)
        check('loose 容量取 60 分位安全 N', looseCtx?.contextWindow === 100_000, looseCtx)
        // 容量分位数基于有值候选（无值候选不占位）：仅 2/5 家有值时仍取分位，不再判「支持率不足」
        const maxT = indexed({
            gw1: [entry('m', [], { maxTokens: 8_000 })],
            gw2: [entry('m', [], { maxTokens: 8_000 })],
            gw3: [entry('m')],
            gw4: [entry('m')],
            gw5: [entry('m')],
        })
        check('loose 容量分位只算有值候选', lookup(maxT, 'relay', 'm', true)?.maxTokens === 8_000, lookup(maxT, 'relay', 'm', true))
        // 官方权重不展开进容量分位（分位只在候选粒度上算）：官方 + 2 网关有值 = 3/5 有值，N 取多数侧
        const withOfficial = indexed({
            deepseek: [entry('m', [], { maxTokens: 8_000 })],
            gw1: [entry('m', [], { maxTokens: 8_000 })],
            gw2: [entry('m', [], { maxTokens: 8_000 })],
            gw3: [entry('m')],
            gw4: [entry('m')],
        })
        check('loose 容量分位不受官方权重展开影响', lookup(withOfficial, 'relay', 'm', true)?.maxTokens === 8_000, lookup(withOfficial, 'relay', 'm', true))
        // 安全 N 宁小勿大：官方值最大但非官方候选占多数时，N 取多数侧的小值
        const officialLarger = indexed({
            deepseek: [entry('m', [], { contextWindow: 1_000_000 })],
            gw1: [entry('m', [], { contextWindow: 100_000 })],
            gw2: [entry('m', [], { contextWindow: 100_000 })],
            gw3: [entry('m', [], { contextWindow: 100_000 })],
        })
        check('loose 安全 N 宁小勿大（官方大值不主导）', lookup(officialLarger, 'relay', 'm', true)?.contextWindow === 100_000, lookup(officialLarger, 'relay', 'm', true))
        // efforts 逐档 60%：low 4/5 √、high 3/5=60% √、medium 2/5 ×
        const efforts = indexed({
            gw1: [entry('m', ['low', 'high'])],
            gw2: [entry('m', ['low', 'high', 'medium'])],
            gw3: [entry('m', ['low', 'high'])],
            gw4: [entry('m', ['low', 'medium'])],
            gw5: [entry('m', ['low'])],
        })
        const looseEfforts = lookup(efforts, 'relay', 'm', true)
        check('loose efforts 逐档 60% 取值', stable(looseEfforts?.efforts) === stable(['low', 'high']), looseEfforts)
        // image：≥60% 为 true 才写
        const images = indexed({
            gw1: [entry('m', [], { image: true })],
            gw2: [entry('m', [], { image: true })],
            gw3: [entry('m', [], { image: true })],
            gw4: [entry('m')],
            gw5: [entry('m')],
        })
        check('loose image 60% 为 true 才写', lookup(images, 'relay', 'm', true)?.image === true, lookup(images, 'relay', 'm', true))
        // 全字段不达标 -> undefined（合成返回空，特征形同虚设时不硬填）
        const none = indexed({ gw1: [entry('m')], gw2: [entry('m', ['xhigh'])], gw3: [entry('m')] })
        check('loose 全字段不达标 -> undefined', lookup(none, 'relay', 'm', true) === undefined, lookup(none, 'relay', 'm', true))
        // 彻底无命中：includes 扩展兜底——裸名不吃精确匹配时按子串捞候选；扩展候选同样过合成
        const fuzzy = indexed({ deepseek: [entry('deepseek-v4-flash', ['high'], { contextWindow: 100_000 })], gw1: [entry('deepseek-v4-flash-0731', [], { contextWindow: 80_000 })], gw2: [entry('deepseek-v4-flash-0423')] })
        const fuzzyHit = lookup(fuzzy, 'relay', 'deepseek-v4-f', true)
        // 分位数 [80000,100000] 取 60% 位（累计 ≥60% 的位置）为 100000
        check('loose 无命中时 includes 扩展候选', fuzzyHit?.contextWindow === 100_000, fuzzyHit)
        // loose 关闭时同样的模糊查询仍无命中（扩展只在 loose 开启时发生）
        check('loose 关闭时无命中仍无扩展', lookup(fuzzy, 'relay', 'deepseek-v4-f', false) === undefined)
    }

    // ---------- 命名空间前缀：聚合网关给 id 加自建命名空间（cn:deepseek-v4-pro），目录里只有裸名 ----------
    check('stripNamespace 剥前导命名空间', stripNamespace('cn:deepseek-v4-pro') === 'deepseek-v4-pro', stripNamespace('cn:deepseek-v4-pro'))
    check('stripNamespace 无前缀原样返回', stripNamespace('deepseek-chat') === 'deepseek-chat')
    // 后缀冒号是模型自带 tag（`kenari/hy3:free`），不得当命名空间剥
    check('stripNamespace 不碰后缀冒号', stripNamespace('kenari/hy3:free') === 'kenari/hy3:free', stripNamespace('kenari/hy3:free'))
    check('剥前缀后命中', lookup(catalog({ deepseek: ['deepseek-v4-pro'] }), 'custom-router', 'cn:deepseek-v4-pro')?.id === 'deepseek-v4-pro')
    check('剥前缀后走官方提示组（不被别家镜像抢）', lookup(
        catalog({ deepseek: ['deepseek-v4-pro'], aihubmix: ['deepseek-v4-pro'] }), 'custom-ai', 'cn:deepseek-v4-pro',
    )?.id === 'deepseek-v4-pro')
    // 目录 id 自身带前缀时，剥前缀不得破坏其完整 id 匹配
    check('目录 id 带前缀不受剥前缀影响', lookup(catalog({ deepinfra: ['tencent/Hy3'] }), 'deepinfra', 'tencent/Hy3')?.id === 'tencent/Hy3')

    // ---------- 显示名兜底：id 全线失配时用「设置→模型」里的显示名（Deepseek-V4-Pro）再试一次 ----------
    check('id 失配 -> 显示名兜底命中', lookup(catalog({ deepseek: ['deepseek-v4-pro'] }), 'custom-router', 'cn:unknown-pro', false, 'Deepseek-V4-Pro')?.id === 'deepseek-v4-pro')
    check('显示名空格与大小写归一', lookup(catalog({ deepseek: ['deepseek-v4-pro'] }), 'custom-router', 'nope', false, 'DeepSeek V4 Pro')?.id === 'deepseek-v4-pro', lookup(catalog({ deepseek: ['deepseek-v4-pro'] }), 'custom-router', 'nope', false, 'DeepSeek V4 Pro'))
    check('显示名兜底要求唯一命中', lookup(catalog({ a: ['hy4-preview'], b: ['hy4-preview'] }), 'custom-router', 'zzz', false, 'Hy4 Preview') === undefined)
    check('id 命中优先于显示名', lookup(catalog({ deepseek: ['deepseek-v4-pro'], openai: ['gpt-5'] }), 'deepseek', 'deepseek-v4-pro', false, 'GPT-5')?.id === 'deepseek-v4-pro')
    check('显示名兜底优先本提供方组', lookup(catalog({ venice: ['kimi-k3'], moonshotai: ['kimi-k3-turbo'] }), 'venice', 'zzz', false, 'Kimi K3')?.id === 'kimi-k3')
    check('空显示名不影响 id 匹配', lookup(catalog({ deepseek: ['deepseek-chat'] }), 'deepseek', 'deepseek-chat', false, '')?.id === 'deepseek-chat')

    // ---------- toReasoningEfforts：none/off 映射到 off 键，保留目录原值而非 null ----------
    check('efforts 映射与 none 转 off（保留原值 none）', stable(toReasoningEfforts(entry('m', ['none', 'low', 'high']))) === stable({ off: 'none', low: 'low', high: 'high' }), toReasoningEfforts(entry('m', ['none', 'low', 'high'])))
    check('efforts 映射与 off 保留原值', stable(toReasoningEfforts(entry('m', ['off', 'low', 'high']))) === stable({ off: 'off', low: 'low', high: 'high' }), toReasoningEfforts(entry('m', ['off', 'low', 'high'])))
    check('无条目 -> undefined', toReasoningEfforts(undefined) === undefined)
    check('空档位 -> undefined', toReasoningEfforts(entry('m', [])) === undefined)
    check('仅剩 off -> 视为无匹配', toReasoningEfforts(entry('m', ['none'])) === undefined && toReasoningEfforts(entry('m', ['off'])) === undefined)

    // ---------- collectCandidates：下拉候选（三种精确键 + 同族变体），只列不判 ----------
    const pool = catalog({
        openrouter: ['z-ai/glm-5.3-flash-free', 'z-ai/glm-5.3-flash-thinking', 'z-ai/glm-5.3-flash', 'z-ai/glm-5.3', 'z-ai/glm-5'],
        zai: ['glm-5.3-flash'],
    })
    const keysOf = (providerId: string, modelId: string, name?: string): string[] =>
        collectCandidates(pool, providerId, modelId, name).map((candidate) => candidate.key)
    // 基准：本提供方的精确命中排第一（其余按目录顺序跟在后面）
    check('候选：精确命中并本提供方优先', keysOf('zai', 'cn:glm-5.3-flash')[0] === 'zai/glm-5.3-flash', keysOf('zai', 'cn:glm-5.3-flash').join('|'))
    // 目录 id 带 `<厂商>/` 前缀时不算精确命中，但仍是同族，必须列出（且不重复）
    check('候选：带斜杠前缀的同名条目也列出', keysOf('zai', 'cn:glm-5.3-flash').includes('openrouter/z-ai/glm-5.3-flash'), keysOf('zai', 'cn:glm-5.3-flash').join('|'))
    // 变体：免费渠道那条 id 更长，包含关键字，必须出现在下拉里（用户点名的 glm-5.3-flash-free 场景）
    check('候选：同族变体（-free）也列出', keysOf('zai', 'cn:glm-5.3-flash').includes('openrouter/z-ai/glm-5.3-flash-free'), keysOf('zai', 'cn:glm-5.3-flash').join('|'))
    check('候选：同族变体（-thinking）也列出', keysOf('zai', 'cn:glm-5.3-flash').includes('openrouter/z-ai/glm-5.3-flash-thinking'), keysOf('zai', 'cn:glm-5.3-flash').join('|'))
    // 上一代版本是另一个模型，不是同模型的另一渠道：glm-5.3-flash 不得收 glm-5.3，glm-5.3 更不得收 glm-5
    check('候选：不收上一代父版本（glm-5.3-flash ↛ glm-5.3）', !keysOf('zai', 'cn:glm-5.3-flash').includes('openrouter/z-ai/glm-5.3'), keysOf('zai', 'cn:glm-5.3-flash').join('|'))
    check('候选：不收上一代父版本（glm-5.3 ↛ glm-5）', !keysOf('zai', 'cn:glm-5.3').includes('openrouter/z-ai/glm-5'), keysOf('zai', 'cn:glm-5.3').join('|'))
    check('候选：同族变体只差限定词时保留（glm-5.3-flash 自身可被 glm-5.3 选中）', keysOf('zai', 'cn:glm-5.3-flash-free').includes('zai/glm-5.3-flash'), keysOf('zai', 'cn:glm-5.3-flash-free').join('|'))
    // 变体不得混进自动匹配：lookup 仍然只认精确/词干/前缀
    check('变体不参与自动匹配', lookup(pool, 'zai', 'glm-5.3-flash-free') === undefined, lookup(pool, 'zai', 'glm-5.3-flash-free')?.id)
    // 太短的键（hy3）不做包含扫描：否则整片目录都会被收进来
    check('候选：短键不做变体扫描', keysOf('custom', 'cn:hy3').length === 0, keysOf('custom', 'cn:hy3').join('|'))
    check('候选：目录里根本没有时为空', keysOf('zai', 'cn:totally-unknown').length === 0)
    // 截断与折叠：同 id 形态 + 同参数的 30 家镜像折叠成一行（`also` 记账），不占满名额
    const many = catalog(Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`p${index}`, ['glm-5.3-flash']] as const)))
    const manyRows = collectCandidates(many, 'p0', 'glm-5.3-flash')
    check('候选：同值镜像折叠成一行', manyRows.length === 1 && manyRows[0]?.also.length === 29, `${manyRows.length}/${manyRows[0]?.also.length}`)
    check('候选：折叠后仍保留本提供方为代表', manyRows[0]?.key === 'p0/glm-5.3-flash', manyRows[0]?.key)
    // 来源键回取：目录刷新后条目消失即回落到自动匹配
    check('来源键取条目', entryBySourceKey(pool, sourceKey('openrouter', 'z-ai/glm-5.3-flash-free'))?.id === 'z-ai/glm-5.3-flash-free')
    check('来源键形状不对 -> undefined', entryBySourceKey(pool, 'noslash') === undefined && entryBySourceKey(pool, 'a/') === undefined && entryBySourceKey(pool, '/x') === undefined)
    check('来源键指向已消失的条目 -> undefined', entryBySourceKey(pool, 'openrouter/gone') === undefined)
    check('来源键提供方不存在 -> undefined', entryBySourceKey(pool, 'nobody/glm-5.3') === undefined)
}
