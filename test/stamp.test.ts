// stamp.ts 纯函数测试：四字段指纹的采集/序列化、来源等级与覆盖判定、按字段合并、写入表合并
import { check, stable } from '@test/helper'
import {
    fieldStampsOf,
    isPluginWritten,
    mayReplace,
    parseStamps,
    serializeStamps,
    stampPatched,
    stampSource,
    withStamps,
    writtenOf,
} from '@/stamp'
import type { WrittenMap } from '@/shared/types'

const ROW = { reasoningEfforts: { low: 'low', high: 'high' }, contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'] }

export function run(): void {
    // fieldStampsOf：与原值同形的最简表示，取本轮「已剔除空壳」的行
    check('fieldStampsOf 四字段齐全（档位归一为 级别=原值 串）', stable(fieldStampsOf(ROW)) === stable({ r: 'high=high,low=low', c: 1_000_000, m: 128_000, i: 'text,image' }), fieldStampsOf(ROW))
    check('fieldStampsOf 空行全 null', stable(fieldStampsOf({})) === stable({ r: null, c: null, m: null, i: null }))
    check('fieldStampsOf 档位键序无关（同一形状得到同一指纹）', stable(fieldStampsOf({ reasoningEfforts: { high: 'high', low: 'low' } })) === stable(fieldStampsOf({ reasoningEfforts: { low: 'low', high: 'high' } })))
    check('fieldStampsOf 档位非对象/空对象记 null', stable(fieldStampsOf({ reasoningEfforts: ['low'] }).r) === 'null' && stable(fieldStampsOf({ reasoningEfforts: {} }).r) === 'null')
    check('fieldStampsOf 模态剔除非字符串项后拼接', fieldStampsOf({ input: ['text', 42, 'image'] }).i === 'text,image')
    check('fieldStampsOf 模态空数组记 null', fieldStampsOf({ input: [] }).i === null)
    check('fieldStampsOf 容量只认 number（字符串数字不认）', fieldStampsOf({ contextWindow: '1000', maxTokens: 8 }).c === null && fieldStampsOf({ maxTokens: 8 }).m === 8)
    check('fieldStampsOf 传入来源才记 s（空来源不记）', stable(fieldStampsOf(ROW, { r: 'u' })) === stable({ r: 'high=high,low=low', c: 1_000_000, m: 128_000, i: 'text,image', s: { r: 'u' } }) && fieldStampsOf(ROW, {}).s === undefined)

    // 序列化 / 反序列化
    const stamps = fieldStampsOf(ROW, { r: 'u', c: 'c' })
    check('serialize/parse 往返一致', stable(parseStamps(serializeStamps(stamps))) === stable(stamps))
    check('parseStamps 坏值与缺失一律 undefined（按手改处理）', parseStamps('{oops') === undefined && parseStamps(undefined) === undefined && parseStamps(42) === undefined && parseStamps('null') === undefined && parseStamps('[]') === undefined)
    check('parseStamps 缺字段补 null', stable(parseStamps('{"c":1000}')) === stable({ r: null, c: 1000, m: null, i: null }))
    check('parseStamps 只保留合法来源项', stable(parseStamps('{"r":"a=b","s":{"r":"u","c":"x","m":42}}')) === stable({ r: 'a=b', c: null, m: null, i: null, s: { r: 'u' } }))

    // mayReplace：同级可刷新、更高级可升级、降级永不
    check('mayReplace 无来源 → 目录/上游均可写', mayReplace(undefined, 'c') === true && mayReplace(undefined, 'u') === true)
    check('mayReplace 同级放行（同源刷新由 allowUpdate 闸门把关）', mayReplace('c', 'c') === true && mayReplace('u', 'u') === true)
    check('mayReplace 目录 → 上游可升级', mayReplace('c', 'u') === true)
    check('mayReplace 上游 → 目录永不降级', mayReplace('u', 'c') === false)
    check('mayReplace 新来源缺失时不覆盖', mayReplace('c', undefined) === false && mayReplace(undefined, undefined) === false)
    check('stampSource 取字段来源（缺省 undefined）', stampSource(stamps, 'r') === 'u' && stampSource(stamps, 'm') === undefined && stampSource(undefined, 'r') === undefined)

    // isPluginWritten：逐字段比对，缺记录或字段为 null 一律 false
    const written: WrittenMap = { p: { m: serializeStamps(stamps) } }
    const current = fieldStampsOf(ROW)
    check('isPluginWritten 同值即为插件写的', isPluginWritten(written, 'p', 'm', 'c', current) === true && isPluginWritten(written, 'p', 'm', 'r', current) === true)
    check('isPluginWritten 值被改成别的即判手改', isPluginWritten(written, 'p', 'm', 'c', fieldStampsOf({ ...ROW, contextWindow: 2_000_000 })) === false)
    check('isPluginWritten 无记录判手改', isPluginWritten(written, 'p', 'other', 'c', current) === false && isPluginWritten({}, 'p', 'm', 'c', current) === false)
    check('isPluginWritten 记录里的字段为 null 时判手改（当时不是插件写的）', isPluginWritten({ p: { m: serializeStamps(fieldStampsOf({})) } }, 'p', 'm', 'c', current) === false)

    // stampPatched：只换本轮写过的字段，其余保留旧记录
    const previous = fieldStampsOf({ reasoningEfforts: { low: 'low' }, contextWindow: 1_000_000 }, { r: 'c' })
    const patched = stampPatched(previous, { reasoningEfforts: { low: 'low' }, contextWindow: 1_000_000, maxTokens: 64_000 }, { r: 'u' })
    check('stampPatched 写过的字段更新值与来源', patched.r === 'low=low' && patched.s?.r === 'u')
    check('stampPatched 没写过的字段保留旧指纹（p 里旧 c 仍在，新 m 不记）', patched.c === 1_000_000 && patched.m === null)
    check('stampPatched 无旧记录时缺失字段保持 null', stable(stampPatched(undefined, {}, { c: 'c' })) === stable({ r: null, c: null, m: null, i: null }))
    check('stampPatched 来源传 undefined 即删掉该字段来源', stampPatched(previous, { reasoningEfforts: { low: 'low' } }, { r: undefined }).s === undefined)

    // withStamps / writtenOf
    const base: WrittenMap = {}
    const next = withStamps(base, 'p', 'm', stamps)
    check('withStamps 写入后可读回', writtenOf(next, 'p', 'm') === serializeStamps(stamps))
    check('withStamps 同值再次写入返回原引用（省一次落盘）', withStamps(next, 'p', 'm', stamps) === next)
    check('withStamps 不同模型各占一条', writtenOf(withStamps(next, 'p', 'm2', fieldStampsOf({})), 'p', 'm2') === serializeStamps(fieldStampsOf({})))
    check('withStamps 不改动入参', writtenOf(base, 'p', 'm') === undefined)
    check('writtenOf 缺失返回 undefined', writtenOf(next, 'p', 'nope') === undefined && writtenOf(next, 'nope', 'm') === undefined)
}
