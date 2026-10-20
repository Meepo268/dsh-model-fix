/** 「参数来源」纯函数测试：pin 优先级、陈旧 pin 回落、候选列表与弹层快照（`src/source.ts`） */

import { check } from '@test/helper'
import { DEFAULT_CONFIG } from '@/shared/config-schema'
import { SOURCE_UPSTREAM, type PluginConfig } from '@/shared/types'
import type { DeclarationMap } from '@/upstream'
import type { IndexedCatalog, IndexEntry } from '@/types'
import { buildSourceSnapshot, resolveSource } from '@/source'
import { candidateSummary, capacityText, fitLabel } from '@/shared/source-view'
import { sourceKey } from '@/lookup'

/** 套件入口（	est/index.ts 注册） */
export function run(): void {

/** 合成组：`entry(id)` 造一条目录条目，组内按归一 id 建索引 */
function group(entries: IndexEntry[]) {
    return { ids: entries.map((entry) => entry.id), byId: new Map(entries.map((entry) => [entry.id, entry])) }
}

function index(): IndexedCatalog {
    return {
        catalog: {},
        groups: new Map([
            ['deepseek', group([{ id: 'deepseek-v4-pro', efforts: ['low', 'high', 'max'], contextWindow: 1048576, maxTokens: 393216, image: false }])],
            ['acme', group([{ id: 'glm-5.3', efforts: ['low', 'medium', 'high'], contextWindow: 131072, maxTokens: 32768, image: true }])],
        ]),
    }
}

function cfg(overrides: Partial<PluginConfig> = {}): PluginConfig {
    return { ...DEFAULT_CONFIG, ...overrides }
}

function declarations(provider: string, model: string, fields: Parameters<typeof Object.assign>[0]): DeclarationMap {
    return new Map([[provider, new Map([[model, fields]])]])
}

const UPSTREAM = declarations('gw', 'cn:deepseek-v4-pro', { efforts: ['high', 'xhigh'], contextWindow: 1000000, maxTokens: 128000, image: true })

/** 1. 自动：有上游声明时以声明为准，目录条目同留（逐字段回落要它） */
{
    const resolved = resolveSource(cfg(), index(), UPSTREAM, 'gw', 'cn:deepseek-v4-pro')
    check('自动：pin 为空', resolved.pin === '')
    check('自动：上游声明生效', resolved.declared?.contextWindow === 1000000 && resolved.declared?.maxTokens === 128000)
    check('自动：目录条目同留', resolved.entry?.contextWindow === 1048576)
}

/** 2. 自动：无声明时按命名空间剥离后的目录命中 */
{
    const resolved = resolveSource(cfg(), index(), undefined, 'gw', 'cn:deepseek-v4-pro')
    check('自动无声明：走目录', resolved.entry?.id === 'deepseek-v4-pro' && resolved.declared === undefined)
}

/** 3. pin = upstream：只认声明，目录命中被丢弃，但声明缺失时条目也不补 */
{
    const pinned = cfg({ sources: { gw: { 'cn:deepseek-v4-pro': SOURCE_UPSTREAM } } })
    const resolved = resolveSource(pinned, index(), UPSTREAM, 'gw', 'cn:deepseek-v4-pro')
    check('pin upstream：pin 回读', resolved.pin === SOURCE_UPSTREAM)
    check('pin upstream：丢弃目录', resolved.entry === undefined)
    check('pin upstream：保留声明', resolved.declared?.contextWindow === 1000000)
    const bare = resolveSource(cfg({ sources: { gw: { 'cn:deepseek-v4-pro': SOURCE_UPSTREAM } } }), index(), undefined, 'gw', 'cn:deepseek-v4-pro')
    check('pin upstream 无声明：两侧皆空', bare.entry === undefined && bare.declared === undefined)
}

/** 4. pin = provider/id：只认该目录条目，声明不参与 */
{
    const pinned = cfg({ sources: { gw: { 'cn:mystery': sourceKey('acme', 'glm-5.3') } } })
    const resolved = resolveSource(pinned, index(), declarations('gw', 'cn:mystery', { contextWindow: 1 }), 'gw', 'cn:mystery')
    check('pin 目录：命中指定条目', resolved.entry?.id === 'glm-5.3')
    check('pin 目录：不取上游声明', resolved.declared === undefined)
    check('pin 目录：pin 回读', resolved.pin === 'acme/glm-5.3')
}

/** 5. 陈旧 pin（目录刷新后条目没了）回落自动，且不把失效键回显成生效 pin */
{
    const stale = cfg({ sources: { gw: { 'cn:deepseek-v4-pro': 'gone/vanished' } } })
    const resolved = resolveSource(stale, index(), UPSTREAM, 'gw', 'cn:deepseek-v4-pro')
    check('陈旧 pin：回落自动（pin 归空）', resolved.pin === '')
    check('陈旧 pin：按自动取声明', resolved.declared?.contextWindow === 1000000)
    check('陈旧 pin：按自动取目录', resolved.entry?.id === 'deepseek-v4-pro')
}

/** 6. 快照：逐模型给出 pin、取胜来源、声明、候选与现值；排除项打标 */
{
    const pinned = cfg({ sources: { acme: { 'glm-5.3': sourceKey('deepseek', 'deepseek-v4-pro') } }, excludes: ['skipme'] })
    const providers = {
        gw: { models: [{ id: 'cn:deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1000000, maxTokens: 128000, reasoningEfforts: { high: 'high', xhigh: 'xhigh' } }] },
        acme: { models: [{ id: 'glm-5.3', contextWindow: 999 }] },
        skipme: { models: [{ id: 'anything' }] },
        broker: { models: [] },
    }
    const snapshot = buildSourceSnapshot(pinned, providers, index(), UPSTREAM)
    check('快照：跳过空 models 的提供方', snapshot.providers.map((row) => row.id).join(',') === 'gw,acme,skipme')
    const gw = snapshot.providers[0].models[0]
    check('快照：自动行取上游（目录条目仍留作逐字段回落）', gw.source === 'upstream' && gw.matchedKey === 'deepseek/deepseek-v4-pro')
    check('快照：上游四字段', gw.upstream?.contextWindow === 1000000 && gw.upstream?.efforts === 'high / xhigh' && gw.upstream.image === true)
    check('快照：现值四字段', gw.current.contextWindow === 1000000 && gw.current.efforts === 'high / xhigh' && gw.current.image === false)
    check('快照：候选含两家', gw.candidates.length === 1 && gw.candidates[0].key === 'deepseek/deepseek-v4-pro')
    const acme = snapshot.providers[1].models[0]
    check('快照：pin 目录行按 pin 记账', acme.source === 'catalog' && acme.matchedKey === 'deepseek/deepseek-v4-pro')
    check('快照：pin 条目补进候选首位', acme.candidates[0]?.key === 'deepseek/deepseek-v4-pro')
    check('快照：pin 回显', acme.pin === 'deepseek/deepseek-v4-pro')
    check('快照：排除标记', snapshot.providers[2].models[0].excluded === true && gw.excluded === false)
    check('快照：无来源行', buildSourceSnapshot(cfg(), { gw: { models: [{ id: 'mystery' }] } }, index(), undefined).providers[0].models[0].source === 'none')

    // ---------- 候选选项的一行摘要：容量压短、档位省宽、超长截断 ----------
    check('容量：百万压成 M', capacityText(1_000_000) === '1M' && capacityText(1_048_576) === '1M', capacityText(1_048_576))
    check('容量：千压成 K', capacityText(128_000) === '128K' && capacityText(512_000) === '512K' && capacityText(64_000) === '64K')
    check('容量：无值/哨兵/0 -> 空串', capacityText(undefined) === '' && capacityText(0) === '' && capacityText(99_999_999) === '')
    check('摘要：容量/档位/图片', candidateSummary({ efforts: 'low / high', contextWindow: 1_000_000, maxTokens: 128_000, image: true }) === '1M/128K · low/high · 图')
    check('摘要：缺项跳过 + 图片标记可换', candidateSummary({ efforts: '', image: true }, 'img') === 'img' && candidateSummary({ efforts: '', image: false }) === '')
    check('截断：不超长原样返回', fitLabel('abc', 3) === 'abc')
    check('截断：超长补省略号', fitLabel('abcdef', 4) === 'abc…', fitLabel('abcdef', 4))
}
}
