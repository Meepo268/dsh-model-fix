#!/usr/bin/env node
// 提交前的版本号一致性校验：package.json 的 version 与 README 钉死的 tarball 链接必须同号。
//
// 用法（由 pre-commit 钩子调用）：node scripts/check-version.mjs
// 退出码 0 = 一致；1 = 不一致（附差异明细）。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const readme = readFileSync(join(root, 'README.md'), 'utf8')

const fail = (message) => {
    console.error(`check-version: ${message}`)
    process.exit(1)
}

if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    fail('package.json 的 version 不是非空字符串')
}

// README 里的安装链接是唯一必须与版本号同号的地方（GitHub Release 的 tarball 地址按 tag 寻址）
const pinned = [...readme.matchAll(/releases\/download\/v([^/]+)\/dsh-model-fix\.tgz/g)].map(m => m[1])

if (pinned.length === 0) {
    console.log(`check-version: ok`)
    process.exit(0)
}

const distinct = [...new Set(pinned)]
if (distinct.length > 1) {
    fail(`README.md 钉了多个版本的 tarball 链接：${distinct.join('、')}；只允许钉当前版本`)
}

if (distinct[0] !== pkg.version) {
    fail(`版本不一致：package.json = v${pkg.version}，README.md = v${distinct[0]}；两处必须同号`)
}

console.log(`check-version: ok (v${pkg.version})`)
