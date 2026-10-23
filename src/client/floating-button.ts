/** 悬浮按钮的响应式数据契约：React 外部存储形态（`useSyncExternalStore`），改任一属性即通知订阅者。 */

import type { ReactNode } from 'react'

interface FloatingButtonState {
    icon: ReactNode
    title: string
    active: boolean
    onClick: () => void
}

export interface FloatingButton {
    /** 条目 id：DOM id 与 React key */
    readonly id: string
    subscribe(listener: () => void): () => void
    /** 当前属性快照：引用稳定，属性变了才换引用 */
    getSnapshot(): FloatingButtonState
    set(patch: Partial<FloatingButtonState>): void
}

export function createFloatingButton(id: string, initial: FloatingButtonState): FloatingButton {
    let state = initial
    const listeners = new Set<() => void>()
    return {
        id,
        getSnapshot: () => state,
        subscribe: (listener) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
        },
        set: (patch) => {
            const keys = Object.keys(patch) as (keyof FloatingButtonState)[]
            // 属性没变就不换引用（快照引用稳定是 uSES 的硬要求）
            if (keys.every((key) => state[key] === patch[key])) return
            state = { ...state, ...patch }
            for (const listener of [...listeners]) listener()
        },
    }
}
