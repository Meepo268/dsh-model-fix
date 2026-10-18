// lookup.ts 纯函数测试：模型 id 匹配（精确/词干/前缀三级）、提供方提示与推理级别转换
import { lookup, normalizeId, toReasoningEfforts } from '@/lookup'
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
    check('glm 前缀提示 zai 依序回落 zhipuai', lookup(catalog({ zhipuai: ['glm-5'] }), 'custom-ai', 'glm-5')?.id === 'glm-5')
    check('minimax 大写裸名小写后命中候选表', lookup(catalog({ minimax: ['MiniMax-M3'] }), 'custom-ai', 'MiniMax-M3')?.id === 'MiniMax-M3')
    check('gemini 前缀提示 google', lookup(catalog({ google: ['gemini-3-flash'] }), 'custom-ai', 'gemini-3-flash')?.id === 'gemini-3-flash')
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

    // ---------- 前缀匹配：目录 id 以本地 id 加分隔符扩展时唯一命中 ----------
    check('前缀匹配唯一命中', lookup(catalog({ openai: ['gpt-5-mini'] }), 'openai', 'gpt-5')?.id === 'gpt-5-mini')

    // ---------- 歧义不猜：词干/前缀命中多个或零个 -> 无匹配 ----------
    check('词干命中多个 -> 无匹配', lookup(catalog({ openai: ['gpt-5-mini', 'gpt-5-turbo'] }), 'openai', 'gpt-5') === undefined)
    check('前缀命中多个 -> 无匹配', lookup(catalog({ openai: ['gpt-5-mini', 'gpt-5-nano'] }), 'openai', 'gpt-5') === undefined)
    check('完全无命中 -> undefined', lookup(catalog({ openai: ['gpt-5'] }), 'openai', 'o3') === undefined)

    // ---------- toReasoningEfforts：none/off 映射到 off 键，保留目录原值而非 null ----------
    check('efforts 映射与 none 转 off（保留原值 none）', stable(toReasoningEfforts(entry('m', ['none', 'low', 'high']))) === stable({ off: 'none', low: 'low', high: 'high' }), toReasoningEfforts(entry('m', ['none', 'low', 'high'])))
    check('efforts 映射与 off 保留原值', stable(toReasoningEfforts(entry('m', ['off', 'low', 'high']))) === stable({ off: 'off', low: 'low', high: 'high' }), toReasoningEfforts(entry('m', ['off', 'low', 'high'])))
    check('无条目 -> undefined', toReasoningEfforts(undefined) === undefined)
    check('空档位 -> undefined', toReasoningEfforts(entry('m', [])) === undefined)
    check('仅剩 off -> 视为无匹配', toReasoningEfforts(entry('m', ['none'])) === undefined && toReasoningEfforts(entry('m', ['off'])) === undefined)
}
