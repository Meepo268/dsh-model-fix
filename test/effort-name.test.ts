// effort-name.ts（Node 半）测试：档位名换名纯函数与词表同源
import { localizeEffortNames } from '@/effort-name'
import { EFFORT_NAMES_ZH, EFFORT_LEVELS } from '@/shared/constants'
import { check, stable } from '@test/helper'

/** 宿主口径的显示名形式（与实现同一表达式） */
const hostForm = <T extends string>(id: T): Capitalize<T> => (id.charAt(0).toUpperCase() + id.slice(1)) as Capitalize<T>

/** 造一份最小 resolved 信息：给定档位表 */
function infoOf(efforts: readonly { id: string; name: string }[]): Parameters<typeof localizeEffortNames>[0] {
    return { id: 'm', name: 'M', provider: 'p', reasoning: { efforts } } as Parameters<typeof localizeEffortNames>[0]
}

/** 取换名后某档位的显示名 */
function nameOf(info: Parameters<typeof localizeEffortNames>[0], index: number): string {
    return info.reasoning?.efforts[index]?.name ?? ''
}

export function run(): void {
    // 词表与共享层档位表同源：前七键逐项相等（编译期已保证无缺漏），外加 Default（宿主伪菜单项）
    const expectedKeys = [...EFFORT_LEVELS.map(hostForm), 'Default']
    check('词表键集与 EFFORT_LEVELS 同源（宿主口径）+ Default',
        stable(Object.keys(EFFORT_NAMES_ZH).sort()) === stable(expectedKeys.sort()), Object.keys(EFFORT_NAMES_ZH))
    check('词表七档 + Default 各有中文名',
        stable(Object.values(EFFORT_NAMES_ZH)) === stable(['关', '极低', '低', '中', '高', '极高', '最大', '默认']), EFFORT_NAMES_ZH)

    // 命中即换名；id 一律不动
    const hit = localizeEffortNames(infoOf([{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }]))
    check('命中的档位换名', nameOf(hit, 0) === '关' && nameOf(hit, 1) === '高', hit.reasoning?.efforts)
    check('换名不动 id', stable(hit.reasoning?.efforts) === stable([{ id: 'off', name: '关' }, { id: 'high', name: '高' }]), hit.reasoning?.efforts)
    check('换名不动其余字段', hit.id === 'm' && hit.provider === 'p' && hit.name === 'M', hit)

    // defaultEffort 是档位 id（宿主校验它必须落在 efforts[].id 集合内），保持原样不翻译
    const withDefault = localizeEffortNames(infoOf([{ id: 'high', name: 'High' }]))
    withDefault.reasoning = { ...withDefault.reasoning!, defaultEffort: 'high' } as typeof withDefault.reasoning
    const localizedDefault = localizeEffortNames(withDefault)
    check('defaultEffort 保持 id 原样', localizedDefault.reasoning?.defaultEffort === 'high', localizedDefault.reasoning)

    // 生产词表接上生产形态的档位名：七档逐项换掉
    const production = localizeEffortNames(infoOf(EFFORT_LEVELS.map((id) => ({ id, name: hostForm(id) }))))
    check('生产词表逐档换名', stable(production.reasoning?.efforts)
        === stable(EFFORT_LEVELS.map((id) => ({ id, name: EFFORT_NAMES_ZH[hostForm(id)] }))), production.reasoning?.efforts)

    // 表外 id 原样透传（插件自注册适配器的自定义档位交给其作者命名）
    const partial = localizeEffortNames(infoOf([{ id: 'ultra', name: 'Ultra' }, { id: 'high', name: 'High' }]))
    check('表外 id 原样透传', nameOf(partial, 0) === 'Ultra' && nameOf(partial, 1) === '高', partial.reasoning?.efforts)

    // showOriginal：中文名后追加「 · 」与原档位名（原样取宿主给的 name，不重算）
    const both = localizeEffortNames(infoOf([{ id: 'max', name: 'Max' }, { id: 'off', name: 'Off' }]), true)
    check('showOriginal 输出「中文 · 原档位」', nameOf(both, 0) === '最大 · Max' && nameOf(both, 1) === '关 · Off', both.reasoning?.efforts)
    check('showOriginal 不动 id', stable(both.reasoning?.efforts) === stable([{ id: 'max', name: '最大 · Max' }, { id: 'off', name: '关 · Off' }]), both.reasoning?.efforts)
    check('showOriginal 省略时等价于不追加', nameOf(localizeEffortNames(infoOf([{ id: 'max', name: 'Max' }])), 0) === '最大', undefined)

    // showOriginal 下表外 id 仍原样透传（不套「中文 · 」格式）
    const partialBoth = localizeEffortNames(infoOf([{ id: 'ultra', name: 'Ultra' }]), true)
    check('showOriginal 下表外 id 原样透传', nameOf(partialBoth, 0) === 'Ultra', partialBoth.reasoning?.efforts)

    // 非全小写 id：宿主自己的显示名就不是已知七键（如 `HIGH` 显示 `HIGH`）→ 原样透传，不猜
    const oddCase = localizeEffortNames(infoOf([{ id: 'HIGH', name: 'HIGH' }, { id: 'hIgH', name: 'hIgH' }]))
    check('非小写 id 原样透传', nameOf(oddCase, 0) === 'HIGH' && nameOf(oddCase, 1) === 'hIgH', oddCase.reasoning?.efforts)

    // 一档都没命中时返回入参原引用（不造新对象）；无 reasoning 的信息同样原样
    const untouched = infoOf([{ id: 'ultra', name: 'Ultra' }])
    check('未命中任何档位时返回原引用', localizeEffortNames(untouched) === untouched)
    const plain = { id: 'm', name: 'M', provider: 'p' } as Parameters<typeof localizeEffortNames>[0]
    check('无 reasoning 时返回原引用', localizeEffortNames(plain) === plain)
}
