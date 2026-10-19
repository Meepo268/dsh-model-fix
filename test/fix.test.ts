/**
  * src/fix.ts 编排集成测试（stub ctx）：用内存 settings 文档驱动真实 fix()，覆盖填充 / 覆盖 / force / excludes / compat 增删 / 空字段剔除 / 记忆不归 fix 管（只写 llm-pi-ai 一段）/ 冲突重试。
  * 不覆盖：事件链与守卫（src/guard.ts + test/guard.test.ts）、缓存读盘与网络拉取（readCache/fetchLatest）、浏览器半。这些需要真实宿主或 fs/mock，不在 stub ctx 的可达面内
  */

import type { Context } from '@deepseek-ai/cordis'
import type { IndexedCatalog, IndexEntry } from '@/types'
import type { PluginConfig } from '@/shared/types'
import { fix, planFill } from '@/fix'
import { setConfigSource } from '@/config'
import { setCatalog } from '@/catalog'
import { API_NS, PLUGIN_NS } from '@/shared/constants'
import { CONFIG_VERSION, DEFAULT_CONFIG, versionKey } from '@/shared/config-schema'
import { check, stable } from '@test/helper'
import { makeStubCtx, resetModules, type StubCtx } from '@test/ctx'

/** 插件命名空间里当前版本快照的键（fix 的落盘口随版本变，故不写字面量） */
const KEY = versionKey(CONFIG_VERSION)

/** 目录条目：model-a 四字段齐全，model-b 无图片，model-c 无可用数据（efforts 空、无容量、无模态） */
const ENTRIES: IndexEntry[] = [
    { id: 'model-a', efforts: ['none', 'low', 'high'], contextWindow: 128000, maxTokens: 8192, image: true },
    { id: 'model-b', efforts: ['none', 'medium'], contextWindow: 32000, maxTokens: 4096 },
    { id: 'model-c', efforts: [] },
]

/** 合成目录索引 */
const CAT: IndexedCatalog = {
    catalog: {},
    groups: new Map([[
        'testprovider',
        { ids: ENTRIES.map((item) => item.id), byId: new Map(ENTRIES.map((item) => [item.id, item])) },
    ]]),
}

/** 以 DEFAULT_CONFIG 为基线合并覆盖项（各组深合并，容器不与默认共享引用） */
function cfg(overrides: Partial<PluginConfig> = {}): PluginConfig {
    return {
        allowUpdate: { ...DEFAULT_CONFIG.allowUpdate, ...overrides.allowUpdate },
        autoFill: { ...DEFAULT_CONFIG.autoFill, ...overrides.autoFill },
        compat: { ...DEFAULT_CONFIG.compat, ...overrides.compat },
        excludes: overrides.excludes ?? [],
        efforts: overrides.efforts ?? {},
        behavior: { ...DEFAULT_CONFIG.behavior, ...overrides.behavior },
        userExperience: { ...DEFAULT_CONFIG.userExperience, ...overrides.userExperience },
    }
}

function setConfig(config: PluginConfig): void {
    setConfigSource(() => config)
}

/** 取某 provider 的实时 models 数组 */
function modelsOf(ctx: StubCtx, providerId: string): Record<string, unknown>[] {
    const providers = ctx.userOf(API_NS).providers as Record<string, Record<string, unknown> | undefined> | undefined
    const models = providers?.[providerId]?.models
    return Array.isArray(models) ? models : []
}

/** 取某 provider 的实时 compat（可能不存在） */
function compatOf(ctx: StubCtx, providerId: string): Record<string, unknown> | undefined {
    const providers = ctx.userOf(API_NS).providers as Record<string, Record<string, unknown> | undefined> | undefined
    return providers?.[providerId]?.compat as Record<string, unknown> | undefined
}

