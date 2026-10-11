import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

/** 浏览器半模块 id：必须用包名（client-modules 以 package.json name 注册 __ModuleLoader__ 行） */
const CLIENT_ID = 'dsh-model-fix'

/** `@` → src 目录（tsdown 不读 tsconfig paths，必须在此显式声明；test 构建见 tsdown.test.config.ts） */
const SRC_ALIAS = { '@': fileURLToPath(new URL('./src', import.meta.url)) }

/**
 * 外置 specifier 清单：宿主模块表在运行期提供的包，外置后由宿主 require 兑现；其余一律打进包内。
 * 与宿主 `DSH/packages/client/web/src/platform.ts` 的 PLATFORM_MODULES 对齐，漂移即运行期 require 未命中。
 * 与 `eslint.config.ts` 的 `BROWSER_HOST_BASELINE` 同源（同一张表），改动须两边同步。
 */
const HOST_EXTERNALS = [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
]

const isExternal = (specifier: string): boolean =>
    (HOST_EXTERNALS as readonly string[]).includes(specifier)

/**
 * 版本号的唯一来源 = package.json。浏览器半运行在浏览器里、读不到磁盘，且 src 内禁相对导入
 * （package.json 无法作为值导入），故在构建期读入、由 define 内联成字符串字面量 ⇒ 运行期零成本、
 * 零漂移：升版照常只改 package.json 一处，测试构建不涉及本标识（测试图只引 @/client/model 与 @/client/effort）。
 */
const PKG = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig([
    // ---------- Node 半：宿主侧插件本体 ----------
    {
        name: 'node',
        entry: ['src/index.ts'],
        outDir: 'lib',
        format: ['esm'],
        platform: 'node',
        target: 'es2024',
        fixedExtension: false,
        dts: false,
        clean: true,
        // public/ 下的文件逐个平铺复制到 outDir 根
        // copy 传目录条目时会把目录名一起带进 outDir（public → lib/public），故用 glob + 默认 flatten:true 逐文件落位。
        copy: [{ from: 'public/*' }],
        alias: SRC_ALIAS,
    },
    // ---------- 浏览器半：web-ui 卡片（lazy-CJS 工厂产物，格式复刻 harness clientBundle 预设） ----------
    {
        name: `${CLIENT_ID}/client`,
        entry: { client: 'src/client/index.tsx' },
        outDir: 'lib',
        // 与 node 半同目录：clean 必须关闭（node 半已负责清理），entryFileNames 钉死 lib/client.js
        clean: false,
        format: 'cjs',
        platform: 'browser',
        target: 'es2024',
        fixedExtension: false,
        dts: false,
        // 与 node 半一致：不开 sourcemap（浏览器半 map 会内嵌 sourcesContent 全源码，随包发布只增体积）
        sourcemap: false,
        define: {
            // 被 inline 的依赖可能读取 node 惯用环境变量，CJS 产物中必须替换掉
            'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
            'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
            'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
            // 卡片末尾的版本标记（声明见 src/client/card-meta.tsx 的 __PLUGIN_VERSION__）
            __PLUGIN_VERSION__: JSON.stringify(PKG.version),
        },
        deps: {
            // 外置的交给宿主 require，其余一律打进包内（浏览器半只留纯逻辑与宿主原语引用）
            neverBundle: isExternal,
            alwaysBundle: (specifier: string) => !isExternal(specifier),
        },
        alias: SRC_ALIAS,
        outputOptions: {
            entryFileNames: 'client.js',
            // 宿主 __ModuleLoader__ 的闭包工厂契约（banner/intro/footer 三段缺一不可）
            banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
            intro: 'var module = { exports: {} }; var exports = module.exports;',
            footer: 'return module.exports; } });',
        },
    },
])
