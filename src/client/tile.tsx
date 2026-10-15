import { useRef, useState } from 'react'
// primitives 由宿主模块表注入
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { EXCLUDE_ID_PATTERN, GROUP_KEYS, groupValue, masterValue } from '@/client/model'
import type { Flags, Group, RowKey } from '@/client/model'
import type { CardKey } from '@/client/locale-keys'
import { COLUMN_KEYS, HINT_KEYS, ROW_KEYS, TIP_KEYS } from '@/client/locale-keys'
import { TIP_MAX_WIDTH } from '@/client/card-styles'

/**
 * 卡片的瓦片层：展开体里五张瓦片的两种形态——布尔矩阵配置组瓦片（官方「插件列表」项卡同款）与
 * 「排除提供方」的动态集合瓦片，渲染顺序由 TILE_ORDER 单一分发。
 *
 * 瓦片只管自己的 summary 与展开体结构，外加「排除提供方」那一份纯 UI 暂态（输入文本与校验反馈不属于配置）；
 * 展开态、启用态与全部写回回调都由卡片经 props 传入，故这里既不发请求也不碰 Connection，
 * 卡片因而只剩编排与弹层。样式数值不在本文件，见 card-styles.ts。
 */

/** 瓦片 chevron：宿主 ui-primitives 导出的描边 chevron 图标 */
const CHEVRON_DOWN = primitives.IconChevronDownOutlineRegular
const { Pill, Switch, Tag, StateDot, Tooltip, IconInfoOutlineRegular, IconTrashOutlineRegular } = primitives

/** 瓦片文案函数：与卡片 props 的 t 同型，同为 slots.register 的 locale 席位合成注入 */
type TileTranslate = TranslateNS<'settings.modelFix'>

/** 瓦片渲染顺序：自动填充 / 允许更新 / 兼容性 / 排除提供方 / 用户体验 */
export const TILE_ORDER: readonly (Group | 'excludes')[] = ['autoFill', 'allowUpdate', 'compat', 'excludes', 'userExperience']

/** Pill 组阈值：组内行键数 ≥ 5 时改用 Pill 胶囊布局，< 5 保持 Switch 行 */
const PILL_THRESHOLD = 5

/** 配置组瓦片：summary 为组名 + 整组开关 + 折叠箭头，展开体为组释义 + 子开关行；
 * 整行可点由 .dsh-mf-itemToggle 覆盖层承担（无 button 嵌套），可访问名用 aria-labelledby 指向可见标题。
 * 组内行数 ≥ PILL_THRESHOLD 时，子开关改渲染为 Pill 胶囊组（flex-wrap 换行、Tooltip 悬浮说明）。 */
export function GroupTile(props: {
    group: Group
    t: TileTranslate
    flags: Flags
    open: boolean
    disabled: boolean
    onToggle: () => void
    onMaster: () => void
    onCell: (key: RowKey) => void
}) {
    const { group, t, open } = props
    const id = `dsh-mf-item-${group}`
    const title = t(COLUMN_KEYS[group])
    const usePills = GROUP_KEYS[group].length >= PILL_THRESHOLD
    return (
        <div className="dsh-mf-item" role="group" data-open={open ? 'true' : undefined} aria-labelledby={`${id}-title`}>
            <div className="dsh-mf-itemHead">
                <button
                    type="button"
                    className="dsh-mf-itemToggle"
                    aria-expanded={open}
                    aria-controls={`${id}-body`}
                    aria-labelledby={`${id}-title`}
                    onClick={props.onToggle}
                />
                <strong className="dsh-mf-itemTitle" id={`${id}-title`}>{title}</strong>
                <span className="dsh-mf-itemTrailing">
                    <Switch
                        className="dsh-mf-itemSwitch"
                        checked={masterValue(props.flags, group)}
                        disabled={props.disabled}
                        label={`${title} ${t('masterAll')}`}
                        onChange={props.onMaster}
                    />
                    <CHEVRON_DOWN size={12} className="dsh-mf-itemChevron" />
                </span>
            </div>
            {open ? (
                <div className="dsh-mf-itemBody" id={`${id}-body`}>
                    <p className="dsh-mf-itemHint">{t(HINT_KEYS[group])}</p>
                    {usePills ? (
                        <div className="dsh-mf-pillGroup" role="group" aria-label={`${title} ${t('masterAll')}`}>
                            {GROUP_KEYS[group].map((key) => {
                                const tip = t(TIP_KEYS[key])
                                const rowLabel = t(ROW_KEYS[key])
                                const active = groupValue(props.flags, group, key)
                                return (
                                    <Tooltip key={key} label={tip} side="top" maxWidth={TIP_MAX_WIDTH} portal>
                                        {/* 宿主 Pill 不 forwardRef，Tooltip.cloneElement 注入的 ref 无法到达其内部 button；span 承接 ref 锚点，纯样式容器 */}
                                        <span>
                                            <Pill
                                                active={active}
                                                aria-pressed={active}
                                                disabled={props.disabled}
                                                onClick={() => { props.onCell(key) }}
                                            >
                                                {rowLabel}
                                            </Pill>
                                        </span>
                                    </Tooltip>
                                )
                            })}
                        </div>
                    ) : GROUP_KEYS[group].map((key) => {
                        const tip = t(TIP_KEYS[key])
                        return (
                            <div key={key} className="dsh-mf-itemRow">
                                <span className="dsh-mf-itemLabelGroup">
                                    <span className="dsh-mf-itemLabel">{t(ROW_KEYS[key])}</span>
                                    {/* 设置项释义用宿主 Tooltip 原语（锚点形态照官方 settings-form .helpButton 的信息图标键）。portal 必需：瓦片 overflow:hidden 加上 box-shadow 构成的层叠上下文会把气泡裁掉 */}
                                    <Tooltip label={tip} side="right" maxWidth={TIP_MAX_WIDTH} portal>
                                        <button type="button" className="dsh-mf-help" aria-label={tip}>
                                            <IconInfoOutlineRegular size={12} />
                                        </button>
                                    </Tooltip>
                                </span>
                                <Switch
                                    checked={groupValue(props.flags, group, key)}
                                    disabled={props.disabled}
                                    label={`${t(ROW_KEYS[key])} ${title}`}
                                    onChange={() => { props.onCell(key) }}
                                />
                            </div>
                        )
                    })}
                </div>
            ) : null}
        </div>
    )
}

