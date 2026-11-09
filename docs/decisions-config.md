# 裁决：配置形态与填充

## 快照

- **解析优先级**：当前版本快照 → ≥ 最低支持的最高可解析快照（降级解析，多余键忽略、`efforts` 宽松保留）→ 内置默认。降级落盘的更高版本快照永不清理。

## 排除与列表

- **`excludes` 是「零操作排除」**：命中者在 provider 循环入口整条跳过，已写入值原地保留（本仓无字段来源记录，清除必误删）。
- **必须允许填入不存在的 id**，故不做候选约束；命中判据取 `llm-pi-ai` user 层 `providers` 键（与 `fix` 遍历同源）。
- **不自动清理失效 id**：去重两层——录入端当场拒写、`selfHealConfig` 兜手改文件（仅 `Set` 收窄变短才产出 op）。`fix` 写回只写 `llm-pi-ai` 段，不碰自有 NS 键。

## 参数来源

- **优先级：手填 > 上游声明 > models.dev**，逐维（档位 / 上下文 / 输出上限 / 模态）覆盖、逐维回落：某个维度上游没声明就取目录，目录没有就保持原样。
- **上游声明 = 供应商端点自报**（`GET {baseURL}/models` 里的 `reasoning_supported_efforts` / `reasoning_options` / `context_window` / `max_output_tokens` / `input_modalities` 等变体）。抓取按**归一化 URL**（去尾斜杠）缓存 6 小时、失败态缓存 1 分钟，同地址的多条路由共享一次请求；密钥经 `ctx.credentials` 现解析（`apiKeyEnv` 是引用名，解析失败就发匿名请求）；单点失败静默回落目录——网络抖动不该拦下填充。
- **各家 `/models` 不标准，按「宽收 + 宁缺不错配」处理**：外壳认裸数组、`{data:[…]}`、`{models:[…]}`；id 认 `id` / `model`；**档位**认 `reasoning_options[].values` / `reasoning_levels[]` / `supported_reasoning_levels[].effort` / `reasoning_supported_efforts` / `supported_parameters.reasoning_efforts` / `capabilities.reasoning_efforts`（小写化、`none`→`off`、过滤 harness 不认的取值）；**上下文**认 `context_window` / `context_length` / `max_input_tokens` / `limit.context` / `top_provider.context_length` / `max_context_length`；**输出上限**认 `max_output_tokens` / `max_completion_tokens` / `limit.output` / `top_provider.max_completion_tokens` / `max_tokens`；**模态**认 `input_modalities` / `architecture.input_modalities` / `supports_images` / `modalities.input` / `capabilities.vision`。三套血统都在名单里——OpenRouter 系（`context_length`、`architecture.*`、`top_provider.*`）、LiteLLM 系（`max_input_tokens` / `max_output_tokens`）、models.dev 镜像系（`reasoning_options`、`limit.*`、`modalities.*`），外加网关自造键（`reasoning_levels`、`supported_reasoning_levels`、`reasoning_supported_efforts`）。**声明按 id 取值时做两次归一**（原样 → 剥前导命名空间 → 剥后同形唯一命中），因为网关自报的 id 常与它接受调用的 id 不同形；仍只采纳唯一命中。路径上主取 `{baseURL}/models`，**仅当 404/405 且 baseURL 无版本段时**再试一次 `{baseURL}/v1/models`（401/超时不重试）。任何一条对不上就逐维回落目录，写不出占位值。
- **三个维度的合并口径不同，别当 bug 报**：**档位是并集**（多源全收、去重，顺序即写盘键序——新增来源只会让档位变多，不会挤掉已有来源）；**容量是先到先得**（取第一个合法值，所以语义含糊或后加的键必须排在候选表末尾，否则会顶掉更确定的来源；`max_tokens` 正因「有的网关指输出上限、有的指上下文」被压到末位）；**模态是任一为真即真**。实现见 `src/upstream.ts` 的 `effortCandidates` / `imageOf` / `parseDeclarations` 注释。
- **指纹冻结**：插件在自己段里维护 `written` 表（`<provider> → <model> → 四字段紧凑指纹 + 各字段来源`）。当前值与指纹不一致 ⇒ 判为用户手改，**该字段永不被自动来源覆盖**；无记录同样按手改处理（升级前的存量值不会被突然改写）。
- **`allowUpdate` 的真实语义 = 「允许刷新插件自己写过的字段」**：指纹一致才刷新，且只允许同级或更高级的来源（`u` 上游 2 > `c` 目录 1 > 无记录 1）。因此 `c → c` 是「目录更新了就跟着更新」，`u → c` 永不允许（上游端点一时连不上时，目录值不会把网关声明顶掉）。`force` 是单次全放开。
- **`sources` 是逐模型 pin**（键 `<provider>/<model>`）：缺省 / 空串 = 自动（上游声明 > 目录）；`upstream` = 只认上游声明；`<provider>/<id>` = 只认目录里那一家提供方的条目。pin 行不受指纹冻结（用户显式指定优先），但陈旧 pin（目录刷新后条目消失）回落自动，免得下拉一直显示失效值。
- **`image` 只缓存正向信息**；容量哨兵与 0 视为无数据（写 0 会被宿主 schema 拒绝并连累整批）。
- **缓存结构**`{providerId: {api?, models: {modelId: {api?, ...记录}}}}`：组级 `api` 取 models.dev 的 `provider.api`，模型级 `api` 取该模型的 `provider.api`（两者可能不同）。两者都缺即无端点；端点表两类都登记，严格字符串匹配、不做归一。
- **id 匹配宁可漏不错配**（级联与判据见 `src/lookup.ts` 的 `lookup` 注释）。
- **三级级联全未命中时，才启用两级兜底**（`src/lookup.ts` 的 `lookupStripped` / `lookupByName`）：
  1. **剥前导命名空间前缀**（`/^[a-z0-9][a-z0-9_-]*:/`，`cn:deepseek-v4-pro` → `deepseek-v4-pro`）。只剥开头且冒号后还有内容的；**末段冒号是模型自带 tag**（`kenari/hy3:free`），剥了会把两个模型认成一个。
  2. **显示名**归一（小写、非 id 字符压成 `-`、保留 `.`）及去掉首段厂商标识（`Xiaomi MiMo-V2.6-Pro` → `mimo-v2.6-pro`）；受 `userExperience.nameFallback` 控制（默认开）。
  兜底阶段**域不明**（同一 id 散在多家提供方，`lookup` 的全局阶段遇到第二个提供方就放弃），故改用**逐维多数声明**：四个维度各自投票，**缺席不算反对票**，某取值在有声明者中占比过线才采纳（剥前缀 50%、显示名 60%），容量并列取较小；某维凑不出多数就留空，四维全空才算无匹配。实测（2026-10-26 的 893KB 目录快照 + wk7002 的 18 个 `cn:` 模型）：纯 id 命中 0/18，加兜底后 17/18（唯一未命中的 `cn:kimi-k2.8-preview` 目录里确实没有）。
