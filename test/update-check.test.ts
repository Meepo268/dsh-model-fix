// src/client/update-check.ts 纯函数测试：版本比较、安装地址拼接、Release JSON 收敛与查询降级
import {
    RELEASES_API,
    RELEASES_PAGE,
    compareVersions,
    directInstallUrlOf,
    fetchLatestRelease,
    installUrlOf,
    parseRelease,
    versionOfTag,
} from '@/client/update-check'
import { check, stable } from '@test/helper'

/** 构造一个只够用的 fetch 假件：状态码、JSON 体、或直接抛错（不发真网络请求） */
function fakeFetch(spec: { ok?: boolean; payload?: unknown; throws?: boolean }): typeof fetch {
    return (async () => {
        if (spec.throws === true) throw new Error('offline')
        return {
            ok: spec.ok ?? true,
            json: async () => spec.payload,
        }
    }) as unknown as typeof fetch
}

export async function run(): Promise<void> {
    check('installUrl 钉 tag 的 tarball 且带镜像前缀', installUrlOf('v0.38.13') === 'https://ghfast.top/https://github.com/Meepo268/dsh-model-fix/releases/download/v0.38.13/dsh-model-fix.tgz')
    check('直连地址不带镜像前缀', directInstallUrlOf('v0.38.13') === 'https://github.com/Meepo268/dsh-model-fix/releases/download/v0.38.13/dsh-model-fix.tgz')
    check('镜像地址就是「前缀 + 直连地址」', installUrlOf('v1.2.3') === `https://ghfast.top/${directInstallUrlOf('v1.2.3')}`)
    check('versionOfTag 去 v 前缀并去空白',
        versionOfTag('v0.38.13') === '0.38.13' && versionOfTag('V1.2.3') === '1.2.3' && versionOfTag(' 0.38.1 ') === '0.38.1')

    check('compare 新版为正', (compareVersions('0.38.14', '0.38.13') ?? 0) > 0)
    check('compare 旧版为负', (compareVersions('0.38.12', '0.38.13') ?? 0) < 0)
    check('compare 相同为 0', compareVersions('v0.38.13', '0.38.13') === 0)
    check('compare rc 低于正式版', (compareVersions('0.39.0-rc.1', '0.39.0') ?? 0) < 0)
    check('compare 正式版高于 rc', (compareVersions('0.39.0', '0.39.0-rc.2') ?? 0) > 0)
    check('compare 非法版本为 undefined', compareVersions('0.38', '0.38.13') === undefined && compareVersions('x', 'y') === undefined)

    const payload = {
        tag_name: 'v0.38.14',
        html_url: 'https://github.com/Meepo268/dsh-model-fix/releases/tag/v0.38.14',
        body: ' 修复若干问题 \n',
    }
    check('parseRelease 收敛字段', stable(parseRelease(payload)) === stable({
        tag: 'v0.38.14',
        version: '0.38.14',
        pageUrl: 'https://github.com/Meepo268/dsh-model-fix/releases/tag/v0.38.14',
        installUrl: 'https://ghfast.top/https://github.com/Meepo268/dsh-model-fix/releases/download/v0.38.14/dsh-model-fix.tgz',
        notes: '修复若干问题',
    }), parseRelease(payload))
    check('parseRelease 无 v 前缀亦可', parseRelease({ tag_name: '0.38.14' })?.version === '0.38.14')
    check('parseRelease 缺 html_url 退回 tag 页',
        parseRelease({ tag_name: 'v0.38.14' })?.pageUrl === `${RELEASES_PAGE}/tag/v0.38.14`)
    check('parseRelease body 非字符串记空串', parseRelease({ tag_name: 'v0.38.14', body: 7 })?.notes === '')
    check('parseRelease 非法输入一律 null',
        parseRelease(null) === null
        && parseRelease('nope') === null
        && parseRelease({}) === null
        && parseRelease({ tag_name: '' }) === null
        && parseRelease({ tag_name: 'v0.38' }) === null
        && parseRelease({ tag_name: 13 }) === null)

    check('查询口是无 token 的 releases/latest', RELEASES_API === 'https://api.github.com/repos/Meepo268/dsh-model-fix/releases/latest')

    const okInfo = await fetchLatestRelease({ fetcher: fakeFetch({ payload }) })
    check('fetch 成功解析', okInfo?.version === '0.38.14', okInfo)
    check('fetch 非 2xx 收敛为 null', await fetchLatestRelease({ fetcher: fakeFetch({ ok: false }) }) === null)
    check('fetch 抛错收敛为 null', await fetchLatestRelease({ fetcher: fakeFetch({ throws: true }) }) === null)
    check('fetch 载荷不合规收敛为 null', await fetchLatestRelease({ fetcher: fakeFetch({ payload: { message: 'rate limited' } }) }) === null)
}
