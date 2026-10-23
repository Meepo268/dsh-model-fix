# 裁决：会话侧（记忆、子智能体、档位自调）

## 推理级别记忆

- **`efforts` 是运行时记忆而非用户配置**：嵌套对象、宽松解析（坏结构回落 `{}` 不判整段非法）、`isDirty` 不比较它；卡片保存整段快照时取写入当刻实时值（草稿副本会覆盖开卡后的新记忆）。
- **Node 半只管持久化与解析，不自动设级别**：自动恢复与自动 high 走前端 `directory.select`，自动设置不写记忆（`pendingAutoSet` 守卫跳过反向触发的投影变化）。
- **失效清理归 Node 半、按宿主全量模型列表剪枝，`fix` 不参与记忆生命周期**。缺席即删除、段删空折叠；**读不到 ≠ 不存在**（某 provider 读失败整段保留）。档位是否仍被公告不参与剪枝。
- **`rememberEfforts` 关闭只停「保存新的」，恢复照常**；清空由卡片在开关转关时立即确认（经 settings scope 直写，清空失败显式报错）。
- **`defaultHigh` 三条护栏**：记忆优先、不覆盖既有级别、不干预同模型改级别（含手动选「provider default」）。
- **浏览器半记忆写入三条护栏**（`rememberEffort`）：ConfigForm 未 ready 时基底不可信（`efforts` 回落 `{}`，整段 set 等于清空全部记忆）⇒ 放弃本次保存；ready 后带 `expectedRevision` 围栏重试；非冲突错误静默放过。

## 子智能体

- **在宿主 `agent/request` 瀑布里改写**（语义见 `host/agent.md`）：子智能体没有独立档位设置面，该瀑布是唯一可读可写处。插件根 ctx 未打 scope 标签 ⇒ 单个 `{ prepend: true }` 监听覆盖全部 Agent。
- **「跟随」以宿主「允许 Agent 为子智能体选择模型」关着为前提**：开着时路由由模型在授权范围内自挑，覆盖即推翻合法选择。浏览器半同读这段 settings 判定状态灯。
- **`followParent` 落在 `userExperience` 组、不递增版本**：会话侧体验开关，与模型配置写入无关、不读 `excludes`。
- **跟随父「下一次请求该用的路由」**：优先投影 `pending`，回落请求头 `config`，再回落 `options`。三项照父的来；`adapterDefaults?.reasoningEffort === true` 是适配器默认值，跟随时删键。`maxTokens` 按 `mergedBudget`（`src/subagent.ts`）合并。每请求现算、不缓存。
- **不预检档位可用性、不自动降级**：宿主派发前本地校验，未声明档位不出网；跟随时写入的是父刚生效的档位。

## 档位自调

- **注入两枚工具 + 一段提示词**：档位该多高天然长在会话过程里，AI 信息最全；开关开装关卸，插件零状态。
- **设置走 `sessionController.selectModel`**：与 UI 手选同一链路（落 `model/selection` 事件、宿主照常校验）。
- **查询走 `llm.resolveModelInfo`（全量提供方）**：可用档位的权威来源是适配器元数据；与设置共用同一条路由回落链（同 `src/subagent.ts` 规则）。
- **档位值一律用 `efforts[].id` 实际值、不设 `'default'` 哨兵**：AI 实际只有升/降两个操作，「默认档位」对它无用。
- **唯一失败形态「模型不支持该档位」，`RemoteError` 原样透传**；入参失败回业务失败值（`ok:false` + `error`），AI 读得到原因才能自行纠正。
- **「先查后设」软指引不硬校验**：路由可能在两调用间被 UI 切走；提示词只指明失败后重查一次、仍失败保持当前档位。
- **四项宿主服务经 `ctx.inject` 子 fiber 门控，类型按契约复制**（清单见 `host/imports.md`）；注册中途抛错回滚已注册部分。
- **`selfTune` 与 `followParent` 同批落 `userExperience`、不递增版本**：解析端缺键落默认 false，升级台阶产物补同一默认。