- **入口放在提供方卡片**（`settings.models.provider-card` 席位）：模型一多，插件卡片底部的入口就找不到了。该席位按 `entryKey = settingsNs` 定向分发，而自定义提供方全都挂在 `llm-pi-ai` 这一个设置文档下（`settingsPath: ['providers', <id>]`），故注册键取 `API_NS`；另按每个提供方 id 各注册一份兜底（个别适配器以提供方 id 作 settingsNs，未命中的键无副作用）。提供方 id 由席位的 owner props（`provider.provider`）当场取，取不到退回注册键。
- **候选枚举与折叠**（`collectCandidates`）：先逐提供方取首个三级命中（最多 8 条），再补「同族变体」（末段 id 互相包含且长度 ≥ 4，`-free` / `-thinking` / `-fast` / `@eu` / 版本号后缀等）。**变体永不进入自动匹配**，只作手动候选——否则「尽量匹配」会替用户选错通道。同值镜像按 `末段 id|四字段指纹` 折成一行并标 `+N`：实测一个 `glm-5.3-flash` 有 83 条目录命中，不折叠的话变体会被镜像挤出候选。
- **pin 行整体落一遍**：在这里选了来源即按该来源重填四个维度（手填值会被覆盖一次，这是显式意图）；pin 指向的目录条目若因目录刷新消失，回落自动且下拉显示「自动」，不显示失效值。
- **未命中提示**：自动来源既无上游声明、目录里也没有唯一命中（或多组不同参数）时，弹层该行给一句「请手工填入或指定来源」，模型行标「未命中」；提供方卡片的入口旁另标「N 个模型未命中」（排除列表里的提供方不计数——本插件本来就不动它）。**不写占位值、不弹窗、不计入变更数**。
- **目录状况必须可见**（0.38.3）：`getCatalog()` 为空时，下拉只剩「自动 / 只用上游声明」、每一行都标未命中——现象与「这个模型确实不在目录里」一模一样，光看界面分不出。故快照增加 `catalog`（`SourceCatalogView`）：`setCatalog` 记账提供方数 / 模型总数与装载来源，`catalogInfo()` 读取，弹层顶部常驻一行「目录：N 家提供方 · M 个模型（时间戳）」——时间戳取「这份目录何时取得」：`network` 是抓取时刻、`cache` 是缓存文件的修改时刻（`formatStamp` 精确到分钟）；为空时直接写出最近一次失败原因。`readCache()` 不再静默：原因记进 `catalogInfo()` 并经 `ctx.logger.warn` 落日志（`src/catalog.ts`）。
- **打开弹层即自愈**：`handleSources` 发现索引为空就当场重读一次磁盘缓存（`readCache` → `setCatalog`），启动链因竞态或异常没填上时，下拉能当场恢复而不必重启；重读仍失败时由上面那行把原因带出来。
- **静态端点补全表**（`PROVIDER_API_FALLBACKS`）：只收端点固定稳定的主流提供方；自带 api 时以其为准。账号级 / 环境变量决定的端点不入表。- **缓存诚实保留目录的 off/none 拼写，不归一不合成**；`toReasoningEfforts` 写 `off` 键用目录原值而非 `null`（`null` 宿主语义是「省略参数」）。
- **档位只代表「能通」，不代表「能关」**：探测不为未声明 off 的模型补 off 档，已声明的探测其原值、不做拼写切换。

