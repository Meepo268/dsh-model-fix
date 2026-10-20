/** 「参数来源」弹层的取数形状（跨半共享、零 Node 依赖）：Node 半 `buildSourceSnapshot` 产出，浏览器半只渲染。
 * 与 `verify-progress` 同理，形状一处定义，两侧不各写一份 */

/** 一维来源的四字段（档位文案已格式化，容量缺省即无值） */
export interface SourceFieldsView {
    /** 档位（`low / high / max` 这样的展示串；空串 = 无档位） */
    efforts: string
    contextWindow?: number
    maxTokens?: number
    /** 是否声明图片输入 */
    image: boolean
}

/** 下拉里的一条目录候选 */
export interface SourceCandidateView {
    /** 写进配置的 pin 值：`<provider>/<modelId>` */
    key: string
    provider: string
    id: string
    fields: SourceFieldsView
    /** 同 id 形态、同参数的其它来源数（>0 时下拉标 `+N`）：它们填出来的值完全一样，故折叠成一行 */
    also?: number
}

/** 一路提供方下的一个模型 */
export interface SourceModelView {
    id: string
    name?: string
    /** 当前 pin：空串 = 自动（上游声明 > 目录） */
    pin: string
    /** 自动优先级实际取胜的来源：`upstream`（含「目录也命中的情况」）/ `catalog` / `none` */
    source: 'upstream' | 'catalog' | 'none'
    /** `source === 'catalog'` 时命中的候选键（用于在下拉里回显） */
    matchedKey?: string
    /** 配置行现值（供与来源对比） */
    current: SourceFieldsView
    /** 上游声明（端点不可达或未声明时为 undefined） */
    upstream?: SourceFieldsView
    /** 目录候选（本组优先，最多 24 条） */
    candidates: SourceCandidateView[]
    /** 该提供方在 `excludes` 里：本插件不会动它 */
    excluded: boolean
}

/** 一路提供方 */
export interface SourceProviderView {
    id: string
    models: SourceModelView[]
}

/** 整份快照 */
export interface SourceSnapshot {
    providers: SourceProviderView[]
}

/** 档位列表 -> 展示串（`['low','high']` → `low / high`） */
export function formatEfforts(efforts: readonly string[] | undefined): string {
    return efforts === undefined ? '' : efforts.join(' / ')
}

/** 容量压成短写：`1000000` → `1M`、`128000` → `128K`、`64000` → `64K`；无值/哨兵返回空串。
 * 下拉的每个选项只有一行，`1000000` 这种七位数挤掉的正是档位摘要，故统一压短 */
export function capacityText(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value) || value <= 0 || value >= 99_999_999) return ''
    if (value >= 1_000_000) {
        const millions = Math.round((value / 1_000_000) * 10) / 10
        return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
    }
    if (value >= 1000) return `${Math.round(value / 1000)}K`
    return String(value)
}

/** 一行能力摘要：`1M/128K · low/high/xhigh · 图`（缺项跳过；档位用 `/` 省宽）。`imageMark` 由调用方按语言传 */
export function candidateSummary(fields: SourceFieldsView, imageMark = '图'): string {
    const parts: string[] = []
    const capacity = [capacityText(fields.contextWindow), capacityText(fields.maxTokens)]
        .filter((value) => value !== '')
        .join('/')
    if (capacity !== '') parts.push(capacity)
    if (fields.efforts !== '') parts.push(fields.efforts.replaceAll(' / ', '/'))
    if (fields.image) parts.push(imageMark)
    return parts.join(' · ')
}

/** 下拉里「自动 / 只用上游声明」两个固定项：把上游声明的能力摘要并进标题，方便和目录候选一眼对比；
 * 端点没给出声明时明说「上游未声明」，而不是让人误以为摘要是空的 */
export function upstreamOptionLabel(text: string, upstream: SourceFieldsView | undefined, imageMark: string, missing: string): string {
    const summary = upstream === undefined ? '': candidateSummary(upstream, imageMark)
    return summary === '' ? `${text} · ${missing}` : `${text} · ${summary}`
}

/** 单行截断：超长补省略号（原生 `<option>` 不会自己加省略号，只能先截好再交给它） */
export function fitLabel(text: string, limit = 64): string {
    if (text.length <= limit) return text
    return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}
