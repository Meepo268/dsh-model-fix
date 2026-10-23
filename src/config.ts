import { CONFIG_VERSION, MIN_SUPPORTED_VERSION, DEFAULT_CONFIG, parseSnapshot, parseVersion } from '@/shared/config-schema'
import type { PluginConfig } from '@/shared/types'
import { isPlainObject } from '@/shared/types'

/** 解析版本快照段为运行时配置：优先当前版本，否则取 ≥ 最低支持的最高可解析快照（降级解析），均不可用回退默认 */
export function resolveConfig(section: unknown): PluginConfig {
    if (!isPlainObject(section)) return DEFAULT_CONFIG
    let best: { version: number; config: PluginConfig } | undefined
    for (const [key, value] of Object.entries(section)) {
        const version = parseVersion(key)
        if (version === undefined || version < MIN_SUPPORTED_VERSION) continue
        const config = parseSnapshot(value)
        if (!config) continue
        if (version === CONFIG_VERSION) return config
        if (!best || version > best.version) best = { version, config }
    }
    return best?.config ?? DEFAULT_CONFIG
}

// 生效配置源：index.ts 的 apply 挂上 Config 实时引用后指向命名空间，否则回退默认
let configSource: () => PluginConfig = () => DEFAULT_CONFIG

/** 挂载配置读取来源（由 index.ts 的 apply 接线调用） */
export function setConfigSource(current: () => PluginConfig): void {
    configSource = current
}

export function getConfig(): PluginConfig {
    return configSource()
}
