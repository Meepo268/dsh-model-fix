// source.ts 纯函数测试：候选键反查目录条目、pin 三态解析与陈旧 pin 回落
import { check, stable } from '@test/helper'
import { entryBySourceKey, resolveSource } from '@/source'
import { SOURCE_UPSTREAM, type PluginConfig } from '@/shared/types'
import type { IndexedCatalog, IndexEntry } from '@/types'

const ENTRY: IndexEntry = { id: 'deepseek-v4-pro', efforts: ['low', 'high'], contextWindow: 1_048_576, maxTokens: 393_216, image: true }
const OTHER: IndexEntry = { id: 'glm-5.3', efforts: ['high'], contextWindow: 200_000 }
const MODEL = 'deepseek-v4-pro'

function indexedOf(): IndexedCatalog {
    return {
        catalog: {} as IndexedCatalog['catalog'],
        groups: new Map([
            ['deepseek', { ids: [ENTRY.id], byId: new Map([[ENTRY.id, ENTRY]]) }],
            ['z-ai', { ids: [OTHER.id], byId: new Map([[OTHER.id, OTHER]]) }],
        ]),
        endpoints: new Map(),
    }
}

function cfgWith(sources: Record<string, Record<string, string>>, loose = false, nameFallback = true): PluginConfig {
    return {
        allowUpdate: { reasoning: false, context: false, image: false },
        autoFill: { reasoning: true, context: true, image: true },
        compat: { disableDeveloper: true, disableStore: true },
        excludes: [],
        efforts: {},
        written: {},
        sources,
        behavior: { showInModels: true, showInBuiltinPlugins: true, showInComposer: true, showFollowStatus: true, backToChat: true, showInFloat: true, classicSetting: true },
        userExperience: { rememberEfforts: true, defaultHigh: true, forgetRemoved: true, followParent: false, selfTune: false, hideOfficial: true, localizeEfforts: true, showOriginalEfforts: true, looseMatch: loose, nameFallback },
    }
}

const DECLARATIONS = new Map([['gw', new Map([[MODEL, { efforts: ['high', 'xhigh'], contextWindow: 1_000_000 }]])]])

export function run(): void {
    const indexed = indexedOf()

    // 反查：键形如 `<provider>/<id>`，右半按归一化 id 兜底
    check('entryBySourceKey 命中目录条目', entryBySourceKey(indexed, 'deepseek/deepseek-v4-pro') === ENTRY)
    check('entryBySourceKey 右半可用归一化形态（大小写/后缀）', entryBySourceKey(indexed, 'deepseek/DeepSeek-V4-Pro') === ENTRY)
    check('entryBySourceKey 未分组/畸形键返回 undefined', entryBySourceKey(indexed, 'nope/deepseek-v4-pro') === undefined && entryBySourceKey(indexed, 'deepseek') === undefined && entryBySourceKey(indexed, '/deepseek-v4-pro') === undefined && entryBySourceKey(indexed, 'deepseek/') === undefined)

    // 自动：上游声明优先，缺项时目录兜底（两者都返回，由 fix.ts 逐维取第一个有值的）
    const auto = resolveSource(cfgWith({}), indexed, DECLARATIONS, 'gw', 'http://127.0.0.1:7002/v1', MODEL)
    check('自动：pin 为空串且两侧都给', auto.pin === '' && auto.declared?.contextWindow === 1_000_000 && auto.entry?.contextWindow === 1_048_576, auto)

    // 只认上游声明
    const onlyUpstream = resolveSource(cfgWith({ gw: { [MODEL]: SOURCE_UPSTREAM } }), indexed, DECLARATIONS, 'gw', undefined, MODEL)
    check('pin=upstream：只给声明，不给目录条目', onlyUpstream.pin === SOURCE_UPSTREAM && onlyUpstream.declared?.efforts?.join(',') === 'high,xhigh' && onlyUpstream.entry === undefined)

    // pin 指向某目录条目：只认它，声明一律让位
    const pinnedEntry = resolveSource(cfgWith({ gw: { [MODEL]: 'z-ai/glm-5.3' } }), indexed, DECLARATIONS, 'gw', undefined, MODEL)
    check('pin=目录条目：只给该条目，声明被让位', pinnedEntry.pin === 'z-ai/glm-5.3' && pinnedEntry.entry === OTHER && pinnedEntry.declared === undefined)

    // 陈旧 pin（目录刷新后条目消失）：回落自动，pin 归空以免 UI 一直显示失效值
    const stale = resolveSource(cfgWith({ gw: { [MODEL]: 'gone/model-x' } }), indexed, DECLARATIONS, 'gw', undefined, MODEL)
    check('陈旧 pin 回落自动（pin 归空，两侧照旧）', stale.pin === '' && stale.entry?.id === MODEL && stale.declared?.contextWindow === 1_000_000)

    // 非字符串 pin / 空白 pin 视作自动
    check('空白 pin 视作自动', resolveSource(cfgWith({ gw: { [MODEL]: '   ' } }), indexed, DECLARATIONS, 'gw', undefined, MODEL).pin === '')

    // 无声明时：自动等于目录；pin=upstream 时两侧皆空（由 fix.ts 落到「未填充」）
    const noDecl = resolveSource(cfgWith({}), indexed, undefined, 'gw', undefined, MODEL)
    check('无声明时自动只用目录', noDecl.declared === undefined && noDecl.entry?.id === MODEL)
    const declaredMissing = resolveSource(cfgWith({ gw: { [MODEL]: SOURCE_UPSTREAM } }), indexed, undefined, 'gw', undefined, MODEL)
    check('pin=upstream 但端点没声明：两侧皆空', declaredMissing.declared === undefined && declaredMissing.entry === undefined)

    // 声明按 provider 隔离：别的提供方的同名模型声明不给本提供方用
    const otherProvider = resolveSource(cfgWith({}), indexed, DECLARATIONS, 'gw2', undefined, MODEL)
    check('声明按 provider 隔离（不串用别的提供方回包）', otherProvider.declared === undefined && otherProvider.entry?.id === MODEL)

    // 目录查不到时 entry 为空但不影响 pin 解析结果形状
    const missing = resolveSource(cfgWith({}), indexed, undefined, 'gw', undefined, 'no-such-model')
    check('目录查不到时 entry 为空', missing.entry === undefined && stable(missing.pin) === '""')

    // 命名空间前缀：声明按原样键命中；目录侧靠兜底剥前缀命中同一条目
    const namespaced = resolveSource(cfgWith({}), indexed, new Map([['gw', new Map([['cn:deepseek-v4-pro', { contextWindow: 1_000_000 }]])]]), 'gw', undefined, 'cn:deepseek-v4-pro')
    check('前缀 id：声明按原样键命中、目录侧靠剥前缀兜底', namespaced.declared?.contextWindow === 1_000_000 && namespaced.entry?.contextWindow === 1_048_576, namespaced)

    // 显示名兜底：id 匹配不上时用显示名（含去首段厂商标识），仍要求唯一一组参数
    const byName = resolveSource(cfgWith({}), indexed, undefined, 'gw', undefined, 'unknown-id', 'DeepSeek-V4-Pro')
    check('显示名兜底命中同一目录条目', byName.entry?.contextWindow === 1_048_576, byName)
    const nameOff = resolveSource(cfgWith({}, false, false), indexed, undefined, 'gw', undefined, 'unknown-id', 'DeepSeek-V4-Pro')
    check('nameFallback 关时显示名不兜底', nameOff.entry === undefined, nameOff)
}
