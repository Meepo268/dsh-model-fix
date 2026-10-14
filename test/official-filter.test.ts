// official-filter.ts 纯函数测试：settingsPath 收窄、apiKeyEnv 取名
import { apiKeyEnvOf, resolveProfile } from '@/official-filter'
import { check, stable } from '@test/helper'

/** 执行本文件的全部用例 */
export function run(): void {
    // settingsPath 收窄：逐级取键，任一级不是普通对象（含终点非对象）即 undefined
    const segment = { a: { b: { apiKeyEnv: 'X' } }, list: [{ deep: true }] }
    check('resolveProfile 多级命中', stable(resolveProfile(segment, ['a', 'b'])) === stable({ apiKeyEnv: 'X' }), resolveProfile(segment, ['a', 'b']))
    check('resolveProfile 空路径返回整段', stable(resolveProfile(segment, [])) === stable(segment), resolveProfile(segment, []))
    check('resolveProfile 中途非对象即 undefined', resolveProfile(segment, ['a', 'b', 'c', 'd']) === undefined, resolveProfile(segment, ['a', 'b', 'c', 'd']))
    check('resolveProfile 终点非对象即 undefined', resolveProfile(segment, ['list', '0']) === undefined, resolveProfile(segment, ['list', '0']))
    check('resolveProfile 整段非对象即 undefined', resolveProfile(undefined, ['a']) === undefined && resolveProfile('x', []) === undefined)

    // apiKeyEnv 取名：非空字符串优先，其余（缺省/空串/非字符串）回退官方适配器默认名
    check('apiKeyEnvOf 显式声明优先', apiKeyEnvOf({ apiKeyEnv: 'MY_KEY' }) === 'MY_KEY', apiKeyEnvOf({ apiKeyEnv: 'MY_KEY' }))
    check('apiKeyEnvOf 缺省回退 DEEPSEEK_API_KEY', apiKeyEnvOf(undefined) === 'DEEPSEEK_API_KEY' && apiKeyEnvOf({}) === 'DEEPSEEK_API_KEY', apiKeyEnvOf(undefined))
    check('apiKeyEnvOf 空串与非字符串也回退', apiKeyEnvOf({ apiKeyEnv: '' }) === 'DEEPSEEK_API_KEY' && apiKeyEnvOf({ apiKeyEnv: 42 }) === 'DEEPSEEK_API_KEY', apiKeyEnvOf({ apiKeyEnv: '' }))
}
