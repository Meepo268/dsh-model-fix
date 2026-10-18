/**
 * 事件流守卫：本插件任一写回在途期间为 true（写回端点各自置位，探测档位持有整轮）。
 * index.ts 的段变更事件入口最先判定——为 true 时整条事件链短路，防止写回触发填充把刚改动的字段重新写回；
 * refresh 的拉取结算是不经过事件入口的异步续体，须在 refresh 进入处与调 fix 前自查本守卫。
 * 计数而非布尔：持有可嵌套，解除只折抵一次置位，先结束者不解掉仍在途者的守卫。
 * 理由见 docs/decisions.md「写回端点」。
 */
let depth = 0

/** 开启事件流守卫（写回前调用；可嵌套，与解除严格配对） */
export function startIgnoreAll(): void {
    depth += 1
}

/** 解除事件流守卫（写回全部落盘后调用；每次只折抵一次置位） */
export function endIgnoreAll(): void {
    depth -= 1
}

/** 事件流守卫是否生效 */
export function isIgnoreAll(): boolean {
    return depth > 0
}
