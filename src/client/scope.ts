/**
 * ConfigForm 的 decode 包装层。
 *
 * 宿主 0.1.7+ 浏览器半 settings 面是 ctx.configForms（ConfigForm：段级读取/写入面）。
 * 本层是 decode 缓存语义：useSyncExternalStore 要求 getSnapshot 引用稳定，
 * ConfigForm 快照引用本身稳定，但 decode 结果每次新造会触发重渲染环，故订阅 form、
 * 快照变化时才重解并替换引用。user 层原样透传（「排除提供方」瓦片的命中判定直接读
 * user 层的 providers 键，与 Node 半 fix 遍历的同一事实源）。写路径透传 form：set 的
 * 宿主接受布尔无消费方、对齐 void；mutate 原样透传宿主裁决布尔（调用方按裁决提示）。
 * 订阅随 dispose 释放，调用方经 ctx.effect 挂入自身 fiber 生命周期。
 *
 * 类型面：ConfigForm/ConfigFormSnapshot 直引 devDep 的
 * @deepseek-ai/dsh-client-ui-settings/client（type-only）；写路径 ops 经 devDep 的
 * @deepseek-ai/dsh-settings 的 SettingsPathOp 传参（与 Node 半 fix.ts 同源），转发时逐字段
 * 浅拷贝为宿主线面 op（SettingsPathOpView，同样直引 dsh-settings 的 /types 子路径）。
 * 唯一收敛处是 `value`：`unknown → JsonValue`，本仓写回链路的取值恒为配置段里的 JSON 值
 * （宿主 schema 与 JSON.parse 两端都管着），故只作断言而不运行时校验——浏览器半不许引宿主
 * 值导入（client 半纯度门禁禁跨插件值导入），用不了 dsh-util-values 的 isJsonValue。
 */
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** decode 后的段视图：快照 value 为解析结果，set 返回 void、mutate 返回宿主裁决，另附订阅释放。 */
export interface DecodedScope<T> {
    getSnapshot(): ConfigFormSnapshot<T>
    subscribe(listener: () => void): () => void
    set(field: string, value: unknown): Promise<void>
    /** 透传宿主裁决：true 为接受，false 为拒绝/跳过（含 memory 模式），传输失败 reject */
    mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<boolean>
    dispose(): void
}

export function makeScope<T>(form: ConfigForm<unknown>, decode: (raw: unknown) => T): DecodedScope<T> {
    let snap: ConfigFormSnapshot<T> = {
        status: 'loading',
        value: undefined,
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
