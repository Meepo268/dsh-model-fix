# 工作流：命令、工具链陷阱与测试规范

`AGENTS.md` 只留命令一行与索引，正文在此；仅供开发查阅，不进 `files`。

## 命令

`pnpm build` / `typecheck` / `lint` / `test` / `pack:release`；提交前必跑。

## 工具链陷阱

- `pnpm test` 走专用单对象配置 `tsdown.test.config.ts`；**禁止指回数组主配置**（CLI 参数会合并进每一项、浏览器半的工厂 banner 会污染测试产物）。
- **TS 7 与 ESLint 并存靠 npm 别名**：TS 7 原生版无 JS API，typescript-eslint 见之即抛错。故 `typescript` = `npm:@typescript/typescript6@^6.0.2`（bin 为 `tsc6`），TS 7 挂别名 `@typescript/native`。
- `pnpm lint` 走 `eslint.config.ts`（ESLint 靠 devDep `jiti` 读 TS 配置，脚本保持 `eslint .`）：只排除 `lib/`（构建产物，非本仓源码），其余目录交给 ESLint 默认忽略。硬约束五条——禁相对导入、`consistent-type-imports`，加上三条跨半纯度自定义规则（`AGENTS.md`「导入与打包」有细则）。根目录的 `tsdown.config.ts` / `tsdown.test.config.ts` 与本配置自身都在 lint 范围内。
- 宿主包本地依赖全走 devDeps 且须与宿主 latest 同号；一律用 `pnpm add` 变更（`-E` 保精确、`--save-peer` 写 peer）。**升级只能写具体版本号**（各子包的 `latest` tag 陈旧）。

## 测试规范

`test/` 只收不依赖 DSH 运行时的纯函数与零 ctx 编排（配置解析与迁移、目录拍平与缓存条目校验、id 匹配与档位转换、compat 计划、`planResetModels`/`planRestore`/`planPruneEfforts`/`parsePruneTargets`、`planProbes`/`groupProbesByProvider`/`classifyFailure`/`reportProvider`/`summarizeProviders`、`planEffortApply`/`declaredEffortsOf`、`verifyModels` 与 `probeAndFill` 带桩跑通短路与中止全链路（进度帧序列、`skipped`、早停不发 `done`、未开跑的组不进汇报、探测的预声明→收敛写回结果与终帧统计）、守卫、`rpc-route` 的纯信封逻辑 + node:http 桩、`fix`/`probeAndFill` 编排 + `test/ctx.ts` 的常驻内存 settings 桩（`noPlugin` 可模拟自有段未登记）、浏览器半纯映射层（含探测候选的未填充判据与七档展开）；浏览器组件与真实 fs / 网络不进 `test/`（两个执行器都只依赖注入的 `llm.stream`，故带桩即可，不触网）。`indexedCache` 与 `configSource` 是模块级单例，每个用例前调 `resetModules()`。