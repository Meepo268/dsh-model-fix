// rpc-carrier.ts 测试：三个写回端点各带一份等待上限——超时是卡片唯一的解占用出口，漏传即挂死
import { check } from '@test/helper'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { makeRpcCarrier } from '@/client/rpc-carrier'

/** 最小 rpc 面桩：只实现 carrier 用到的 `call`，把 signal 记下来供断言 */
function fakeRpc(signals: (AbortSignal | undefined)[]): ClientConnectionRpc {
    return {
        call: async (_channel, _endpoint, _payload, signal) => {
            signals.push(signal)
            return { ok: true, value: {} }
        },
    }
}

/** 执行本文件的全部用例 */
export async function run(): Promise<void> {
    const signals: (AbortSignal | undefined)[] = []
    const carrier = makeRpcCarrier(fakeRpc(signals))
    await carrier.forceUpdate()
    await carrier.resetModels()
    await carrier.restoreModels()
    check('三个写回都带等待上限', signals.length === 3 && signals.every((signal) => signal instanceof AbortSignal && !signal.aborted), signals)
}
