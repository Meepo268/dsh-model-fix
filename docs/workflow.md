# 工作流：命令、工具链陷阱与测试规范

`AGENTS.md` 只留命令一行与索引，正文在此；仅供开发查阅，不进 `files`。

## 命令

`pnpm typecheck` / `lint` / `test` / `build`；提交前必跑。**只认这些已定义脚本，禁止裸命令**——不得绕开 pnpm 直跑 `tsc` / `eslint` / `tsdown` 等 bin：脚本是参数与配置发现的唯一收口（`tsdown --config tsdown.test.config.ts`、`eslint.config.ts` 经 jiti 读取都挂在脚本上），裸跑漏一个开关就与提交前验证不等价。

## 工具链陷阱

- **pnpm 脚本必须直接在 shell 里跑，不得经 Node 子进程包裹**：沙箱（workspace-write）下从 Node 的 `child_process` 启动 `pnpm` 会被拦——Node 侧报 `spawn EPERM`。
- `pnpm test` 走专用单对象配置 `tsdown.test.config.ts`；**禁止指回数组主配置**（CLI 参数会合并进每一项、浏览器半的工厂 banner 会污染测试产物）。
- **TS 7 与 ESLint 并存靠 npm 别名**：TS 7 原生版无 JS API，typescript-eslint 见之即抛错。故 `typescript` = `npm:@typescript/typescript6@^6.0.2`（bin 为 `tsc6`），TS 7 挂别名 `@typescript/native`。
- `pnpm lint` 走 `eslint.config.ts`（ESLint 靠 devDep `jiti` 读 TS 配置，脚本保持 `eslint .`）：只排除 `lib/`（构建产物，非本仓源码），其余目录交给 ESLint 默认忽略。硬约束五条——禁相对导入、`consistent-type-imports`，加上三条跨半纯度自定义规则（`AGENTS.md`「导入与打包」有细则）。根目录的 `tsdown.config.ts` / `tsdown.test.config.ts` 与本配置自身都在 lint 范围内。
- 宿主包本地依赖全走 devDeps 且须与宿主 latest 同号；一律用 `pnpm add` 变更（`-E` 保精确、`--save-peer` 写 peer）。**升级只能写具体版本号**（各子包的 `latest` tag 陈旧）。
- **钩子脚本读 stdin 只能异步**：Windows 上 stdin 是管道时 `fs.readFileSync(0)` / `fs.readSync(0)` 会抛 `EOF`（nodejs/node#35997），而 git 正是用管道把 pre-push 清单喂给钩子的，故 `scripts/check-tag.mjs` 走 `process.stdin` 异步迭代。

## Git 钩子

由 `@pyyupsk/nit` 管理：配置写在 `package.json` 的 `nit.hooks`，`.git/hooks/` 下的脚本由 `nit install` 生成两道：

- `pre-commit` → `scripts/check-version.mjs`：README 钉死的 tarball 链接须与 `package.json` 的 version 同号。
- `pre-push` → `scripts/check-tag.mjs`：一次只允许推一个标签，且它须是 v + 语义化版本并与 version 同号；没有标签要推则静默通过。

发布链（`.github/workflows/release.yml`）**不再重复这两道校验**，只跑 install / lint / typecheck / test / pack，故钩子就是这两条纪律的唯一闸门。

## 测试规范

`test/` 只收不依赖 DSH 运行时的纯函数与零 ctx 编排（配置解析与迁移、目录拍平与缓存条目校验、id 匹配与档位转换、compat 计划、`planResetModels`/`planRestore`、`planProbes`/`groupProbesByProvider`/`classifyFailure`/`reportProvider`/`summarizeProviders`、`planEffortApply`/`declaredEffortsOf`、`verifyModels` 与 `probeAndFill` 带桩跑通短路与中止全链路（进度帧序列、`skipped`、`done ≤ total` 不变量、早停不发终帧、中止不入账也不短路、未开跑的组不进汇报、探测的预声明→收敛写回结果与终帧统计）、`probeOnce` 的超时兜底（`timeoutMs`/`graceMs` 两个可选参数传入小值在毫秒级验证：适配器忽略 signal 时仍自行返回 timeout、外部中止优先归 aborted、被放弃的循环不再消费分片且迭代器被请求关闭、命中即返回时中止信号先于迭代器关闭发出且不等关闭 settle、迟来拒绝不产生未处理拒绝；`runProbeGroups` 组合层在底层探测挂死时 `Promise.all` 仍 settle）、守卫、`rpc-route` 的纯信封逻辑 + node:http 桩、`rpc` 的进度流（标准 `Request`/`Response` 驱动：正常转发、异常发 `failed` 终帧、中止不发终帧、非法请求体 400）、`refresh` 的卸载清理（替换全局 `fetch` 桩：在途拉取时不复位以保单飞、重试等待期卸载后不再永久早退）、`fix`/`probeAndFill` 编排 + `test/ctx.ts` 的常驻内存 settings 桩（`noPlugin` 可模拟自有段未登记、`mutateCalls` 逐次记下当次守卫状态）、浏览器半纯映射层（含探测候选的未填充判据与至多七档展开）；浏览器组件与真实 fs / 网络不进 `test/`（两个执行器都只依赖注入的 `llm.stream`，故带桩即可，不触网）。`indexedCache` 与 `configSource` 是模块级单例，每个用例前调 `resetModules()`；`refresh.ts` 的 `refreshing`/`retryTimer` 亦是模块级单例，用例收尾须再调 `cancelRefreshRetry()` 清掉；`probeOnce` 超时兜底用例挂了 `process.on('unhandledRejection')` 监听，用例收尾必须 `off` 还原。
