// 两半外置宿主包清单（tsdown 与 eslint 共用的单一来源）：外置 = 不打进产物、运行期由宿主 require 兑现。
// 两半提供方不同，各只列实际值导入的包，宿主提供但未用的项记在各表注释里备查。
// 浏览器半基座以宿主 platform.ts 的 PLATFORM_MODULES（冻结表）为准，漂移即 require 未命中。

/** Node 半实际值导入的宿主包（宿主进程 base 依赖链提供）。未用：cordis（仅 type-only）、各服务包（经 ctx 访问）。 @type {readonly string[]} */
export const NODE_EXTERNALS = [
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-util-values',
    '@deepseek-ai/dsh-credentials',
]

/** 浏览器半实际值导入的宿主包（client 包基座提供）。未用：react-dom（本体）、cordis、zod、@tanstack/react-virtual、client-store/ui-slots/ui-dockkit。 @type {readonly string[]} */
export const CLIENT_EXTERNALS = [
    'react',
    'react/jsx-runtime',
    'react-dom/client',
    '@deepseek-ai/dsh-client-ui-primitives',
]