## 填充与写回

- **`allowUpdate` 含缺失补写，`autoFill` 关闭不拦**：语义是「以目录为准同步该字段」——但只对**插件自己写过、且现值仍等于指纹**的字段生效（判据见上节「指纹冻结」）；新旧相同跳过，目录无档位不删已有配置。
- **`force` 是单次绕过**：三项临时为真、不落存储、不重拉目录；`fix` 返回值只计模型变更数（compat 不计入）。
- **`fix` 读 `descriptor.user`（原始用户段）**：避免规范化形态与写入形态不一致反复触发重写；写失败先告警再抛出。
- **空壳字段判据只有 `stripEmptyFields` 一处**：五条写回路径（`fix` 填充、`reset`、`restore`、`fill` 两次写回、`probe-backup` 回退）统一过它。无空壳返回原引用，调用方以引用相等判「无需重建」。`compat.ts` 的路由级整段 `unset` 不经此函数。
- **compat「开启即添加、关闭即移除」，与模型参数取向相反**（后者关闭只是不写、存量保留）。只写路由级（模型级优先会与用户取值打架），非目标协议仅残留清理且 provider 无 `api` 字段时跳过。

## 写回端点

- **写回一律带 revision 围栏、冲突重读重算**（`MAX_ATTEMPTS` 见 `src/shared/constants.ts`）：冲突后按旧段回放整段 set 会盖掉他方刚写入的内容。
- **`queueTask` 对 HMR 注入做有界等待**（`HMR_WAIT_MS`）：不能用组件级 `inject`（PENDING 无超时，hmr 缺席会永久挂死整插件）。
- **重置不写配置段、不改开关**；竞态靠 Node 半模块级计数守卫（置位先于 mutate 同步完成，持有可嵌套、解除只折抵一次）。
- **恢复是整批回退，不受 `excludes` 约束**：共有 model 回退 + 被删 model 复活（备份原序追加末尾）；被整删的 provider 不复活；启动后新增原样保留。备份只在 `apply` 最顶部捕获一次（晚于写回捕到的是填充过的内容）；备份缺失或当前无 `providers` 段显式抛错。
- **三个写回端点各带等待上限（`WRITEBACK_MS`）**：上限只中止等待、不声称写回未发生（客户端中断传不到 handler，Node 半照跑完）；不与卡片卸载联动。
- **`sources` / `setSource`（参数来源两端点）走同一条 channel**：`sources` 只读（读配置 + 目录 + 上游声明后出快照），`setSource` 只写自有段的 `sources` 表一行、写完不自己再跑一轮填充——由 `settings/document-updated` 的既有接线触发。两端点共用 `WRITEBACK_MS` 作等待上限。
- **`sources` 顺带自愈目录索引**：`handleSources` 读到空索引时重读一次磁盘缓存后再出快照——只读端点不写配置，重读是纯收益；失败原因经快照的 `catalog` 字段回给弹层。
- **生命周期守卫 = 「只有明确的假才算卸载」**（`src/lifecycle.ts` 的 `alive(ctx)`）：cordis 4 的 `ctx.fiber.store` 在装载期是依赖快照、`_unload()` 置 `undefined`，旧代码据此在 26 处写回点守卫。但 DSH 0.2.1-rc.5 实测该字段**一直**是 `undefined`，于是启动链不读缓存、填充不写、拉取不落盘，且没有任何日志——故障现象是「插件活着，什么都没做」。现判据：`fiber` 缺失（拿错 ctx）回 `false`；`fiber.store === undefined` 视为**无法判定**，按「仍在装载」继续执行并留一条告警；只有明确的假值才回 `false`。真正的写回失败各自有 catch 与告警，代价远小于整条链静默死掉。
- **运行期日志落文件、默认关闭**（`src/log.ts` 的 `logLine`）：DSH 桌面端不写运行期日志，插件的 `ctx.logger.warn` 无处落地，导致「什么都不做」的故障无从定位。日志写 `lib/model-fix.log`（与缓存同目录），超 128 KiB 轮转成 `.1`，串行队列 + `appendFile`，**永不抛错、永不阻塞主流程**；启动链每一跳、声明/目录抓取结果、三个手动端点各记一条。开关是配置项 `debugLog`，卡片「诊断」组末尾的【记录日志】按钮切换（改草稿、保存才落盘），默认关——平时开着等于给每次启动留一份没人看的文件。存储侧沿用「默认不写键」的规矩：只在为 `true` 时出现，旧快照与整配置断言都无需迁移；`logLine` 关着时第一行就返回（连 `stat` 都不做）。
- **`refreshDeclarations`（刷新声明）语义 = 只绕缓存，不绕闸门**：先 `clearUpstreamCache()` 再当场重抓，随后走 `fix(ctx)`（**`force=false`**）——刷新不是「覆盖手改值」的授权，指纹冻结与 `allowUpdate` 开关照旧生效。它是声明 6 小时 TTL 的唯一手动出口：TTL 到期本身不产生抓取，必须有一次触发（启动 / 保存模型配置 / 本端点），故没有这个键就只能等下一次事件。等待上限单列 `DECLARATION_REFRESH_MS`（25 秒，抓取本身最长 10 秒 + 一轮填充），连点由 `DECLARATION_REFRESH_THROTTLE_MS`（10 秒）挡掉并回 `throttled: true`。
- **`fetchCatalog`（拉取目录）= 换数据，不换写法**：`fetchLatest(ctx)` 重抓 models.dev 的目录 JSON → `setCatalog(indexed, 'network')` → `fix(ctx)`（`force=false`）。它解决的是**目录侧**的时效问题：目录只在启动链 6 小时过期时才自动重拉，「上游改了但目录还旧」原先没有任何人工出口。**失败不阻塞**是硬要求：抓取自带 `FETCH_MS`（10 秒）超时，失败即以错误结果返回、界面只出一条提示；客户端等待上限单列 `CATALOG_REFRESH_MS`（30 秒：抓取 10 秒 + 写缓存 3 次重试 + 一轮填充），超时按写回超时提示收尾。返回值带 `{ providers, models, changed, written }`，`written` 由 `cacheWriteInfo()` 前后对比得出——「抓到了但没落盘」与「根本没抓到」在界面上长得一样，这一位就是为了把两者分开。
- **两个入口按场景分工**：卡片「立即更新」= 我要它生效（激进，覆盖手改，`force=true`）；「参数来源」弹层「刷新数据」= 数据旧了（保守，只补空），一次点击**先取目录再取声明**（顺序不可反：目录是「按名字找参数」的底座，先取声明会拿旧目录去匹配，白抓一次），两条端点在服务端各留一个，前端连调两次并合成一条提示。卡片上原先独立的「拉取目录」键已取消——目录为空这件事是在弹层里被看见的，修复入口就放在看见问题的地方。
