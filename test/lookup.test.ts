// lookup.ts 纯函数测试：模型 id 匹配（精确/词干/前缀三级）、提供方提示与推理级别转换
import { lookup, toReasoningEfforts } from '@/lookup'
import type { IndexedCatalog, IndexEntry } from '@/types'
import { check, stable } from '@test/helper'

/** 构造目录条目 */
function entry(id: string, efforts: string[] = []): IndexEntry {
    return { id, efforts }
}

/** 构造分组索引 */
function catalog(groups: Record<string, string[]>): IndexedCatalog {
    return {
        catalog: {},
        groups: new Map(Object.entries(groups).map(([provider, ids]) => [provider, {
            ids,
            entries: ids.map((id) => entry(id)),
        }])),
    }
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

    // ---------- 官方提供方提示：模型名前缀优先在 hinted 提供方内匹配 ----------
    check(
        '前缀提示优先官方提供方',
        lookup(catalog({ openai: ['gpt-5-mini'], 'custom-ai': ['gpt-5-turbo'] }), 'custom-ai', 'gpt-5-mini')?.id === 'gpt-5-mini',
        lookup(catalog({ openai: ['gpt-5-mini'], 'custom-ai': ['gpt-5-turbo'] }), 'custom-ai', 'gpt-5-mini'),
    )

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
