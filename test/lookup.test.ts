// lookup.ts 纯函数测试：模型 id 匹配（精确/词干/前缀三级）、端点/提供方/全局三级级联与推理级别转换
import { lookup, normalizeId, toReasoningEfforts } from '@/lookup'
import type { IndexedCatalog, IndexEntry } from '@/types'
import { check, stable } from '@test/helper'

/** 构造目录条目（第三参补容量等其余字段） */
function entry(id: string, efforts: string[] = [], extra: Partial<IndexEntry> = {}): IndexEntry {
    return { id, efforts, ...extra }
}

/** 构造分组索引（匹配键按 lookup 的归一规则建，与 catalog.ts 建索引同口径）；第二参为端点索引 */
function indexed(groups: Record<string, IndexEntry[]>, endpoints: Record<string, string[]> = {}): IndexedCatalog {
    return {
        catalog: {},
        groups: new Map(Object.entries(groups).map(([provider, entries]) => [provider, {
            ids: entries.map((item) => normalizeId(item.id)),
            byId: new Map(entries.map((item) => [normalizeId(item.id), item])),
        }])),
        endpoints: new Map(Object.entries(endpoints)),
    }
}

/** 以模型 id 列表构造分组索引 */
function catalog(groups: Record<string, string[]>): IndexedCatalog {
    return indexed(Object.fromEntries(Object.entries(groups).map(([provider, ids]) => [provider, ids.map((id) => entry(id))])))
}

