// upstream.ts 纯函数测试：端点 /models 回包解析（档位/容量/模态）、地址拼接、以及声明优先于目录的参数来源取舍
import { modelsUrl, parseDeclarations } from '@/upstream'
import { planFill } from '@/fix'
import { DEFAULT_CONFIG } from '@/shared/config-schema'
import type { PluginConfig } from '@/shared/types'
import type { IndexedCatalog, IndexEntry } from '@/types'
import { check, stable } from '@test/helper'

/** 默认配置（planFill 只读），按需覆盖各组 */
function cfg(overrides: Partial<PluginConfig> = {}): PluginConfig {
    return {
        allowUpdate: { ...DEFAULT_CONFIG.allowUpdate, ...overrides.allowUpdate },
        autoFill: { ...DEFAULT_CONFIG.autoFill, ...overrides.autoFill },
        compat: { ...DEFAULT_CONFIG.compat, ...overrides.compat },
        excludes: overrides.excludes ?? [],
        efforts: overrides.efforts ?? {},
        written: overrides.written ?? {},
        sources: overrides.sources ?? {},
        behavior: { ...DEFAULT_CONFIG.behavior, ...overrides.behavior },
        userExperience: { ...DEFAULT_CONFIG.userExperience, ...overrides.userExperience },
    }
}

/** 单条目目录索引 */
function indexed(entries: IndexEntry[]): IndexedCatalog {
    const ids = entries.map((entry) => entry.id)
    return {
        catalog: {},
        groups: new Map([['gw', { ids, byId: new Map(entries.map((entry) => [entry.id, entry])) }]]),
    }
}

export async function run(): Promise<void> {
    // ---------- 1. 回包解析：网关自报的推理档位（none 折算 off） ----------
    const gateway = parseDeclarations({
        object: 'list',
        data: [
            {
                id: 'cn:deepseek-v4-pro',
                name: 'Deepseek-V4-Pro',
                context_window: 1_000_000,
                max_output_tokens: 128_000,
                input_modalities: ['text', 'image'],
                supports_images: true,
                reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high', 'xhigh'] }],
                reasoning_supported_efforts: ['none', 'low', 'high', 'xhigh'],
                only_reasoning: true,
            },
            { id: 'cn:glm-5.3', context_length: 1_000_000, max_completion_tokens: 64_000, reasoning_supported_efforts: ['low', 'high', 'max'] },
            // 只有 id 的模型不入表（与目录同口径：空壳不参与）
            { id: 'cn:mystery' },
        ],
    })
    check('解析出两个有效条目', gateway.size === 2, [...gateway.keys()])
    const pro = gateway.get('cn:deepseek-v4-pro')
    check('档位保留端点声明（none -> off）', stable(pro?.efforts) === stable(['off', 'low', 'high', 'xhigh']), pro?.efforts)
    check('容量取 context_window / max_output_tokens', pro?.contextWindow === 1_000_000 && pro?.maxTokens === 128_000, pro)
    check('图片取自 input_modalities / supports_images', pro?.image === true)
    const glm = gateway.get('cn:glm-5.3')
    check('容量别名 context_length / max_completion_tokens', glm?.contextWindow === 1_000_000 && glm?.maxTokens === 64_000, glm)
    check('未声明图片则不写 image', glm?.image === undefined)

    // ---------- 2. 其他回包形状与别名 ----------
    const openrouter = parseDeclarations({
        data: [{
            id: 'x/y',
            architecture: { input_modalities: ['text', 'image'] },
            limit: { context: 200_000, output: 16_000 },
            top_provider: { max_completion_tokens: 8_000 },
            supported_parameters: { reasoning_efforts: ['low', 'medium'] },
        }],
    })
    check('OpenRouter 风格别名', openrouter.get('x/y')?.contextWindow === 200_000 && openrouter.get('x/y')?.maxTokens === 16_000, openrouter.get('x/y'))
    check('architecture.input_modalities 判图片', openrouter.get('x/y')?.image === true)
    check('supported_parameters.reasoning_efforts', stable(openrouter.get('x/y')?.efforts) === stable(['low', 'medium']))
    check('裸数组回包可解析', parseDeclarations([{ id: 'a', max_tokens: 1024 }]).get('a')?.maxTokens === 1024)
    check('非对象/缺 id 忽略', parseDeclarations({ data: [null, 'x', { name: 'no-id' }] }).size === 0)
    check('非法容量不采信', parseDeclarations([{ id: 'a', context_window: 0, max_output_tokens: 99_999_999 }]).size === 0)

    // ---------- 3. 地址拼接 ----------
    check('modelsUrl 去尾斜杠', modelsUrl('http://localhost:7001/v1/') === 'http://localhost:7001/v1/models')
    check('modelsUrl 无尾斜杠', modelsUrl('https://api.deepseek.com/v1') === 'https://api.deepseek.com/v1/models')

    // ---------- 4. 参数来源：端点声明优先于目录 ----------
    const declarations = new Map([['gw', new Map([
        ['m1', { efforts: ['low', 'high'], contextWindow: 1_000_000, maxTokens: 128_000, image: true }],
        // m2 只声明容量：档位仍应回落到目录
        ['m2', { contextWindow: 200_000 }],
    ])]])
    const catalog = indexed([
        { id: 'm1', efforts: ['minimal', 'low', 'medium', 'high', 'max'], contextWindow: 999, maxTokens: 1 },
        { id: 'm2', efforts: ['none', 'medium'], contextWindow: 320_000, maxTokens: 4096 },
    ])
    const providers = {
        gw: { baseURL: 'http://x/v1', models: [{ id: 'm1' }, { id: 'm2' }] },
    }
    const plan = planFill(cfg(), providers, catalog, false, declarations)
    const written = (plan.ops[0] as { value: Record<string, unknown>[] }).value
    check('端点档位优先（不并集、不取目录更宽的表）', stable(written[0].reasoningEfforts) === stable({ low: 'low', high: 'high' }), written[0].reasoningEfforts)
    check('端点容量优先', written[0].contextWindow === 1_000_000 && written[0].maxTokens === 128_000, written[0])
    check('端点图片优先', stable(written[0].input) === stable(['text', 'image']), written[0].input)
    check('端点未声明的维度回落目录（容量优先、档位回落）', written[1].contextWindow === 200_000 && stable(written[1].reasoningEfforts) === stable({ off: 'none', medium: 'medium' }), written[1])
    check('端点未声明容量时用目录', written[1].maxTokens === 4096, written[1])

    // 已有值不受影响（allowUpdate 关）：手填优先于任何自动来源
    const existing = planFill(cfg(), { gw: { baseURL: 'http://x/v1', models: [{ id: 'm1', reasoningEfforts: { low: 'low' }, contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'] }] } }, catalog, false, declarations)
    check('手填值不被上游覆盖', existing.ops.length === 0 && existing.changes === 0, existing)
}

