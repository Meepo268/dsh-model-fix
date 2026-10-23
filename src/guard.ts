/** 事件流守卫（计数式：可嵌套，解除只折抵一次；写回在途期间段变更事件链短路，理由见 docs/decisions.md「写回端点」） */
let depth = 0

export function startIgnoreAll(): void {
    depth += 1
}

export function endIgnoreAll(): void {
    depth -= 1
}

export function isIgnoreAll(): boolean {
    return depth > 0
}