/** 执行本文件的全部用例 */
export function run(): void {
    // ---------- 精确匹配（含归一化：大小写、-latest/-openai-compact 后缀噪音） ----------
    check('lookup 精确命中', lookup(catalog({ deepseek: ['deepseek-chat'] }), 'deepseek', undefined, 'deepseek-chat')?.id === 'deepseek-chat')
    check('lookup 归一化大小写', lookup(catalog({ deepseek: ['deepseek-chat'] }), 'deepseek', undefined, 'DeepSeek-Chat')?.id === 'deepseek-chat')
    check('lookup 去 -latest 后缀', lookup(catalog({ openai: ['gpt-5'] }), 'openai', undefined, 'gpt-5-latest')?.id === 'gpt-5')
    check('lookup 去 -openai-compact 后缀', lookup(catalog({ openai: ['gpt-5'] }), 'openai', undefined, 'gpt-5-openai-compact')?.id === 'gpt-5')

    // ---------- 提供方 id 失败时全局匹配 ----------
    check('provider 不在目录 -> 全局唯一命中', lookup(catalog({ deepseek: ['deepseek-chat'] }), 'custom-router', undefined, 'deepseek-chat')?.id === 'deepseek-chat')
    check('provider 命中但模型不在 -> 全局唯一命中', lookup(catalog({ deepseek: ['deepseek-reasoner'], anthropic: ['claude-sonnet-4'] }), 'deepseek', undefined, 'claude-sonnet-4')?.id === 'claude-sonnet-4')

    // ---------- 目录 id 自带命名空间前缀（目录中过半 id 如此）：完整 id 必须先在组内命中 ----------
    check('目录 id 带前缀 -> 完整 id 组内命中', lookup(catalog({ deepinfra: ['tencent/Hy3'] }), 'deepinfra', undefined, 'tencent/Hy3')?.id === 'tencent/Hy3')
    check('目录 id 带前缀 -> 匹配大小写无关', lookup(catalog({ deepinfra: ['tencent/Hy3'] }), 'deepinfra', undefined, 'TENCENT/hy3')?.id === 'tencent/Hy3')
    check('本地带前缀而目录不带 -> 仍退回裸名命中', lookup(catalog({ zai: ['glm-5'] }), 'zai', undefined, 'z-ai/glm-5')?.id === 'glm-5')
    // 末段唯一匹配：provider 严格匹配即已定域，裸名等于目录 id 末段且唯一时收下
    check('provider 严格匹配 + 裸名等于唯一末段 -> 命中', lookup(catalog({ deepinfra: ['tencent/Hy3'] }), 'deepinfra', undefined, 'Hy3')?.id === 'tencent/Hy3')
    check('末段匹配大小写无关', lookup(catalog({ deepinfra: ['tencent/Hy3'] }), 'deepinfra', undefined, 'hy3')?.id === 'tencent/Hy3')
    check('末段多个不同条目 -> 判歧义无匹配', lookup(catalog({ deepinfra: ['a/Hy3', 'b/Hy3'] }), 'deepinfra', undefined, 'Hy3') === undefined)
    check('provider 不在目录时不启用末段匹配 -> 全局兜底多命中仍无匹配', lookup(catalog({ deepinfra: ['tencent/Hy3'], other: ['tencent/Hy3'] }), 'custom-router', undefined, 'Hy3') === undefined)
    check('末段匹配不跨提供方错配（他组同末段条目不得入选）', lookup(catalog({ deepinfra: ['tencent/Hy3'], 'tencent-tokenhub': ['hy3'] }), 'deepinfra', undefined, 'Hy3')?.id === 'tencent/Hy3')

    // ---------- 跨提供方不错配：同名条目在多家网关重复，兜底须过唯一性门槛 ----------
    check('兜底多命中 -> 判歧义无匹配', lookup(catalog({ a: ['Hy3'], b: ['Hy3'] }), 'custom-router', undefined, 'Hy3') === undefined)
    check('兜底唯一命中 -> 放行', lookup(catalog({ a: ['Hy3'] }), 'custom-router', undefined, 'Hy3')?.id === 'Hy3')
    check('带前缀 id 命中本组参数而非他组同名条目', lookup(
        indexed({ 'tencent-tokenhub': [entry('hy3', [], { contextWindow: 256000 })], deepinfra: [entry('tencent/Hy3', [], { contextWindow: 262144 })] }),
        'deepinfra', undefined, 'tencent/Hy3',
    )?.contextWindow === 262144)

    // ---------- 端点优先：baseURL 命中即在该端点的提供方集合内匹配 ----------
    const EP = 'https://api.deepseek.com'
    check('端点命中：路由 id 不符也按端点命中', lookup(
        indexed({ deepseek: [entry('deepseek-flash', ['high'], { contextWindow: 100_000 })] }, { [EP]: ['deepseek'] }),
        'custom-route', EP, 'deepseek-flash',
    )?.contextWindow === 100_000)
    check('端点命中：域已定，组外同名条目不参与', lookup(
        indexed({ deepseek: [entry('m', ['high'])], other: [entry('m', ['low'])] }, { [EP]: ['deepseek'] }),
        'custom-route', EP, 'm',
    )?.efforts[0] === 'high')
    check('端点严格匹配：差一个字符即失去定域（不归一）', lookup(
        indexed({ a: [entry('m', ['high'])], b: [entry('m', ['low'])] }, { 'https://x/': ['a'] }),
        'relay', 'https://x', 'm',
    ) === undefined)
    check('端点未命中：回落到提供方 id', lookup(
        indexed({ deepseek: [entry('deepseek-flash', ['high'])] }, { [EP]: ['deepseek'] }),
        'deepseek', 'https://other.example', 'deepseek-flash',
    )?.id === 'deepseek-flash')

    // ---------- 同一端点挂多个提供方：模型唯一，分歧只在参数 ----------
    const DUP = 'https://api.minimax.io/anthropic/v1'
    const dupGroups = {
        minimax: [entry('mm', ['low', 'high'], { contextWindow: 262144, maxTokens: 32768 })],
        'minimax-coding-plan': [entry('mm', ['low', 'high', 'max'], { contextWindow: 262144, maxTokens: 262144 })],
    }
    check('同端点多提供方：路由 id 裁决', lookup(
        indexed(dupGroups, { [DUP]: ['minimax', 'minimax-coding-plan'] }), 'minimax', DUP, 'mm',
    )?.maxTokens === 32768)
    check('同端点多提供方：无名则保守合并（容量取小、档位取交集）', lookup(
        indexed(dupGroups, { [DUP]: ['minimax', 'minimax-coding-plan'] }), 'relay', DUP, 'mm',
    )?.maxTokens === 32768)
    check('同端点多提供方：保守合并的档位取交集', stable(lookup(
        indexed(dupGroups, { [DUP]: ['minimax', 'minimax-coding-plan'] }), 'relay', DUP, 'mm',
    )?.efforts) === stable(['low', 'high']))
    check('同端点多提供方：图片需全支持才写', lookup(
        indexed({
            a: [entry('m', [], { image: true })],
            b: [entry('m')],
        }, { 'https://x/': ['a', 'b'] }), 'relay', 'https://x/', 'm',
    )?.image === undefined)

    // ---------- 词干匹配：去版本日期/长数字段后唯一命中 ----------
    check('词干剥离日期后缀', lookup(catalog({ deepseek: ['deepseek-chat-20250901'] }), 'deepseek', undefined, 'deepseek-chat')?.id === 'deepseek-chat-20250901')
    check('词干剥离长数字段', lookup(catalog({ deepseek: ['deepseek-chat-v3.1-2508'] }), 'deepseek', undefined, 'deepseek-chat')?.id === 'deepseek-chat-v3.1-2508')

    // ---------- digits 区分：同 base 多日期变体，凭 digits 精确命中而非歧义 undefined ----------
    check('digits 区分 8 位日期', lookup(catalog({ openai: ['gpt-5-20240813', 'gpt-5-20241120'] }), 'openai', undefined, 'gpt-5-20240813')?.id === 'gpt-5-20240813')
    check('digits 区分 4 位 MMDD', lookup(catalog({ openai: ['gpt-5-0813', 'gpt-5-1120'] }), 'openai', undefined, 'gpt-5-0813')?.id === 'gpt-5-0813')
    check('digits 区分 MM-DD', lookup(catalog({ openai: ['gpt-5-08-13', 'gpt-5-11-20'] }), 'openai', undefined, 'gpt-5-08-13')?.id === 'gpt-5-08-13')
    check('digits 区分 YYYY-MM-DD', lookup(catalog({ openai: ['gpt-5-2024-08-13', 'gpt-5-2024-11-20'] }), 'openai', undefined, 'gpt-5-2024-08-13')?.id === 'gpt-5-2024-08-13')
    // 数字串归一化：仅连字符写法不同的同日期（08-31 与 0831、2024-08-31 与 20240831）视作同一 digits
    check('digits 归一化 08-31 == 0831', lookup(catalog({ openai: ['gpt-5-08-13', 'gpt-5-11-20'] }), 'openai', undefined, 'gpt-5-0813')?.id === 'gpt-5-08-13')
    check('digits 归一化 2024-08-31 == 20240831', lookup(catalog({ openai: ['gpt-5-20240813', 'gpt-5-20241120'] }), 'openai', undefined, 'gpt-5-2024-08-13')?.id === 'gpt-5-20240813')
    check('digits 不同不误配', lookup(catalog({ openai: ['gpt-5-20240813', 'gpt-5-20241120'] }), 'openai', undefined, 'gpt-5-20240814') === undefined)
    // 本地带日期、目录有同 base 裸名 + 异日期变体：digits 比对排除异日期，仅裸名命中
    check('digits 排除异日期留裸名', lookup(catalog({ openai: ['gpt-5', 'gpt-5-20241120'] }), 'openai', undefined, 'gpt-5-20240813')?.id === 'gpt-5')
    // ---------- 中缀日期：日期夹在 id 中段（非末尾）同样提取并区分 ----------
    check('中缀日期精确命中', lookup(catalog({ openai: ['gpt-5-20240831-preview', 'gpt-5-20241120-preview'] }), 'openai', undefined, 'gpt-5-20240831-preview')?.id === 'gpt-5-20240831-preview')
    check('中缀日期变体凭 digits 区分', lookup(catalog({ openai: ['gpt-5-preview', 'gpt-5-20241120-preview'] }), 'openai', undefined, 'gpt-5-20240831-preview')?.id === 'gpt-5-preview')
    check('中缀日期多变体无裸名 -> 无匹配', lookup(catalog({ openai: ['gpt-5-20240831-preview', 'gpt-5-20241120-preview'] }), 'openai', undefined, 'gpt-5-preview') === undefined)

    // ---------- 前缀匹配：目录 id 以本地 id 加分隔符扩展时唯一命中 ----------
    check('前缀匹配唯一命中', lookup(catalog({ openai: ['gpt-5-mini'] }), 'openai', undefined, 'gpt-5')?.id === 'gpt-5-mini')

    // ---------- 歧义不猜：词干/前缀命中多个或零个 -> 无匹配 ----------
    check('词干命中多个 -> 无匹配', lookup(catalog({ openai: ['gpt-5-mini', 'gpt-5-turbo'] }), 'openai', undefined, 'gpt-5') === undefined)
    check('前缀命中多个 -> 无匹配', lookup(catalog({ openai: ['gpt-5-mini', 'gpt-5-nano'] }), 'openai', undefined, 'gpt-5') === undefined)
    check('完全无命中 -> undefined', lookup(catalog({ openai: ['gpt-5'] }), 'openai', undefined, 'o3') === undefined)

    // ---------- 尽量匹配（loose=true）：多命中合成，无命中则 includes 扩展 ----------
    // 容量取「有值候选」的 60 分位（宁小勿大）；efforts / image 按候选占比计
    check('loose 关闭时歧义仍放弃（守卫）', lookup(catalog({ a: ['Hy3'], b: ['Hy3'] }), 'custom-router', undefined, 'Hy3', false) === undefined)
    {
        // 容量安全 N：5 家候选 ctx 分别 10/10/10/9/8（万），升序累计票数首次 ≥60% 的值即 10（60% 以上候选 ≤ 10）
        const ctx = indexed({
            gw1: [entry('m', [], { contextWindow: 100_000 })],
            gw2: [entry('m', [], { contextWindow: 100_000 })],
            gw3: [entry('m', [], { contextWindow: 100_000 })],
            gw4: [entry('m', [], { contextWindow: 90_000 })],
            gw5: [entry('m', [], { contextWindow: 80_000 })],
        })
        const looseCtx = lookup(ctx, 'relay', undefined, 'm', true)
        check('loose 容量取 60 分位安全 N', looseCtx?.contextWindow === 100_000, looseCtx)
        // 容量分位数基于有值候选（无值候选不占位）：仅 2/5 家有值时仍取分位，不再判「支持率不足」
        const maxT = indexed({
            gw1: [entry('m', [], { maxTokens: 8_000 })],
            gw2: [entry('m', [], { maxTokens: 8_000 })],
            gw3: [entry('m')],
            gw4: [entry('m')],
            gw5: [entry('m')],
        })
        check('loose 容量分位只算有值候选', lookup(maxT, 'relay', undefined, 'm', true)?.maxTokens === 8_000, lookup(maxT, 'relay', undefined, 'm', true))
        // 分位只在候选粒度上算，不按提供方身份加权
        const withOfficial = indexed({
            deepseek: [entry('m', [], { maxTokens: 8_000 })],
            gw1: [entry('m', [], { maxTokens: 8_000 })],
            gw2: [entry('m', [], { maxTokens: 8_000 })],
            gw3: [entry('m')],
            gw4: [entry('m')],
        })
        check('loose 容量分位不受提供方身份影响', lookup(withOfficial, 'relay', undefined, 'm', true)?.maxTokens === 8_000, lookup(withOfficial, 'relay', undefined, 'm', true))
        // 安全 N 宁小勿大：某个候选值最大但非多数侧时，N 取多数侧的小值
        const officialLarger = indexed({
            deepseek: [entry('m', [], { contextWindow: 1_000_000 })],
            gw1: [entry('m', [], { contextWindow: 100_000 })],
            gw2: [entry('m', [], { contextWindow: 100_000 })],
            gw3: [entry('m', [], { contextWindow: 100_000 })],
        })
        check('loose 安全 N 宁小勿大（大值不主导）', lookup(officialLarger, 'relay', undefined, 'm', true)?.contextWindow === 100_000, lookup(officialLarger, 'relay', undefined, 'm', true))
        // efforts 逐档 60%：low 4/5 √、high 3/5=60% √、medium 2/5 ×
        const efforts = indexed({
            gw1: [entry('m', ['low', 'high'])],
            gw2: [entry('m', ['low', 'high', 'medium'])],
            gw3: [entry('m', ['low', 'high'])],
            gw4: [entry('m', ['low', 'medium'])],
            gw5: [entry('m', ['low'])],
        })
        const looseEfforts = lookup(efforts, 'relay', undefined, 'm', true)
        check('loose efforts 逐档 60% 取值', stable(looseEfforts?.efforts) === stable(['low', 'high']), looseEfforts)
        // image：≥60% 为 true 才写
        const images = indexed({
            gw1: [entry('m', [], { image: true })],
            gw2: [entry('m', [], { image: true })],
            gw3: [entry('m', [], { image: true })],
            gw4: [entry('m')],
            gw5: [entry('m')],
        })
        check('loose image 60% 为 true 才写', lookup(images, 'relay', undefined, 'm', true)?.image === true, lookup(images, 'relay', undefined, 'm', true))
        // 全字段不达标 -> undefined（合成返回空，特征形同虚设时不硬填）
        const none = indexed({ gw1: [entry('m')], gw2: [entry('m', ['xhigh'])], gw3: [entry('m')] })
        check('loose 全字段不达标 -> undefined', lookup(none, 'relay', undefined, 'm', true) === undefined, lookup(none, 'relay', undefined, 'm', true))
        // 彻底无命中：includes 扩展兜底——裸名不吃精确匹配时按子串捞候选；扩展候选同样过合成
        const fuzzy = indexed({ deepseek: [entry('deepseek-v4-flash', ['high'], { contextWindow: 100_000 })], gw1: [entry('deepseek-v4-flash-0731', [], { contextWindow: 80_000 })], gw2: [entry('deepseek-v4-flash-0423')] })
        const fuzzyHit = lookup(fuzzy, 'relay', undefined, 'deepseek-v4-f', true)
        // 分位数 [80000,100000] 取 60% 位（累计 ≥60% 的位置）为 100000
        check('loose 无命中时 includes 扩展候选', fuzzyHit?.contextWindow === 100_000, fuzzyHit)
        // loose 关闭时同样的模糊查询仍无命中（扩展只在 loose 开启时发生）
        check('loose 关闭时无命中仍无扩展', lookup(fuzzy, 'relay', undefined, 'deepseek-v4-f', false) === undefined)
    }

    // ---------- toReasoningEfforts：none/off 映射到 off 键，保留目录原值而非 null ----------
    check('efforts 映射与 none 转 off（保留原值 none）', stable(toReasoningEfforts(entry('m', ['none', 'low', 'high']))) === stable({ off: 'none', low: 'low', high: 'high' }), toReasoningEfforts(entry('m', ['none', 'low', 'high'])))
    check('efforts 映射与 off 保留原值', stable(toReasoningEfforts(entry('m', ['off', 'low', 'high']))) === stable({ off: 'off', low: 'low', high: 'high' }), toReasoningEfforts(entry('m', ['off', 'low', 'high'])))
    check('无条目 -> undefined', toReasoningEfforts(undefined) === undefined)
    check('空档位 -> undefined', toReasoningEfforts(entry('m', [])) === undefined)
    check('仅剩 off -> 视为无匹配', toReasoningEfforts(entry('m', ['none'])) === undefined && toReasoningEfforts(entry('m', ['off'])) === undefined)
}
