/** 宿主版本比较（跨半共享）：`a.b.c` + 可选 `-<alpha|rc>.N`，阶段序 alpha < rc < 正式版；解析失败返回 undefined */

import { HOST_AUTO_HIDE_SINCE } from '@/shared/constants'

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|rc)\.(\d+))?$/

const STAGE_RANK: Readonly<Record<string, number>> = { alpha: 0, rc: 1 }
const STABLE_RANK = 2

export interface HostVersion {
    readonly major: number
    readonly minor: number
    readonly patch: number
    readonly stageRank: number
    readonly revision: number
}

export function parseHostVersion(version: string): HostVersion | undefined {
    const match = VERSION_PATTERN.exec(version)
    if (match === null) return undefined
    const [, major, minor, patch, stage, revision] = match
    return {
        major: Number(major),
        minor: Number(minor),
        patch: Number(patch),
        stageRank: stage === undefined ? STABLE_RANK : STAGE_RANK[stage] ?? STABLE_RANK,
        revision: revision === undefined ? 0 : Number(revision),
    }
}

/** 比较两个宿主版本；任一侧非法返回 undefined */
export function compareHostVersion(a: string, b: string): number | undefined {
    const left = parseHostVersion(a)
    const right = parseHostVersion(b)
    if (left === undefined || right === undefined) return undefined
    return left.major - right.major
        || left.minor - right.minor
        || left.patch - right.patch
        || left.stageRank - right.stageRank
        || left.revision - right.revision
}

/** 宿主是否已自带隐藏；版本未知返回 false（不空转） */
export function hostHidesOfficialSince(version: string | undefined): boolean {
    if (version === undefined) return false
    const order = compareHostVersion(version, HOST_AUTO_HIDE_SINCE)
    return order !== undefined && order >= 0
}
