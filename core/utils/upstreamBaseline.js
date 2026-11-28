/**
 * 上游版本基线（EdgeOne 版）
 *
 * 这里是「我们这一版是从上游哪个版本/哪个提交改出来的」的唯一记录点。
 * 每次把上游的更新同步过来之后，只需要改这里的 version / sha / date，
 * 后台的「上游更新检测」就会以新的基线重新比对。
 *
 * 上游仓库：https://github.com/MarSeventh/CloudFlare-ImgBed
 */

export const UPSTREAM_REPO = 'MarSeventh/CloudFlare-ImgBed';

/** 本站当前版本号（与前端打包时写入的版本保持一致） */
export const SELF_VERSION = '2.7.8';

/** 本次适配所对应的上游基线 */
export const UPSTREAM_BASELINE = {
    version: '2.7.8',
    // 上游 v2.7.8 这个 tag 指向的提交
    sha: 'b0fc780ee2afd1a6f9d606adcba8c581699c884b',
    date: '2026-10-25T13:58:21Z',
};

/**
 * 上游改动文件的分类规则：判断哪些文件在搬到 EdgeOne 版时需要额外处理。
 * 顺序敏感，先匹配到的生效。
 */
export const UPSTREAM_FILE_RULES = [
    {
        id: 'api',
        label: '边缘函数（需包一层 EdgeOne 适配：core/ 目录 + handler 改名）',
        test: (path) => path.startsWith('functions/'),
    },
    {
        id: 'frontend',
        label: '前端产物（需重新跑 scripts/patch-frontend-edgeone.mjs 补丁）',
        test: (path) => path.startsWith('frontend-dist/') || path.startsWith('frontend/'),
    },
    {
        id: 'meta',
        label: '构建与清单（package.json / wrangler / CI 等，需要人工确认）',
        test: (path) =>
            path === 'package.json' ||
            path.startsWith('.github/') ||
            path.startsWith('wrangler') ||
            path.includes('package-lock.json'),
    },
    {
        id: 'docs',
        label: '文档（一般无需处理）',
        test: (path) => path.startsWith('readme') || path.endsWith('.md'),
    },
];

export function classifyUpstreamFile(path) {
    for (const rule of UPSTREAM_FILE_RULES) {
        if (rule.test(path)) return rule;
    }
    return { id: 'other', label: '其它文件' };
}

/** 粗略比较两个版本号（v2.7.8 / 2.7.8 都能处理） */
export function compareVersion(a, b) {
    const normalize = (v) => String(v || '').replace(/^v/i, '').split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
    const left = normalize(a);
    const right = normalize(b);
    const len = Math.max(left.length, right.length);
    for (let i = 0; i < len; i += 1) {
        const l = left[i] || 0;
        const r = right[i] || 0;
        if (l > r) return 1;
        if (l < r) return -1;
    }
    return 0;
}
