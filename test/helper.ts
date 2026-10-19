/** 纯函数测试的轻量断言辅助：分模块进度、累计结果、稳定序列化、汇总并设置退出码 */

let passed = 0
let failed = 0
/** 失败明细：全部通过时为空，只在收尾时逐条列出 */
const failures: { name: string; detail: unknown }[] = []
/** 当前模块：每个测试文件一组，收尾时打一行进度。模块名不进失败明细——用例名本身已带函数前缀 */
let module = ''
let modulePassed = 0
let moduleFailed = 0

/** 断言一条用例。通过时不逐条打印——全量用例有数百条，逐条打印会刷十几屏，信噪比接近零；只累加计数，失败才记下来。失败明细在 summary 里统一列出 */
export function check(name: string, ok: boolean, detail?: unknown): void {
    if (ok) {
        passed++
        modulePassed++
        return
    }
    failed++
    moduleFailed++
    failures.push({ name, detail })
}

/** 切换当前模块：上一个模块的进度行在此收尾（模块内用例跑完即刻可见） */
export function section(name: string): void {
    closeSection()
    module = name
    modulePassed = 0
    moduleFailed = 0
}

/** 打出当前模块的一行进度：失败行带失败数，便于一眼定位是哪个文件坏了 */
function closeSection(): void {
    if (module === '') return
    const total = modulePassed + moduleFailed
    console.log(moduleFailed === 0 ? `PASS ${module} ${total}` : `FAIL ${module} ${moduleFailed}/${total}`)
    module = ''
}

/** 键序无关的稳定 JSON 序列化，供深度比较断言 */
export function stable(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1)
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
    }
    return JSON.stringify(value)
}

/** 汇总输出：先补最后一个模块的进度行，再逐条列出失败明细，最后给总判据行 */
export function summary(): void {
    closeSection()
    for (const item of failures) {
        console.log(`FAIL ${item.name} -> ${JSON.stringify(item.detail)}`)
    }
    console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed}/${passed + failed} FAILED`)
    if (failed > 0) process.exitCode = 1
}