/** 执行本文件的全部用例 */
export async function run(): Promise<void> {
    // ---------- 1. 基本填充：autoFill 全开，三类模型各一 ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: { models: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }] } } },
        })
        setConfig(cfg())
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context)
        const models = modelsOf(ctx, 'testprovider')
        check('填充：变更计数为 2（model-c 无目录数据）', changes === 2)
        check('填充：model-a 四字段全填', stable(models[0]) === stable({
            id: 'model-a',
            reasoningEfforts: { off: 'none', low: 'low', high: 'high' },
            contextWindow: 128000,
            maxTokens: 8192,
            input: ['text', 'image'],
        }))
        check('填充：model-b 有推理与容量、无图片模态', stable(models[1]) === stable({
            id: 'model-b',
            reasoningEfforts: { off: 'none', medium: 'medium' },
            contextWindow: 32000,
            maxTokens: 4096,
        }))
        check('填充：model-c 无目录数据原样保留', stable(models[2]) === stable({ id: 'model-c' }))
    }

    // ---------- 2. autoFill.reasoning 关闭：推理级别不填，其余照填 ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: { models: [{ id: 'model-a' }] } } },
        })
        setConfig(cfg({ autoFill: { reasoning: false, context: true, image: true } }))
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context)
        const model = modelsOf(ctx, 'testprovider')[0]
        check('autoFill.reasoning 关：推理级别不填', model !== undefined && model.reasoningEfforts === undefined)
        check('autoFill.reasoning 关：容量与图片仍填',
            model?.contextWindow === 128000 && Array.isArray(model?.input) && model.input.includes('image'))
        check('autoFill.reasoning 关：变更计数为 1', changes === 1)
    }

    // ---------- 3. allowUpdate 开启：覆盖已有错误值 ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: { models: [{ id: 'model-a', reasoningEfforts: { low: 'low' } }] } } },
        })
        setConfig(cfg({
            autoFill: { reasoning: true, context: false, image: false },
            allowUpdate: { reasoning: true, context: false, image: false },
        }))
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context)
        const model = modelsOf(ctx, 'testprovider')[0]
        check('allowUpdate：覆盖已有推理级别', stable(model?.reasoningEfforts) === stable({ off: 'none', low: 'low', high: 'high' }))
        check('allowUpdate：变更计数为 1', changes === 1)
    }

    // ---------- 4. force 单次绕过：allowUpdate 关但 force 开 ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: { models: [{ id: 'model-a', reasoningEfforts: { low: 'low' } }] } } },
        })
        setConfig(cfg({
            autoFill: { reasoning: true, context: false, image: false },
            allowUpdate: { reasoning: false, context: false, image: false },
        }))
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context, true)
        const model = modelsOf(ctx, 'testprovider')[0]
        check('force：单次绕过 allowUpdate 覆盖', stable(model?.reasoningEfforts) === stable({ off: 'none', low: 'low', high: 'high' }))
        check('force：变更计数为 1', changes === 1)
    }

    // ---------- 5. allowUpdate 关且非 force：已有字段不被覆盖 ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: { models: [{ id: 'model-a', reasoningEfforts: { low: 'low' } }] } } },
        })
        setConfig(cfg({
            autoFill: { reasoning: true, context: false, image: false },
            allowUpdate: { reasoning: false, context: false, image: false },
        }))
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context)
        const model = modelsOf(ctx, 'testprovider')[0]
        check('allowUpdate 关非 force：已有字段不覆盖', stable(model?.reasoningEfforts) === stable({ low: 'low' }))
        check('allowUpdate 关非 force：无变更、零 mutate', changes === 0 && ctx.mutateCalls.length === 0)
    }

    // ---------- 6. excludes：命中的提供方填充与 compat 一律不作用 ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: {
                testprovider: { models: [{ id: 'model-a' }] },
                'excluded-provider': {
                    api: 'openai-completions',
                    compat: { supportsDeveloperRole: true },
                    models: [{ id: 'model-a' }],
                },
            } },
        })
        setConfig(cfg({ excludes: ['excluded-provider'] }))
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context)
        check('excludes：未排除提供方正常填充', modelsOf(ctx, 'testprovider')[0]?.contextWindow === 128000)
        check('excludes：命中提供方模型不被填充', stable(modelsOf(ctx, 'excluded-provider')[0]) === stable({ id: 'model-a' }))
        check('excludes：命中提供方 compat 不被改写', compatOf(ctx, 'excluded-provider')?.supportsDeveloperRole === true)
        check('excludes：变更计数只计未排除提供方', changes === 1)
    }

    // ---------- 7. 记忆不由 fix 重建：只写 llm-pi-ai，记忆段逐字不动 ----------
    {
        resetModules()
        const memories = { testprovider: { 'model-a': 'high', 'model-gone': 'low' }, 'deepseek-account': { 'ds-model': 'max' } }
        const ctx = makeStubCtx({
            api: { providers: { testprovider: { models: [{ id: 'model-a' }] } } },
            plugin: { [KEY]: { efforts: memories } },
        })
        setConfig(cfg({ efforts: memories }))
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context)
        const efforts = (ctx.userOf(PLUGIN_NS)[KEY] as Record<string, unknown> | undefined)?.efforts
        check('记忆不由 fix 重建：已删模型与外部提供方的记忆逐字保留', stable(efforts) === stable(memories), efforts)
        check(
            '记忆不由 fix 重建：写回只发生一次且落在 llm-pi-ai 段',
            changes === 1 && ctx.mutateCalls.length === 1 && ctx.mutateCalls[0]?.ns === API_NS,
            ctx.mutateCalls,
        )
        // 计划口径：efforts 记忆已整体移出 Node 半，填充计划里不应再有该字段
        const plan = planFill(cfg({ efforts: memories }), { testprovider: { models: [{ id: 'model-a' }] } }, CAT, false)
        check('记忆不由 fix 重建：填充计划里没有 newEfforts', !('newEfforts' in plan), Object.keys(plan))
    }

    // ---------- 8. excludes：记忆与排除项彻底无关（零自有段写回） ----------
    {
        resetModules()
        const memories = { 'excluded-provider': { 'model-a': 'high', 'model-gone': 'low' } }
        const ctx = makeStubCtx({
            api: { providers: { 'excluded-provider': { models: [{ id: 'model-a' }] } } },
            plugin: { [KEY]: { efforts: memories } },
        })
        setConfig(cfg({ excludes: ['excluded-provider'], efforts: memories }))
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context)
        const efforts = (ctx.userOf(PLUGIN_NS)[KEY] as Record<string, unknown> | undefined)?.efforts
        check('excludes：记忆原样保留（不再按模型重建）', stable(efforts) === stable(memories), efforts)
        check('excludes：零自有段写回', ctx.mutateCalls.length === 0 && changes === 0, ctx.mutateCalls)
    }

    // ---------- 9. 空壳字段清理：reasoningEfforts/input/compat 的空形态一律剔除（无填充也写） ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: { models: [{ id: 'model-unknown', reasoningEfforts: {}, input: [], compat: {} }] } } },
        })
        setConfig(cfg({ autoFill: { reasoning: false, context: false, image: false } }))
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context)
        const model = modelsOf(ctx, 'testprovider')[0]
        check('空壳清理：变更计数为 1', changes === 1)
        check('空壳清理：三个空形态字段均移除', model !== undefined && model.reasoningEfforts === undefined && model.input === undefined && model.compat === undefined)
        check('空壳清理：id 保留', model?.id === 'model-unknown')
    }

    // ---------- 9b. 空壳等同未声明：reasoningEfforts: {} 被缺失补写，而不是「已声明」被清掉 ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: { models: [{ id: 'model-a', reasoningEfforts: {} }] } } },
        })
        setConfig(cfg({ autoFill: { reasoning: true, context: false, image: false } }))
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context)
        const model = modelsOf(ctx, 'testprovider')[0]
        check('空 reasoningEfforts：变更计数为 1', changes === 1)
        check(
            '空 reasoningEfforts：按缺失补写填上目录档位（不被清空后留待下轮）',
            stable(model?.reasoningEfforts) === stable({ off: 'none', low: 'low', high: 'high' }),
            model,
        )
    }

    // ---------- 10. compat 添加：openai-completions 路由补 supportsDeveloperRole: false 与 supportsStore: false ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: { api: 'openai-completions', models: [{ id: 'model-unknown' }] } } },
        })
        setConfig(cfg()) // compat.disableDeveloper / disableStore = true（默认）
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context)
        check('compat 添加：变更计数为 0（无模型填充）', changes === 0)
        check('compat 添加：路由 compat 写入 supportsDeveloperRole: false', compatOf(ctx, 'testprovider')?.supportsDeveloperRole === false)
        check('compat 添加：路由 compat 写入 supportsStore: false', compatOf(ctx, 'testprovider')?.supportsStore === false)
    }

    // ---------- 11. compat 移除：删空整段 unset ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: {
                api: 'openai-completions',
                compat: { supportsDeveloperRole: false },
                models: [{ id: 'model-unknown' }],
            } } },
        })
        setConfig(cfg({ compat: { disableDeveloper: false, disableStore: false } }))
        setCatalog(CAT)
        await fix(ctx as unknown as Context)
        check('compat 移除：整段 unset', compatOf(ctx, 'testprovider') === undefined)
    }

    // ---------- 11b. 非目标协议残留清理：开关开启仍移除（原 completions 迁移而来的残留） ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: {
                api: 'openai-responses',
                compat: { supportsDeveloperRole: false, supportsStore: true },
                models: [{ id: 'model-unknown' }],
            } } },
        })
        setConfig(cfg()) // compat.disableDeveloper / disableStore = true（默认）
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context)
        check('非目标协议清理：开关开启仍移除残留', compatOf(ctx, 'testprovider') === undefined)
        check('非目标协议清理：变更计数为 0', changes === 0)
    }

    // ---------- 11c. 非目标协议残留清理：保留用户其他 compat 字段，只删本组管辖的两个字段 ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: {
                api: 'openai-responses',
                compat: { supportsDeveloperRole: false, supportsStore: true, thinkingFormat: 'qwen' },
                models: [{ id: 'model-unknown' }],
            } } },
        })
        setConfig(cfg({ compat: { disableDeveloper: false, disableStore: true } }))
        setCatalog(CAT)
        await fix(ctx as unknown as Context)
        check('非目标协议清理：保留其他字段', compatOf(ctx, 'testprovider')?.thinkingFormat === 'qwen')
        check('非目标协议清理：移除 supportsDeveloperRole', compatOf(ctx, 'testprovider')?.supportsDeveloperRole === undefined)
        check('非目标协议清理：移除 supportsStore', compatOf(ctx, 'testprovider')?.supportsStore === undefined)
    }

    // ---------- 11d. 非目标协议无残留：不动（不为删除不存在的键发写） ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: { api: 'openai-responses', models: [{ id: 'model-unknown' }] } } },
        })
        setConfig(cfg())
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context)
        check('非目标协议无残留：零 mutate', ctx.mutateCalls.length === 0)
        check('非目标协议无残留：变更计数为 0', changes === 0)
    }

    // ---------- 11e. 非目标协议空对象 compat：整段 unset（不留空壳） ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: {
                api: 'openai-responses',
                compat: {},
                models: [{ id: 'model-unknown' }],
            } } },
        })
        setConfig(cfg())
        setCatalog(CAT)
        await fix(ctx as unknown as Context)
        check('非目标协议空对象：整段 unset', compatOf(ctx, 'testprovider') === undefined)
    }

    // ---------- 11f. provider 无 api 字段：compat 不处理（无 api 无法判定迁移，避免误删用户手动配置） ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: {
                compat: { supportsDeveloperRole: false },
                models: [{ id: 'model-unknown' }],
            } } },
        })
        setConfig(cfg())
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context)
        check('无 api 字段：compat 原样保留', compatOf(ctx, 'testprovider')?.supportsDeveloperRole === false)
        check('无 api 字段：变更计数为 0', changes === 0)
    }

    // ---------- 12. 无目录数据：不变、零 mutate ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: { models: [{ id: 'model-unknown' }] } } },
        })
        setConfig(cfg())
        setCatalog({ catalog: {}, groups: new Map() })
        const changes = await fix(ctx as unknown as Context)
        check('无目录数据：变更计数为 0', changes === 0)
        check('无目录数据：零 mutate', ctx.mutateCalls.length === 0)
    }

    // ---------- 13. revision 冲突重试：首次冲突后重试成功 ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: { models: [{ id: 'model-a' }] } } },
            plugin: { [KEY]: {} },
            conflictFirst: 1,
        })
        setConfig(cfg()) // 记忆不由 fix 重建：首次 mutate 即模型写回（无 efforts 写回）
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context)
        check('冲突重试：重试后成功返回变更数', changes === 1)
        check('冲突重试：共两次 mutate 调用（首次被拒）', ctx.mutateCalls.length === 2)
        check('冲突重试：最终文档已填充', modelsOf(ctx, 'testprovider')[0]?.contextWindow === 128000)
    }

    // ---------- 14. provider 无 models 但有 api：compat 仍处理 ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: { api: 'openai-completions' } } },
        })
        setConfig(cfg())
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context)
        check('无 models 有 api：compat 仍写入', compatOf(ctx, 'testprovider')?.supportsDeveloperRole === false)
        check('无 models 有 api：变更计数为 0', changes === 0)
    }

    // ---------- 15. 图片模态：仅填 input ----------
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: { models: [{ id: 'model-a' }] } } },
        })
        setConfig(cfg({ autoFill: { reasoning: false, context: false, image: true } }))
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context)
        const model = modelsOf(ctx, 'testprovider')[0]
        check('图片模态：仅填 input', stable(model?.input) === stable(['text', 'image'])
            && model?.reasoningEfforts === undefined && model?.contextWindow === undefined)
        check('图片模态：变更计数为 1', changes === 1)
    }

    // ---------- 16. providers 非纯对象：早退、不抛、零 mutate ----------
    {
        resetModules()
        const ctx = makeStubCtx({ api: { providers: 'bad' } })
        setConfig(cfg())
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context)
        check('providers 非纯对象：早退返回 0', changes === 0)
        check('providers 非纯对象：零 mutate', ctx.mutateCalls.length === 0)
    }

    // ---------- 17. 容量只缺一半：已填 contextWindow 时 maxTokens 仍要补 ----------
    // maxTokens 的补写判据只看它自己是否缺失，与 contextWindow 缺没缺无关
    {
        resetModules()
        const ctx = makeStubCtx({
            api: { providers: { testprovider: { models: [{ id: 'model-a', contextWindow: 128000 }] } } },
        })
        setConfig(cfg({ autoFill: { reasoning: false, context: true, image: false } }))
        setCatalog(CAT)
        const changes = await fix(ctx as unknown as Context)
        const model = modelsOf(ctx, 'testprovider')[0]
        check('容量只缺一半：maxTokens 补上且 contextWindow 不动', stable(model) === stable({
            id: 'model-a',
            contextWindow: 128000,
            maxTokens: 8192,
        }))
        check('容量只缺一半：变更计数为 1', changes === 1)
    }
}
