// 重建随包目录缓存 public/models-cache.json：拉取 models.dev 全量数据并跑运行期同一个构建器（jiti 直跑 TS，别处逻辑不复制）
import { writeFile } from 'node:fs/promises'
import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url, { tsconfigPaths: true })
const { buildCatalog } = await jiti.import('../src/catalog.ts')

const res = await fetch('https://models.dev/api.json', { headers: { 'User-Agent': 'dsh-model-fix' } })
if (!res.ok) throw new Error(`models.dev/api.json -> ${res.status}`)
const catalog = buildCatalog(await res.json())
const models = Object.values(catalog).reduce((sum, group) => sum + Object.keys(group.models).length, 0)
await writeFile(new URL('../public/models-cache.json', import.meta.url), JSON.stringify(catalog))
console.log(`已写入 public/models-cache.json：${Object.keys(catalog).length} 个提供方 / ${models} 个模型`)