/** 「排除提供方」瓦片：动态集合而非布尔矩阵（无整组开关语义）；summary 尾区为「N 命中」徽标，
 * 命中 = 该 id 存在于宿主 llm-pi-ai 的 user 层（0 命中也常驻、不得画成错误色）。
 * 只能手填——正用场景就是先写尚未创建的提供方 id 再新建该提供方，故不做"仅可选现有项"控件。 */
export function ExcludesTile(props: {
    t: TileTranslate
    flags: Flags
    /** 命中的排除项（由卡片以宿主 user 层提供方 id 求交得出） */
    hits: ReadonlySet<string>
    open: boolean
    disabled: boolean
    onToggle: () => void
    onAdd: (id: string) => void
    onRemove: (id: string) => void
}) {
    const { t, open } = props
    const id = 'dsh-mf-item-excludes'
    const title = t('colExcludes')
    // 输入文本与校验反馈是纯 UI 暂态（不属于配置），故留在瓦片本地
    const [text, setText] = useState('')
    const [error, setError] = useState<CardKey | undefined>()
    const inputRef = useRef<HTMLInputElement>(null)
    const commit = () => {
        const value = text.trim()
        // 空输入静默忽略（与官方新增提供方时的按钮禁用同取向：无事发生即可，不必报错）
        if (value === '') {
            setError(undefined)
            return
        }
        if (!EXCLUDE_ID_PATTERN.test(value)) {
            setError('excludeInvalid')
            return
        }
        if (props.flags.excludes.includes(value)) {
            setError('excludeDuplicate')
            return
        }
        props.onAdd(value)
        setText('')
        setError(undefined)
        // 焦点留在输入框：连续录入多项时不必每次回点
        inputRef.current?.focus()
    }
    return (
        <div className="dsh-mf-item" role="group" data-open={open ? 'true' : undefined} aria-labelledby={`${id}-title`}>
            <div className="dsh-mf-itemHead">
                <button
                    type="button"
                    className="dsh-mf-itemToggle"
                    aria-expanded={open}
                    aria-controls={`${id}-body`}
                    aria-labelledby={`${id}-title`}
                    onClick={props.onToggle}
                />
                <strong className="dsh-mf-itemTitle" id={`${id}-title`}>{title}</strong>
                <span className="dsh-mf-itemTrailing">
                    {/* 官方 trailing 结构：[状态点][状态胶囊]，点在胶囊外；summary 的点纯装饰（StateDot 自带 aria-hidden，徽标文字已带语义） */}
                    {props.hits.size > 0 ? <StateDot state="done" size={7} /> : null}
                    <Tag tone={props.hits.size > 0 ? 'success' : 'neutral'}>
                        {t('excludeHits', { count: props.hits.size })}
                    </Tag>
                    <CHEVRON_DOWN size={12} className="dsh-mf-itemChevron" />
                </span>
            </div>
            {open ? (
                <div className="dsh-mf-itemBody" id={`${id}-body`}>
                    <p className="dsh-mf-itemHint">{t('hintExcludes')}</p>
                    <input
                        ref={inputRef}
                        type="text"
                        className="dsh-mf-input"
                        value={text}
                        placeholder={t('excludePlaceholder')}
                        aria-label={t('excludeAdd')}
                        aria-invalid={error !== undefined}
                        disabled={props.disabled}
                        onChange={(event) => {
                            setText(event.target.value)
                            setError(undefined)
                        }}
                        onKeyDown={(event) => {
                            // 中文输入法候选词上屏的 Enter 不得误提交（该场景下这是主要输入路径）
                            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                                event.preventDefault()
                                commit()
                            }
                        }}
                    />
                    {error !== undefined ? <p className="dsh-mf-fieldError" role="alert">{t(error)}</p> : null}
                    {props.flags.excludes.map((excluded) => {
                        const hit = props.hits.has(excluded)
                        const stateText = t(hit ? 'excludeHit' : 'excludeUnmatched')
                        return (
                            <div key={excluded} className="dsh-mf-tagRow">
                                {/* 官方结构：trailing 是 [状态点][状态胶囊] 两个兄弟节点，点在胶囊外面不进底色 */}
                                {hit ? <StateDot state="done" size={7} /> : null}
                                <Tag tone={hit ? 'success' : 'neutral'} className="dsh-mf-tag">
                                    <span className="dsh-mf-tagText">{excluded}</span>
                                </Tag>
                                {/* 命中状态不能只靠颜色传达：StateDot 恒 aria-hidden，行内另留一份读屏状态文案 */}
                                <span className="dsh-mf-hidden">{stateText}</span>
                                <button
                                    type="button"
                                    className="dsh-mf-remove"
                                    aria-label={t('excludeRemove', { id: excluded })}
                                    disabled={props.disabled}
                                    onClick={() => { props.onRemove(excluded) }}
                                >
                                    <IconTrashOutlineRegular size={14} />
                                </button>
                            </div>
                        )
                    })}
                </div>
            ) : null}
        </div>
    )
}
