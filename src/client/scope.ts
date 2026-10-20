/** ConfigForm 的 decode 包装层。
 * decode 缓存语义：useSyncExternalStore 要求 getSnapshot 引用稳定，ConfigForm 快照引用本身稳定，但 decode 结果每次新造会触发重渲染环，故订阅 form、快照变化时才重解并替换引用。user 层原样透传（「排除提供方」瓦片的命中判定直接读 user 层的 providers 键，与 Node 半 fix 遍历的同一事实源）。
 * 类型面：ConfigForm/ConfigFormSnapshot 直引 devDep 的 `@deepseek-ai/dsh-client-ui-settings/client`（type-only）；写路径 ops 转发时逐字段浅拷贝为宿主线面 op（`SettingsPathOpView`）。唯一收敛处是 `value`：`unknown → JsonValue` 只作断言而不运行时校验——浏览器半受 client 半纯度门禁约束，用不了 `isJsonValue` */
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** decode 后的段视图：快照 value 为解析结果，set 返回 void、mutate 返回宿主裁决，另附订阅释放 */
export interface DecodedScope<T> {
    getSnapshot(): DecodedSnapshot<T>
    subscribe(listener: () => void): () => void
    set(field: string, value: unknown): Promise<void>
    /** 透传宿主裁决：true 为接受，false 为拒绝/跳过（含 memory 模式），传输失败 reject */
    mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<boolean>
    dispose(): void
}

/** 宿主快照的收窄面：`status` 等状态字段原样保留（消费方要区分 loading / unavailable），只收紧 `value` */
export type DecodedSnapshot<T> = Omit<ConfigFormSnapshot<T>, 'value'> & { value: T }

export function makeScope<T>(form: ConfigForm<unknown>, decode: (raw: unknown) => T): DecodedScope<T> {
    const fallback = decode(undefined)
    let snap: DecodedSnapshot<T> = {
        status: 'loading',
        value: fallback,
        base: undefined,
        user: undefined,
        revision: undefined,
        writable: false,
        mode: 'host',
    }
    const listeners = new Set<() => void>()
    /** form 变化时重建快照引用（useSyncExternalStore 的稳定引用契约：变化前同一引用） */
    const sync = (): void => {
        const s = form.getSnapshot()
        snap = {
            status: s.status,
            value: decode(s.value),
            base: s.base,
            user: s.user,
            revision: s.revision,
            writable: s.writable,
            mode: s.mode,
        }
        for (const listener of [...listeners]) listener()
    }
    const off = form.subscribe(sync)
    sync()
    return {
        getSnapshot: () => snap,
        subscribe: (listener) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
        },
        set: (field, value) => form.set(field, value).then(() => undefined),
        mutate: (ops, expectedRevision) => form.mutate(
            ops.map((op): SettingsPathOpView => (
                op.op === 'set'
                    ? { op: 'set', path: [...op.path], value: op.value as JsonValue }
                    : { op: 'unset', path: [...op.path] }
            )),
            expectedRevision,
        ),
        dispose: () => {
            off()
            listeners.clear()
        },
    }
}
