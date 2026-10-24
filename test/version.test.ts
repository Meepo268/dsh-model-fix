// shared/version.ts 纯函数测试
import { compareHostVersion, hostHidesOfficialSince, parseHostVersion } from '@/shared/version'
import { check, stable } from '@test/helper'

export function run(): void {
    check('parse 正式版', stable(parseHostVersion('0.2.1')) === stable({ major: 0, minor: 2, patch: 1, stageRank: 2, revision: 0 }), parseHostVersion('0.2.1'))
    check('parse rc', stable(parseHostVersion('0.2.1-rc.2')) === stable({ major: 0, minor: 2, patch: 1, stageRank: 1, revision: 2 }), parseHostVersion('0.2.1-rc.2'))
    check('parse alpha', stable(parseHostVersion('1.2.3-alpha.7')) === stable({ major: 1, minor: 2, patch: 3, stageRank: 0, revision: 7 }), parseHostVersion('1.2.3-alpha.7'))
    check('parse 非法一律 undefined',
        parseHostVersion('0.2') === undefined && parseHostVersion('0.2.1-beta.1') === undefined
        && parseHostVersion('') === undefined && parseHostVersion('v0.2.1') === undefined)

    check('compare patch 优先于阶段', (compareHostVersion('0.2.0-rc.2', '0.2.1-alpha.1') ?? 0) < 0)
    check('compare 同阶段比修订号', (compareHostVersion('0.2.1-alpha.1', '0.2.1-alpha.2') ?? 0) < 0)
    check('compare alpha < rc', (compareHostVersion('0.2.1-alpha.9', '0.2.1-rc.1') ?? 0) < 0)
    check('compare rc < 正式版', (compareHostVersion('0.2.1-rc.3', '0.2.1') ?? 0) < 0)
    check('compare 相等为 0', compareHostVersion('0.2.1-rc.2', '0.2.1-rc.2') === 0)
    check('compare major 优先', (compareHostVersion('0.9.9', '1.0.0-alpha.1') ?? 0) < 0)
    check('compare 任一侧非法为 undefined', compareHostVersion('0.2.1', 'x') === undefined)

    check('hostHides 起点命中', hostHidesOfficialSince('0.2.1-alpha.2') === true)
    check('hostHides 更新版本命中', hostHidesOfficialSince('0.2.1-rc.2') === true && hostHidesOfficialSince('0.3.0') === true)
    check('hostHides 更旧版本不命中', hostHidesOfficialSince('0.2.1-alpha.1') === false && hostHidesOfficialSince('0.2.0-rc.2') === false)
    check('hostHides 版本未知不命中', hostHidesOfficialSince(undefined) === false && hostHidesOfficialSince('bad') === false)
}
