// guard.ts 测试：事件流守卫的开关语义
import { startIgnoreAll, endIgnoreAll, isIgnoreAll } from '@/guard'
import { check } from '@test/helper'

export function run(): void {
    check('守卫初始为 false', isIgnoreAll() === false)
    startIgnoreAll()
    check('startIgnoreAll 后为 true', isIgnoreAll() === true)
    endIgnoreAll()
    check('endIgnoreAll 后为 false', isIgnoreAll() === false)
    // 计数语义：嵌套持有须全部解除才放行，先结束者不解掉仍在途者的守卫
    startIgnoreAll()
    startIgnoreAll()
    check('嵌套置位期间守卫仍为 true', isIgnoreAll() === true)
    endIgnoreAll()
    check('解除一次后守卫仍为 true（另一持有者在途）', isIgnoreAll() === true)
    endIgnoreAll()
    check('全部解除后为 false', isIgnoreAll() === false)
}
