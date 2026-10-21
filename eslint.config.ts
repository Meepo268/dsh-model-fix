import type { TSESLint } from 'typescript-eslint'
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import { CLIENT_EXTERNALS, NODE_EXTERNALS } from './scripts/build-externals.mjs'

/** 构建产物目录：非本仓源码，一律不检查 */
const IGNORES = ['lib/', '.tmp-*']

/** 浏览器半 `@/` 值导入的放行根：跨半共享层与本半内部，其余即 Node 半专属源码 */
const BROWSER_ALIAS_ROOTS = ['@/shared', '@/client']

/** 浏览器半允许值导入的宿主包：CLIENT_EXTERNALS 里的 `@deepseek-ai/*` 项（react 系不经此规则），基线外即被打包内联 */
const BROWSER_HOST_BASELINE = CLIENT_EXTERNALS.filter(source => source.startsWith('@deepseek-ai/'))

/**
 * 跨半纯度门禁：Node 半与浏览器半的依赖方向约束。
 *
 * 四条都只判**值导入**：tsconfig 开 verbatimModuleSyntax，且 `consistent-type-imports` 强制纯类型导入
 * 写成 `import type`，故未标 type 的 import 即真正落运行期的依赖——与构建期看得到的依赖集合一致，
 * type-only 导入豁免（跨插件类型协作正是靠它）。
 */
const halfPurity: TSESLint.FlatConfig.Plugin = {
    rules: {
        // Node 半（含共享层）不得值依赖浏览器半
        'no-client-in-node': {
            create: context => ({
                ImportDeclaration(node) {
                    if (node.importKind === 'type') return
                    const source = node.source.value
                    if (source !== '@/client' && !source.startsWith('@/client/')) return
                    context.report({
                        node: node.source,
                        message: 'node bundle purity: 跨半依赖浏览器半（src/client）被禁止；跨半共享须放 src/shared',
                    })
                },
            }),
        },
        // 浏览器半的 `@/` 值导入只放行 `@/shared/*`（跨半共享、零 Node 依赖）与 `@/client/*`（本半内部）
        'shared-only-in-browser': {
            create: context => ({
                ImportDeclaration(node) {
                    if (node.importKind === 'type') return
                    const source = node.source.value
                    if (!source.startsWith('@/')) return
                    if (BROWSER_ALIAS_ROOTS.some(root => source === root || source.startsWith(`${root}/`))) return
                    context.report({
                        node: node.source,
                        message: 'client bundle purity: 越界值导入 Node 半专属源码；'
                            + '浏览器半 @/ 值导入只允许 @/shared/*（跨半共享模块）与 @/client/*（本半内部），'
                            + '其余跨半协作须以字面量/契约复制维护',
                    })
                },
            }),
        },
        // 浏览器半只放行宿主模块表基线内的 `@deepseek-ai/*`：基线外的会被打进包内，运行期拿不到宿主实例
        'baseline-only-in-browser': {
            create: context => ({
                ImportDeclaration(node) {
                    if (node.importKind === 'type') return
                    const source = node.source.value
                    if (!source.startsWith('@deepseek-ai/') || BROWSER_HOST_BASELINE.includes(source)) return
                    context.report({
                        node: node.source,
                        message: `client bundle purity: "${source}" 不在宿主模块表基线内；`
                            + '跨插件只能经 cordis 服务协作（type-only 导入会被擦除、不受此限），'
                            + '或将其加入 scripts/build-externals.mjs 的 CLIENT_EXTERNALS（须确认宿主 platform.ts 提供）',
                    })
                },
            }),
        },
        // 同上：表外即被打包内联，宿主进程没装的包要到运行期 require 才爆
        'baseline-only-in-node': {
            create: context => ({
                ImportDeclaration(node) {
                    if (node.importKind === 'type') return
                    const source = node.source.value
                    if (!source.startsWith('@deepseek-ai/') || NODE_EXTERNALS.includes(source)) return
                    context.report({
                        node: node.source,
                        message: `node bundle purity: "${source}" 不在 NODE_EXTERNALS 内；`
                            + '宿主提供且运行期需要的包须先登记进 scripts/build-externals.mjs（并确认宿主 base 依赖链已装），'
                            + '纯类型协作不受此限',
                    })
                },
            }),
        },
    },
}

export default tseslint.config(
    { ignores: IGNORES },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: { ...globals.node },
            parserOptions: { ecmaFeatures: { jsx: true } },
        },
    },
    {
        // 浏览器半跑在宿主页面里，除 Node 侧的全局外还需 DOM 全局
        files: ['src/client/**/*.{ts,tsx}'],
        languageOptions: { globals: { ...globals.browser } },
    },
    {
        // 浏览器半的 hooks 纪律：调用位置合法 + 依赖数组完整（exhaustive-deps 给 warn，与刻意省略冲突）
        files: ['src/client/**/*.{ts,tsx}'],
        plugins: { 'react-hooks': reactHooks },
        rules: {
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
        },
    },
    {
        files: ['src/**/*.{ts,tsx}', 'test/**/*.ts'],
        rules: {
            // 硬约束：src / test 的一切源码导入走 @/ 与 @test/ 别名（tsconfig paths + tsdown alias 双声明）
            'no-restricted-imports': ['error', {
                patterns: [{
                    group: ['./*', '../*'],
                    message: '源码导入必须以 @/（→ src/）或 @test/（→ test/）开头，禁止相对路径。',
                }],
            }],
            // tsconfig 开 verbatimModuleSyntax：纯类型的导入必须用 import type
            '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
            // 裸表达式无意义且常掩盖漏 await；放行 `void promise` 语句形式（显式放弃 await 的既有约定）
            '@typescript-eslint/no-unused-expressions': 'error',
            'no-void': ['error', { allowAsStatement: true }],
            // smart 豁免 == null 与字面量比较
            'eqeqeq': ['error', 'smart'],
            // 未使用的导入/变量/参数/捕获一律报错（含类型）；导出 symbol 不受影响
            '@typescript-eslint/no-unused-vars': ['error', {
                args: 'all',
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrors: 'all',
                caughtErrorsIgnorePattern: '^_',
                ignoreRestSiblings: true,
            }],
        },
    },
    {
        // Node 半＝src 里除浏览器半以外的全部（含共享层）
        files: ['src/**/*.{ts,tsx}'],
        ignores: ['src/client/**'],
        plugins: { 'half-purity': halfPurity },
        rules: {
            'half-purity/no-client-in-node': 'error',
            'half-purity/baseline-only-in-node': 'error',
        },
    },
    {
        files: ['src/client/**/*.{ts,tsx}'],
        plugins: { 'half-purity': halfPurity },
        rules: {
            'half-purity/shared-only-in-browser': 'error',
            'half-purity/baseline-only-in-browser': 'error',
        },
    },
)
