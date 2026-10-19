/** 事件流守卫（计数式：可嵌套，解除只折抵一次；写回在途期间段变更事件链短路，理由见 docs/decisions.md「写回端点」） */
let depth = 0

/** 开启守卫（写回前调用，与解除严格配对） */
export function startIgnoreAll(): void {
    depth += 1
}

/** 解除守卫（每次折抵一次置位） */
export function endIgnoreAll(): void {
    depth -= 1
}

/** 守卫是否生效 */
export function isIgnoreAll(): boolean {
    return depth > 0
}
