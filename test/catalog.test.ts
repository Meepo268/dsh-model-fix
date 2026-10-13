// catalog.ts 纯函数测试：buildCatalog 分组构建与剪裁（推理/容量/图片模态三源）、容量守卫与缓存条目结构校验
import { buildCatalog, isCacheRecord, parseCacheGroup } from '@/catalog'
import { CAPACITY_UNLIMITED } from '@/constants'
import type { CacheRecord } from '@/types'
import { isCapacity } from '@/types'
import { check, stable } from '@test/helper'

/** 用单 provider 单模型构造 api 数据并返回该缓存条目（被剪裁时 undefined） */
function one(model: Record<string, unknown>): CacheRecord | undefined {
    return buildCatalog({ p: { models: { m: model } } })['p']?.m
}

/** 执行本文件的全部用例 */
export function run(): void {
    // 图片模态：仅缓存正向信息（支持图片才写 image:true）
    check('仅含图片支持也入库', stable(one({ modalities: { input: ['text', 'image'] } })) === stable({ efforts: [], image: true }), one({ modalities: { input: ['text', 'image'] } }))
    check('不含 image 且无其他数据被剪裁', one({ modalities: { input: ['text'] } }) === undefined)
    check('image 顺序不影响结果', stable(one({ modalities: { input: ['image', 'text'] } })) === stable({ efforts: [], image: true }), one({ modalities: { input: ['image', 'text'] } }))
    check('pdf/video/audio 等值不算图片支持，有容量仍入库但不写 image', stable(one({ limit: { context: 100 }, modalities: { input: ['text', 'pdf', 'video', 'audio'] } })) === stable({ efforts: [], contextWindow: 100 }), one({ limit: { context: 100 }, modalities: { input: ['text', 'pdf', 'video', 'audio'] } }))
    check('非图片模态整体不缓存 false', one({ modalities: { input: [] } }) === undefined && one({ modalities: {} }) === undefined && one({ modalities: 'x' }) === undefined)
    check('modalities 缺失时不写 image 键', stable(one({ limit: { context: 100 } })) === stable({ efforts: [], contextWindow: 100 }), one({ limit: { context: 100 } }))

    // 容量哨兵清洗：0/负数/小数/99999999 均视为无该字段
    check('contextWindow=0 剪裁，其余字段可支撑入库', stable(one({ limit: { context: 0, output: 4096 } })) === stable({ efforts: [], maxTokens: 4096 }), one({ limit: { context: 0, output: 4096 } }))
    check('容量全为 0 且无其他信息被剪裁', one({ limit: { context: 0, output: 0 } }) === undefined)
    check('哨兵 99999999 视为无数据', one({ limit: { context: CAPACITY_UNLIMITED, output: CAPACITY_UNLIMITED } }) === undefined)
    check('哨兵容量但支持图片仍入库', stable(one({ limit: { context: 0, output: CAPACITY_UNLIMITED }, modalities: { input: ['text', 'image'] } })) === stable({ efforts: [], image: true }), one({ limit: { context: 0, output: CAPACITY_UNLIMITED }, modalities: { input: ['text', 'image'] } }))
    check('isCapacity 边界', isCapacity(1) && isCapacity(1_000_000)
        && !isCapacity(0) && !isCapacity(-5) && !isCapacity(1.5) && !isCapacity(NaN) && !isCapacity(Infinity)
        && !isCapacity(CAPACITY_UNLIMITED) && !isCapacity('100') && !isCapacity(undefined))

    // 剪裁条件回归：有效推理级别、容量、支持图片三者全无才剔除
    check('无任何信息被剪裁', one({ temperature: true }) === undefined)
    check('仅 none 档不算推理但图片支持可入库', stable(one({ reasoning: true, reasoning_options: [{ type: 'toggle' }], modalities: { input: ['text', 'image'] } })) === stable({ efforts: [], image: true }), one({ reasoning: true, reasoning_options: [{ type: 'toggle' }], modalities: { input: ['text', 'image'] } }))
    check('toggle 不合成关闭档；仅 off 档不算推理但容量可入库', stable(one({ reasoning: true, reasoning_options: [{ type: 'effort', values: ['off'] }], limit: { context: 100 } })) === stable({ efforts: [], contextWindow: 100 }), one({ reasoning: true, reasoning_options: [{ type: 'effort', values: ['off'] }], limit: { context: 100 } }))
    check('推理+容量+图片共存全保留（off 原值保留不归一为 none）', stable(one({ reasoning: true, reasoning_options: [{ type: 'effort', values: ['off', 'high', 'bogus'] }], limit: { context: 200, output: 50 }, modalities: { input: ['text', 'image'] } })) === stable({ efforts: ['off', 'high'], contextWindow: 200, maxTokens: 50, image: true }), one({ reasoning: true, reasoning_options: [{ type: 'effort', values: ['off', 'high', 'bogus'] }], limit: { context: 200, output: 50 }, modalities: { input: ['text', 'image'] } }))
    check('buildCatalog 返回分组对象（provider 为键）', (() => {
        const catalog = buildCatalog({ p: { models: { m: { limit: { context: 10 } } } } })
        return Object.keys(catalog).length === 1 && catalog.p && stable(catalog.p.m) === stable({ efforts: [], contextWindow: 10 })
    })())

    // 缓存条目结构校验：磁盘 JSON 可能被手改或写坏，坏条目必须在入库前挡掉（否则填充迭代 efforts 时抛错）
    check('合法条目通过', isCacheRecord({ efforts: ['high', 'none'] }))
    check('可选容量与图片省略也通过', isCacheRecord({ efforts: [], contextWindow: 200, maxTokens: 50, image: true }))
    check('provider / id 键一律拒绝（定位信息在分组与嵌套键，不应出现在记录本体）', !isCacheRecord({ provider: 'p', id: 'm', efforts: [] })
        && !isCacheRecord({ id: 'm', efforts: [] })
        && !isCacheRecord({ provider: 'p', efforts: [] }))
    check('efforts 缺失、非数组、含非字符串一律拒绝', !isCacheRecord({})
        && !isCacheRecord({ efforts: 'high' })
        && !isCacheRecord({ efforts: ['high', 1] }))
    check('未知档位一律拒绝（none ∪ LEVELS 之外的取值非法）', !isCacheRecord({ efforts: ['extreme'] })
        && !isCacheRecord({ efforts: ['high', 'bogus'] })
        && isCacheRecord({ efforts: ['off'] })
        && !isCacheRecord({ efforts: ['HIGH'] }))
    check('none 与全部合法档位通过', isCacheRecord({ efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }))
    check('off 与全部合法档位通过', isCacheRecord({ efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }))
    check('容量非法（0/小数/字符串/哨兵）拒绝整条', !isCacheRecord({ efforts: [], contextWindow: 0 })
        && !isCacheRecord({ efforts: [], contextWindow: 1.5 })
        && !isCacheRecord({ efforts: [], maxTokens: '200' })
        && !isCacheRecord({ efforts: [], maxTokens: CAPACITY_UNLIMITED }))
    check('image 只认真值（false 无信息量，拒绝）', !isCacheRecord({ efforts: [], image: false }) && isCacheRecord({ efforts: [], image: true }))
    check('未知多余键忽略（向前兼容）', isCacheRecord({ efforts: [], unknownField: 1 }))
    check('非对象条目拒绝', !isCacheRecord(null) && !isCacheRecord('x') && !isCacheRecord([{ efforts: [] }]))
    check('分组校验：全合法通过、任一坏条拒绝整组', parseCacheGroup({ a: { efforts: [] }, b: { efforts: [], contextWindow: 10 } }) !== undefined
        && parseCacheGroup({ a: { efforts: [] }, b: { efforts: 1 } }) === undefined
        && parseCacheGroup({ a: { efforts: [] }, b: { efforts: ['bogus'] } }) === undefined
        && parseCacheGroup('x') === undefined
        && parseCacheGroup([]) === undefined)
}
