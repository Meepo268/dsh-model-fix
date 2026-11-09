// source-view.ts 纯函数测试：容量短写、候选摘要、截断、RPC 信封认快照、「未命中」计数与席位常驻计数
import { check } from '@test/helper'
import {
    candidateSummary,
    capacityText,
    fitLabel,
    formatStamp,
    seatCounts,
    snapshotOfResult,
    unmatchedCount,
    upstreamOptionLabel,
} from '@/shared/source-view'
import type { SourceFieldsView, SourceModelView, SourceSnapshot } from '@/shared/source-view'

const FIELDS: SourceFieldsView = { efforts: 'low / high', contextWindow: 1_048_576, maxTokens: 393_216, image: true }

/** 造一行快照：只给判据用到的字段，其余按最小形态补 */
function model(id: string, source: SourceModelView['source'], excluded = false): SourceModelView {
    return { id, pin: '', source, current: { efforts: '', image: false }, candidates: [], excluded }
}

function snapshot(...models: SourceModelView[]): SourceSnapshot {
    return { providers: [{ id: 'p1', models }] }
}

export function run(): void {
    // capacityText：七位数要压短，缺值/哨兵/0 一律空串
    check('capacityText 百万级压成一位小数', capacityText(1_000_000) === '1M', capacityText(1_000_000))
    check('capacityText 非整百万保留一位', capacityText(1_048_576) === '1M', capacityText(1_048_576))
    check('capacityText 千级压成 K', capacityText(128_000) === '128K', capacityText(128_000))
    check('capacityText 小值原样', capacityText(999) === '999', capacityText(999))
    check('capacityText 哨兵与 0 视为无值', capacityText(99_999_999) === '' && capacityText(0) === '', capacityText(99_999_999))
    check('capacityText undefined / 非有限值给空串', capacityText(undefined) === '' && capacityText(Number.NaN) === '')

    // candidateSummary：容量 / 档位 / 图片三段，缺项跳过；档位用 / 省宽
    check('candidateSummary 三段齐全', candidateSummary(FIELDS) === '1M/393K · low/high · 图', candidateSummary(FIELDS))
    check('candidateSummary 无图片标记可换语言', candidateSummary(FIELDS, 'img') === '1M/393K · low/high · img')
    check('candidateSummary 全空给空串', candidateSummary({ efforts: '', image: false }) === '')

    // upstreamOptionLabel：有声明就带上摘要，没声明明说「上游未声明」
    check(
        'upstreamOptionLabel 有声明带摘要',
        upstreamOptionLabel('自动', FIELDS, '图', '上游未声明') === '自动 · 1M/393K · low/high · 图',
        upstreamOptionLabel('自动', FIELDS, '图', '上游未声明'),
    )
    check('upstreamOptionLabel 无声明明说缺什么', upstreamOptionLabel('自动', undefined, '图', '上游未声明') === '自动 · 上游未声明')

    // fitLabel：超长补省略号，边界不多截
    check('fitLabel 短串原样', fitLabel('abc', 5) === 'abc')
    check('fitLabel 超长截到 limit-1 再补省略号', fitLabel('abcdefgh', 5) === 'abcd…', fitLabel('abcdefgh', 5))

    // snapshotOfResult：失败信封、形状不符都当无快照
    check('snapshotOfResult 成功信封取出快照', snapshotOfResult({ ok: true, value: snapshot() })?.providers.length === 1)
    check('snapshotOfResult 失败信封给 undefined', snapshotOfResult({ ok: false, value: snapshot() }) === undefined)
    check('snapshotOfResult 缺 providers 给 undefined', snapshotOfResult({ ok: true, value: {} }) === undefined)
    check('snapshotOfResult 非对象给 undefined', snapshotOfResult({ ok: true, value: 42 }) === undefined)

    // unmatchedCount：只数「自动来源两路皆空」的非排除行
    check(
        'unmatchedCount 数 none 行、跳过命中与排除',
        unmatchedCount(snapshot(
            model('a', 'none'),
            model('b', 'catalog'),
            model('c', 'none', true),
            model('d', 'upstream'),
        ), 'p1') === 1,
    )
    check('unmatchedCount 提供方不在快照里给 0', unmatchedCount(snapshot(model('a', 'none')), 'p2') === 0)
    check('unmatchedCount 无快照给 0', unmatchedCount(undefined, 'p1') === 0)
    check('unmatchedCount 空模型表给 0', unmatchedCount({ providers: [{ id: 'p1', models: [] }] }, 'p1') === 0)

    // formatStamp：本地时区、精确到分钟、补零
    check('formatStamp 补零且不带秒', formatStamp(new Date(2026, 10, 9, 8, 5).getTime()) === '2026-11-09 08:05', formatStamp(new Date(2026, 10, 9, 8, 5).getTime()))
    check('formatStamp 跨年边界', formatStamp(new Date(2025, 0, 1, 0, 0).getTime()) === '2025-01-01 00:00')

    // seatCounts：徽标两种状态各说一句话（有漏报未命中数、没漏报已命中数），取不到时给 undefined（不画）
    // 排除是提供方级的：要么整家排除（下面那条 → undefined），要么一家都不排除；
    // 这里造混合形态只为固定判据本身
    check(
        'seatCounts 把两路命中拆开报（上游 / 目录）',
        JSON.stringify(seatCounts(snapshot(model('a', 'none'), model('b', 'catalog'), model('c', 'none', true)), 'p1'))
            === JSON.stringify({ total: 3, matched: 1, unmatched: 1, fromUpstream: 0, fromCatalog: 1 }),
        JSON.stringify(seatCounts(snapshot(model('a', 'none'), model('b', 'catalog'), model('c', 'none', true)), 'p1')),
    )
    check(
        'seatCounts 全命中时未命中为 0、两路相加等于总数',
        JSON.stringify(seatCounts(snapshot(model('a', 'upstream'), model('b', 'catalog'), model('c', 'upstream')), 'p1'))
            === JSON.stringify({ total: 3, matched: 3, unmatched: 0, fromUpstream: 2, fromCatalog: 1 }),
        JSON.stringify(seatCounts(snapshot(model('a', 'upstream'), model('b', 'catalog'), model('c', 'upstream')), 'p1')),
    )
    check('seatCounts 提供方不在快照里给 undefined', seatCounts(snapshot(model('a', 'none')), 'p2') === undefined)
    check('seatCounts 无快照给 undefined', seatCounts(undefined, 'p1') === undefined)
    check('seatCounts 空模型表给 undefined', seatCounts({ providers: [{ id: 'p1', models: [] }] }, 'p1') === undefined)
    check(
        'seatCounts 整家在排除列表里给 undefined（不标数字，免得像故障）',
        seatCounts(snapshot(model('a', 'none', true), model('b', 'catalog', true)), 'p1') === undefined,
    )
}
