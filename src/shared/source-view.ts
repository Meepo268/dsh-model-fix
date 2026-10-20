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
