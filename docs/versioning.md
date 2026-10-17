# 版本纪律：快照与冻结形态

AGENTS.md 只留索引，正文在此；仅供开发查阅，不进 `files`。

## 何时递增 CONFIG_VERSION

**只在真不兼容时递增**——即新形态会被旧解析器误读，或旧形态无法被新解析器正确降级。

组内新增键对旧快照只是「多出一个未知字段」，对新解析器只是「缺一个字段落默认」，两端都退得动，不升版本。
先例：`compat.disableStore` 与 `userExperience` 的 `followParent` / `selfTune` / `hideOfficial` / `localizeEfforts` / `showOriginalEfforts` 均在 v8 形态内先后落地，始终未升版本；台阶侧同步补 `V8_*_DEFAULT` 字面量。

**新增顶级组同样不升版本**，判据与组内新增键一致：旧快照里整段缺失，对新解析器只是「缺一段落该段默认」。
先例：`behavior`（UI 可见性，四项默认全开）在 v8 形态内新增顶级组，未升版本——此前落盘的 v8 快照没有这一段，
解析与降级都落全开值，恰是出厂默认，故既有观感不变。台阶侧（`src/upgrade.ts`）同步补该段字面量默认值。

**前提是新增段的缺省值必须与「该段不存在时的行为」一致**：缺省全开时，缺段的老用户看到的就是和升级链补出来的同一份配置。
若新增顶级组的缺省会改变既有用户可见的行为（哪怕只是多出一块 UI），那就该升版本。

当前形态 v8 的各默认与键名集中在 `src/shared/config-schema.ts`（跨半共享，浏览器半安全导入）。

## 冻结形态与台阶链

- 冻结类型：`src/types.ts` 里只有 `V7*` 一套。
- 台阶链：`src/upgrade.ts` 里只有一段 v7 冻结 schema + 两级台阶：`upgradeTo8 → upgradeTo7`（最低一级，守卫校验 `MIN_SUPPORTED_VERSION`）。
- 台阶写法：`upgradeToN` 只负责把低一级的配置升到 N（输入下限 N-1，低于即转交 N-1）；最低一级的守卫是全链唯一的版本下限校验。
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
