#!/usr/bin/env node
// 推送前的标签校验：一次只允许推一个标签，且它必须是 v + 语义化版本、并与 package.json 的 version 同号。
// 标签决定 GitHub Release 的 tarball 地址（README 钉死那一条链接），标签与版本不同号就发不出可安装的产物。
//
// 用法（由 pre-push 钩子调用）：node scripts/check-tag.mjs
// git 把待推 ref 清单从 stdin 喂进来，每行四列 <local ref> <local oid> <remote ref> <remote oid>；
// 其中删除标签的行 local ref 是 (delete)、分支是 refs/heads/*，故只校验本次新建 / 改写的标签。
// 没有标签要推则静默通过（无输出）；退出码 0 = 通过或无需校验，1 = 有标签不合规。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 本地标签的 ref 前缀：清单里只认它，分支与删除行天然不在此列 */
const TAG_REF_PREFIX = 'refs/tags/'

/** 发布标签前缀：须与 release.yml 的 v* 触发条件一致，否则推上去也不会发 Release */
const TAG_PREFIX = 'v'

/** 语义化版本（semver.org 官方 BNF，含预发布与构建元数据） */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/

const fail = (message) => {
    console.error(`check-tag: ${message}`)
    process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

if (typeof pkg.version !== 'string' || !SEMVER.test(pkg.version)) {
    fail(`package.json 的 version 不是语义化版本：${JSON.stringify(pkg.version)}`)
}

const expected = `${TAG_PREFIX}${pkg.version}`

// 异步迭代而非 fs.readFileSync(0)：Windows 上 stdin 是管道时同步读会抛 EOF（nodejs/node#35997），
// 而 git 正是用管道喂清单。stdin 是终端说明没人推东西（手工直跑），此时读下去只会等 EOF。
const chunks = []
if (!process.stdin.isTTY) {
    for await (const chunk of process.stdin) {
        chunks.push(chunk)
    }
}

const tags = Buffer.concat(chunks)
    .toString('utf8')
    .split('\n')
    .map(line => line.split(' ')[0])
    .filter(ref => ref.startsWith(TAG_REF_PREFIX))
    .map(ref => ref.slice(TAG_REF_PREFIX.length))

if (tags.length === 0) {
    process.exit(0)
}

if (tags.length > 1) {
    fail(`本次推送了 ${tags.length} 个标签：${tags.join('、')}；一次只允许推一个标签`)
}

const [tag] = tags

if (!tag.startsWith(TAG_PREFIX) || !SEMVER.test(tag.slice(TAG_PREFIX.length))) {
    fail(`标签 ${tag} 不是 ${TAG_PREFIX} + 语义化版本`)
}

if (tag !== expected) {
    fail(`本次推送的标签 ${tag} 与 package.json 的 ${expected} 不同号`)
}

console.log(`check-tag: ok (${tag})`)
