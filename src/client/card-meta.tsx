import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** 卡片末尾联系行：仓库地址、版本标记与 star / 反馈跳转键，内容全在本文件内合成。 */

const REPO_URL = 'https://github.com/TikaFlow/dsh-model-fix'
const ISSUES_URL = `${REPO_URL}/issues/new`
const REPO_LABEL = REPO_URL.replace(/^https?:\/\//, '')

/** 插件版本号：tsdown 构建期 define 内联，见 tsdown.config.ts */
declare const __PLUGIN_VERSION__: string
const PLUGIN_VERSION = __PLUGIN_VERSION__

// 图标：Octicons（GitHub 官方图标集，MIT，https://primer.style/octicons），统一 16×16 / viewBox 0 0 16 16 / `fill="currentColor"`

// mark-github-16
function IconGitHub() {
    return (
        <svg className="dsh-mf-linkIcon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path fill="currentColor" d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" />
        </svg>
    )
}

// tag-16
function IconTag() {
    return (
        <svg className="dsh-mf-linkIcon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path fill="currentColor" d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z" />
        </svg>
    )
}

// star-16
function IconStar() {
    return (
        <svg className="dsh-mf-linkIcon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path fill="currentColor" d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z" />
        </svg>
    )
}

// issue-opened-16
function IconIssue() {
    return (
        <svg className="dsh-mf-linkIcon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path fill="currentColor" d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
            <path fill="currentColor" d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
        </svg>
    )
}

/** 卡片末尾联系行：只吃一个翻译函数，地址、版本与 issue 正文均在本文件内合成。 */
export function CardMeta(props: { t: TranslateNS<'settings.modelFix'> }) {
    const { t } = props
    // 反馈链接预填版本与 issue 模板
    const issuesHref = `${ISSUES_URL}?body=${encodeURIComponent(t('issueBody', { version: PLUGIN_VERSION }))}`
    return (
        <div className="dsh-mf-meta">
            <span className="dsh-mf-metaLeft">
                <a className="dsh-mf-chip dsh-mf-chipAddress" href={REPO_URL} target="_blank" rel="noreferrer noopener"><IconGitHub />{REPO_LABEL}</a>
                <span className="dsh-mf-chip dsh-mf-chipVersion"><IconTag />v{PLUGIN_VERSION}</span>
            </span>
            <span className="dsh-mf-actions">
                <a className="dsh-mf-chip" href={REPO_URL} target="_blank" rel="noreferrer noopener"><IconStar />{t('star')}</a>
                <a className="dsh-mf-chip" href={issuesHref} target="_blank" rel="noreferrer noopener"><IconIssue />{t('feedback')}</a>
            </span>
        </div>
    )
}
