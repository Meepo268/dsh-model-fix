# 版本纪律：快照与冻结形态

## 何时递增 CONFIG_VERSION

只在真不兼容时递增（新形态会被旧解析器误读，或旧形态无法被新解析器正确降级）。组内新增键与新增顶级组两端都退得动（旧快照多出未知字段 / 新解析器缺段落默认），都不升版本——前提是新增段缺省值与「该段不存在时的行为」一致（缺省会改变既有用户可见行为就该升）。当前形态 v8 的默认与键名集中在 `src/shared/config-schema.ts`。

## 冻结形态与台阶链

- 冻结类型：`src/types.ts` 只有 `V7*` 一套。
- 台阶链：`src/upgrade.ts` 只有一段 v7 冻结 schema + `upgradeTo8 → upgradeTo7`（最低一级，守卫校验 `MIN_SUPPORTED_VERSION`，全链唯一版本下限校验）。
- `upgradeToN` 只把低一级升到 N（输入下限 N-1，低于即转交 N-1）。
- 台阶与当前形态**刻意不共享可演进来源**：schema、默认常量、台阶默认值一律就地写字面量，不引用 `CONFIG_VERSION`——否则调一个默认值会连带改写历史台阶语义，破坏高版本快照无损回退。
- 台阶链（`src/upgrade.ts`）与当前版本侧（`src/shared/config-schema.ts` + `src/migrate.ts`）分居文件，互不串改。

## 提升 MIN_SUPPORTED_VERSION 的操作步骤

1. 追加新台阶 `upgradeToN+1`（新冻结类型 `VN*` 配套在 `src/types.ts`）。
2. 原最低一级改为中间接力（去守卫、改指新台阶），新台阶自持新的 `MIN_SUPPORTED_VERSION`。
3. 移除旧 `MIN_SUPPORTED_VERSION` 以下的冻结类型与台阶。
4. 更新 `src/shared/config-schema.ts` 的 `MIN_SUPPORTED_VERSION`。
