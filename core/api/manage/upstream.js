/**
 * 上游更新检测 API（管理端）
 *
 * GET /api/manage/upstream          读取检测结果（默认 6 小时内走缓存）
 * GET /api/manage/upstream?refresh=1 强制重新检测
 *
 * 检测内容：
 *   1. 上游最新 Release 版本（GitHub releases/latest）
 *   2. 上游 main 最新提交
 *   3. 基线提交 → main 最新提交之间有哪些文件变了（compare API，能看出要搬多少个文件）
 *
 * 为什么不每次实查：GitHub 匿名 API 每小时只有 60 次额度，且 EdgeOne 出口 IP 是共享的。
 * 结果缓存在 KV（key: upstream@status，6 小时），刷新按钮可强制重查。
 */

import {
    UPSTREAM_REPO,
    UPSTREAM_BASELINE,
    SELF_VERSION,
    classifyUpstreamFile,
    compareVersion,
} from '../../utils/upstreamBaseline.js';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Max-Age': '86400',
};

const CACHE_KEY = 'upstream@status';
const CACHE_TTL_SECONDS = 6 * 60 * 60;
const GITHUB_TIMEOUT_MS = 9000;
const MAX_FILE_SAMPLES = 40;

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
    });
}

async function githubFetch(path, token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
    try {
        const headers = {
            'User-Agent': 'edgeone-imgbed-upstream-check',
            Accept: 'application/vnd.github+json',
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(`https://api.github.com${path}`, {
            headers,
            signal: controller.signal,
        });
        if (!response.ok) {
            const remaining = response.headers.get('x-ratelimit-remaining');
            const hint = response.status === 403 || response.status === 429
                ? `GitHub API 限流（剩余额度 ${remaining ?? '未知'}），请稍后再试`
                : `GitHub API 返回 ${response.status}`;
            throw new Error(hint);
        }
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

/** 不带 token 也可用；配了 GITHUB_TOKEN 环境变量则自动带上，额度升到 5000/小时 */
async function resolveToken(env) {
    return env?.GITHUB_TOKEN || env?.GH_TOKEN || '';
}

function summarizeFiles(files) {
    const buckets = {};
    const samples = [];
    for (const file of files || []) {
        const rule = classifyUpstreamFile(file.filename);
        const bucket = buckets[rule.id] || (buckets[rule.id] = { id: rule.id, label: rule.label, count: 0 });
        bucket.count += 1;
        if (samples.length < MAX_FILE_SAMPLES && ['api', 'frontend', 'meta'].includes(rule.id)) {
            samples.push({ path: file.filename, status: file.status, category: rule.id });
        }
    }
    return {
        buckets: Object.values(buckets).sort((a, b) => b.count - a.count),
        samples,
        needAdaptCount: (buckets.api?.count || 0) + (buckets.frontend?.count || 0),
    };
}

async function fetchUpstreamStatus(env) {
    const token = await resolveToken(env);
    const [release, headCommits] = await Promise.all([
        githubFetch(`/repos/${UPSTREAM_REPO}/releases/latest`, token),
        githubFetch(`/repos/${UPSTREAM_REPO}/commits/main?per_page=1`, token),
    ]);

    const head = Array.isArray(headCommits) ? headCommits[0] : headCommits;
    const headSha = head?.sha || '';
    const releaseTag = release?.tag_name || '';

    const releaseIsNewer = releaseTag ? compareVersion(releaseTag, SELF_VERSION) > 0 : false;

    let compare = null;
    let compareUnknown = false;
    let files = { buckets: [], samples: [], needAdaptCount: 0 };
    let commitsBehind = 0;

    // 基线提交到上游 main 之间的差异
    if (UPSTREAM_BASELINE.sha && headSha && headSha !== UPSTREAM_BASELINE.sha) {
        try {
            const cmp = await githubFetch(
                `/repos/${UPSTREAM_REPO}/compare/${UPSTREAM_BASELINE.sha}...${headSha}`,
                token
            );
            commitsBehind = cmp?.ahead_by || 0;
            const changed = (cmp?.files || []).map((f) => ({
                filename: f.filename,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                changes: f.changes,
            }));
            files = summarizeFiles(changed);
            compare = {
                status: cmp?.status || '',
                aheadBy: cmp?.ahead_by || 0,
                behindBy: cmp?.behind_by || 0,
                totalFiles: changed.length,
                truncated: changed.length >= 300,
                url: `https://github.com/${UPSTREAM_REPO}/compare/${UPSTREAM_BASELINE.sha.slice(0, 7)}...${headSha.slice(0, 7)}`,
            };
        } catch (error) {
            compareUnknown = true;
            compare = { error: error.message };
        }
    }

    const isNewer = releaseIsNewer || commitsBehind > 0;

    return {
        repo: UPSTREAM_REPO,
        repoUrl: `https://github.com/${UPSTREAM_REPO}`,
        release: releaseTag
            ? {
                  tag: releaseTag,
                  name: release.name || releaseTag,
                  publishedAt: release.published_at || '',
                  url: release.html_url || `https://github.com/${UPSTREAM_REPO}/releases`,
                  isNewer: releaseIsNewer,
              }
            : null,
        head: headSha
            ? {
                  sha: headSha,
                  shortSha: headSha.slice(0, 7),
                  date: head?.commit?.author?.date || '',
                  message: (head?.commit?.message || '').split('\n')[0],
                  url: head?.html_url || '',
              }
            : null,
        compare,
        compareUnknown,
        files,
        commitsBehind,
        updateAvailable: isNewer,
        // update=确实有更新；latest=已是最新；incomplete=版本没变但差异查不到（限流/网络），需要重试
        status: isNewer ? 'update' : (compareUnknown ? 'incomplete' : 'latest'),
        releaseIsNewer,
        checkedAt: new Date().toISOString(),
    };
}

async function readCache(env) {
    try {
        const raw = await env?.img_url?.get(CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed?.checkedAt) return null;
        const age = Date.now() - new Date(parsed.checkedAt).getTime();
        return { ...parsed, ageSeconds: Math.max(0, Math.round(age / 1000)), fresh: age < CACHE_TTL_SECONDS * 1000 };
    } catch (error) {
        console.warn('[upstream] read cache failed:', error?.message || error);
        return null;
    }
}

async function writeCache(env, payload) {
    try {
        await env?.img_url?.put(CACHE_KEY, JSON.stringify(payload), { expirationTtl: CACHE_TTL_SECONDS });
    } catch (error) {
        console.warn('[upstream] write cache failed:', error?.message || error);
    }
}

export async function handleGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';

    const cached = await readCache(env);
    if (!force && cached?.fresh) {
        return json({
            success: true,
            cached: true,
            current: {
                version: SELF_VERSION,
                baselineVersion: UPSTREAM_BASELINE.version,
                baselineSha: UPSTREAM_BASELINE.sha,
                baselineDate: UPSTREAM_BASELINE.date,
                oursUrl: 'https://github.com/imicq/edgeone-imgbed',
            },
            upstream: cached,
        });
    }

    try {
        const upstream = await fetchUpstreamStatus(env);
        await writeCache(env, upstream);
        return json({
            success: true,
            cached: false,
            current: {
                version: SELF_VERSION,
                baselineVersion: UPSTREAM_BASELINE.version,
                baselineSha: UPSTREAM_BASELINE.sha,
                baselineDate: UPSTREAM_BASELINE.date,
                oursUrl: 'https://github.com/imicq/edgeone-imgbed',
            },
            upstream,
        });
    } catch (error) {
        // 查不到就把旧缓存拿出来顶着用，并明确标记为过期
        if (cached) {
            return json({
                success: true,
                cached: true,
                stale: true,
                warning: error.message,
                current: {
                    version: SELF_VERSION,
                    baselineVersion: UPSTREAM_BASELINE.version,
                    baselineSha: UPSTREAM_BASELINE.sha,
                    baselineDate: UPSTREAM_BASELINE.date,
                },
                upstream: cached,
            });
        }
        return json({ success: false, error: error.message || '检测失败' }, 502);
    }
}

export async function handle(context) {
    const method = context.request.method.toUpperCase();
    if (method === 'OPTIONS') {
        return new Response(null, { headers: CORS_HEADERS });
    }
    if (method !== 'GET' && method !== 'HEAD') {
        return json({ success: false, error: 'Method not allowed' }, 405);
    }
    return handleGet(context);
}
