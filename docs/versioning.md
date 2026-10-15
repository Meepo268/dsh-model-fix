# 版本纪律：快照与冻结形态

AGENTS.md 只留索引，正文在此；仅供开发查阅，不进 `files`。

## 何时递增 CONFIG_VERSION

**只在真不兼容时递增**——即新形态会被旧解析器误读，或旧形态无法被新解析器正确降级。

组内新增键对旧快照只是「多出一个未知字段」，对新解析器只是「缺一个字段落默认」，两端都退得动，不升版本。
先例：`compat.disableStore` 与 `userExperience` 的 `followParent` / `selfTune` / `hideOfficial` / `localizeEfforts` / `showOriginalEfforts` 均在 v8 形态内先后落地，始终未升版本；台阶侧同步补 `V8_*_DEFAULT` 字面量。

当前形态 v8 的各默认与键名集中在 `src/shared/config-schema.ts`（跨半共享，浏览器半安全导入）。

## 冻结形态与台阶链

- 冻结类型：`src/types.ts` 里只有 `V7*` 一套。
- 台阶链：`src/upgrade.ts` 里只有一段 v7 冻结 schema + 一级 `upgradeTo8`（最低一级、自持 `MIN_SUPPORTED_VERSION` 守卫）。
- 台阶写法：当前台阶按 `upgradeToN` 命名；它是最低一级，输入版本下限恰为 `MIN_SUPPORTED_VERSION`。
- 台阶与当前形态**刻意不共享任何可演进来源**：schema、默认常量、台阶默认值一律就地写字面量，不引用 `CONFIG_VERSION`——否则今天调整一个默认值，明天就会连带改写历史台阶的语义，破坏高版本快照的无损回退。
- 台阶链（`src/upgrade.ts`）与当前版本侧（`src/shared/config-schema.ts` + `src/migrate.ts`）分居文件，互不串改。

## 本次重构

MIN_SUPPORTED_VERSION 从 3 提升到 7，v3–v6 台阶、冻结类型与对应测试一并移除。
v7 成为唯一历史台阶，固化不变；v8 是当前形态，`upgradeTo8` 是最低一级、自持守卫。
`pruneOps` 的 Phase A 会把 `< MIN_SUPPORTED_VERSION` 的快照清掉，`resolveConfig` 与 `migrateConfig` 的候选过滤也按该下限筛过——v1–v6 快照既不读也不迁移。

## 提升 MIN_SUPPORTED_VERSION 的操作步骤

当未来需要再次提升时：

1. 追加新台阶 `upgradeToN+1`（写新冻结类型 `VN*` 配套在 `src/types.ts`）。
2. 当前最低一级改为中间接力，去掉它的守卫，改指新台阶；新台阶自持新的 `MIN_SUPPORTED_VERSION`。
3. 把旧 `MIN_SUPPORTED_VERSION` 以下的冻结类型和台阶一并移除。
4. 更新 `src/shared/config-schema.ts` 里的 `MIN_SUPPORTED_VERSION` 常量。
