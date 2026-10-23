# 版本形态：快照与冻结

本文只记配置版本形态的判据与台阶链写法，自含：不引其它 `docs/`。

## 何时递增 CONFIG_VERSION

只在真不兼容时递增：新形态会被旧解析器误读，或旧形态无法被新解析器正确降级。

- 组内新增键与新增顶级组，两端都退得动（旧快照多出未知字段 / 新解析器缺段落默认），**都不升版本**——前提是新增段缺省值与「该段不存在时的行为」一致；缺省会改变既有用户可见行为就该升。
- 当前形态 v8 的默认与键名集中在 `src/shared/config-schema.ts`。
- 版本常量关系：`MIN_SUPPORTED_VERSION`（低于此值的快照视为失效，不读、不选为迁移源、清理时 unset）、`CONFIG_VERSION`（段内键 `version-N` 的 N）、`MAX_OLD_SNAPSHOTS`（低于当前版本的旧快照保留上限，超出从最低起淘汰；当前与更高版本永不删）。

## 冻结形态与台阶链

- 冻结类型：`src/types.ts` 只有 `V7*` 一套。
- 台阶链：`src/upgrade.ts` 只有一段 v7 冻结 schema + `upgradeTo8 → upgradeTo7`（最低一级，守卫校验 `MIN_SUPPORTED_VERSION`，全链唯一版本下限校验）。
- `upgradeToN` 只把低一级升到 N（输入下限 N-1，低于即转交 N-1）。
- 台阶与当前形态**刻意不共享可演进来源**：schema、默认常量、台阶默认值一律就地写字面量，不引用 `CONFIG_VERSION`——否则调一个默认值会连带改写历史台阶语义，破坏高版本快照无损回退。
- 台阶链（`src/upgrade.ts`）与当前版本侧（`src/shared/config-schema.ts` + `src/migrate.ts`）分居文件，互不串改。
- 不变式：`DEFAULT_CONFIG` 与升级链对空输入的产物一致（同批落 `userExperience` 的新键在两侧取同一缺省）。

## 快照保留与降级

- 降级落盘的更高版本快照永不清理，再升级可无损回退。
- 当前快照非法**或残缺**按当前生效值规范化重写；残缺会被补默认判合法，故判据须比对规范化结果而非只判非法。

## 提升 MIN_SUPPORTED_VERSION 的操作步骤

1. 追加新台阶 `upgradeToN+1`（新冻结类型 `VN*` 配套在 `src/types.ts`）。
2. 原最低一级改为中间接力（去守卫、改指新台阶），新台阶自持新的 `MIN_SUPPORTED_VERSION`。
3. 移除旧 `MIN_SUPPORTED_VERSION` 以下的冻结类型与台阶。
4. 更新 `src/shared/config-schema.ts` 的 `MIN_SUPPORTED_VERSION`。

## 附加字段的登记口径

探测兜底备份落在自有段顶层 `probeBackup`，**不进版本快照、不动 `CONFIG_VERSION`**（它不是配置形态，只是崩溃恢复用的落盘副本）。
