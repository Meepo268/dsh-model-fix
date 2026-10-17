/**
  * fix / probeAndFill 编排测试的 ctx 桩：内存 settings 文档 + revision 围栏 + queueTask 降级路径。
  *
  * 仅覆盖这两个编排体实际消费的 ctx 面：
  *   - settings.describe() → [{ns, user, revision}]（user 为可变段值，每次 describe 返回实时引用与最新 revision）
  *   - settings.mutate(ns, ops, revision) → 校验 revision 围栏（陈旧即抛 SETTINGS_CONFLICT）、应用 path op、bump revision
  *   - 每次 mutate 记下调用当次的事件流守卫状态
  *   - get('hmr') → undefined（使 src/host.ts 的 queueTask 走 task() 降级路径，不依赖 AsyncLocalStorage）
  *   - logger.{info,warn,error} → 空实现
  *
  * 不实现事件发射（settings/document-updated）：编排体本身不订阅事件，
  * 事件链守卫由 src/guard.ts 与 test/guard.test.ts 单独覆盖。
  */

import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { API_NS, PLUGIN_NS } from '@/shared/constants'
import { setConfigSource } from '@/config'
import { setCatalog } from '@/catalog'
import { setHmrExecuting } from '@/host'
import { isIgnoreAll } from '@/guard'
import { DEFAULT_CONFIG } from '@/shared/config-schema'
import { isPlainObject } from '@/shared/types'

// 测试桩没有 hmr 注入（ctx.get 一律 undefined）：宣告注入已结算（值缺席），
// queueTask 直接走降级路径，不付出有界等待（结算 latch 与信号由 setHmrExecuting 一并完成）
setHmrExecuting(undefined)

/** 单个 settings 段的内存表示 */
interface StubSection {
    user: Record<string, unknown>
    revision: number
}

export interface StubCtxOpts {
    /** llm-pi-ai 段值（通常 {providers: {...}}） */
    api?: Record<string, unknown>
    /** tikaflow-model-fix 段值（版本快照容器，需存在以使 efforts 写回的 revision 围栏可用） */
    plugin?: Record<string, unknown>
    /** 不登记自有段（模拟「自有段还没被 Loader 登记」）：读不到时依赖 excludes 的写回路径必须显式失败 */
    noPlugin?: boolean
    /** 前 N 次 mutate 调用抛 SETTINGS_CONFLICT（测试 fix 的冲突重试环）；默认 0 */
    conflictFirst?: number
}

export interface StubCtx {
    fiber: { store: Record<string, unknown> }
    settings: {
        describe(): Array<{ ns: string; user: Record<string, unknown>; revision: number }>
        mutate(ns: string, ops: SettingsPathOp[], revision: number): Promise<void>
    }
    get(name: string): unknown
    logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
    /** 测试断言入口：取某段的实时段值 */
    userOf(ns: string): Record<string, unknown>
    /** 全部 mutate 调用（含被围栏拒绝的），按调用序；`guard` 为调用当次事件流守卫是否生效 */
    mutateCalls: Array<{ ns: string; ops: SettingsPathOp[]; revision: number; guard: boolean }>
}

/** 应用单条 path op 到段值：set 逐级建中间对象；unset 中间缺失即 no-op */
function applyOp(doc: Record<string, unknown>, op: SettingsPathOp): void {
    const path = op.path.map(String)
    if (op.op === 'set') {
        let cur: Record<string, unknown> = doc
        for (let i = 0; i < path.length - 1; i++) {
            const key = path[i]
            if (!isPlainObject(cur[key])) cur[key] = {}
            cur = cur[key] as Record<string, unknown>
        }
        cur[path[path.length - 1]] = op.value
    } else {
        let cur: Record<string, unknown> = doc
        for (const key of path.slice(0, -1)) {
            if (!isPlainObject(cur[key])) return
            cur = cur[key] as Record<string, unknown>
        }
        delete cur[path[path.length - 1]]
    }
}

/** 构造一个内存 settings 桩 ctx */
export function makeStubCtx(opts: StubCtxOpts = {}): StubCtx {
    const sections = new Map<string, StubSection>([
        [API_NS, { user: structuredClone(opts.api ?? {}), revision: 0 }],
    ])
    if (opts.noPlugin !== true) sections.set(PLUGIN_NS, { user: structuredClone(opts.plugin ?? {}), revision: 0 })
    let conflictsLeft = opts.conflictFirst ?? 0
    const mutateCalls: StubCtx['mutateCalls'] = []

    return {
        fiber: { store: {} },
        settings: {
            describe() {
                return [...sections.entries()].map(([ns, s]) => ({ ns, user: s.user, revision: s.revision }))
            },
            mutate(ns, ops, revision) {
                mutateCalls.push({ ns, ops, revision, guard: isIgnoreAll() })
                const section = sections.get(ns)
                if (!section) return Promise.resolve()
                // 模拟冲突：不校验 revision、不应用 op、不 bump，直接拒绝（测试 fix 的重试环控制流）
                if (conflictsLeft > 0) {
                    conflictsLeft--
                    return Promise.reject({ code: 'SETTINGS_CONFLICT' })
                }
                if (revision !== section.revision) return Promise.reject({ code: 'SETTINGS_CONFLICT' })
                for (const op of ops) applyOp(section.user, op)
                section.revision++
                return Promise.resolve()
            },
        },
        get() { return undefined },
        logger: { info() {}, warn() {}, error() {} },
        userOf(ns) { return sections.get(ns)?.user ?? {} },
        mutateCalls,
    }
}

/** 重置模块级单例（目录 + 配置源），每个用例前调用 */
export function resetModules(): void {
    setConfigSource(() => DEFAULT_CONFIG)
    setCatalog({ catalog: {}, groups: new Map() })
}
