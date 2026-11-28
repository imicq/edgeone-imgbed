/**
 * 上游同步助手（EdgeOne 版）
 *
 * 上游 CloudFlare-ImgBed 一更新，这个脚本帮你把「要改哪些文件」算清楚，
 * 并把上游文件抓下来、按本项目的目录规则预转换一份到 .upstream-sync/ 里供比对。
 * 它 **不会** 覆盖仓库里的任何文件——合并这一步始终由人来确认。
 *
 * 用法：
 *   node scripts/upstream-sync.mjs check          # 只看状态：落后多少提交、哪些文件变了
 *   node scripts/upstream-sync.mjs fetch          # 抓取变化文件到 .upstream-sync/<sha>/ 并生成报告
 *   node scripts/upstream-sync.mjs fetch v2.7.9   # 指定上游 ref（tag / commit / 分支）
 *
 * 环境变量：
 *   GITHUB_TOKEN  可选，配了就不受匿名 60 次/小时限制
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// 从基线模块读仓库与基线提交，保证只有一处事实来源
const baselineSource = readFileSync(join(ROOT, 'core', 'utils', 'upstreamBaseline.js'), 'utf8');
const REPO = (baselineSource.match(/UPSTREAM_REPO\s*=\s*'([^']+)'/) || [])[1] || 'MarSeventh/CloudFlare-ImgBed';
const BASELINE_SHA = (baselineSource.match(/sha:\s*'([0-9a-f]{40})'/) || [])[1] || '';

/** 这些文件是我们改过的，同步时只能人工合并，脚本绝不建议直接覆盖 */
const PROTECTED = [
    'core/file/fileTools.js',
    'core/file/[[path]].js',
    'core/utils/upstreamBaseline.js',
    'deploy/edgeone/index.js',
    'deploy/edgeone/env.js',
    'deploy/edgeone/kv.js',
    'deploy/edgeone/cache.js',
    'deploy/edgeone/s3.js',
    'deploy/edgeone/spa-index.js',
    'deploy/edgeone/local-smoke.mjs',
    'frontend-dist/index.html',
    'frontend-dist/js/upstream-badge.js',
    'scripts/patch-frontend-edgeone.mjs',
    'scripts/import-cf-dump.mjs',
    'scripts/upstream-sync.mjs',
    'edgeone.json',
];

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

async function api(path) {
    const headers = { 'User-Agent': 'edgeone-imgbed-upstream-sync', Accept: 'application/vnd.github+json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`https://api.github.com${path}`, { headers });
    if (!res.ok) {
        const remaining = res.headers.get('x-ratelimit-remaining');
        throw new Error(`GitHub ${res.status}${res.status === 403 || res.status === 429 ? `（剩余额度 ${remaining ?? '未知'}）` : ''}`);
    }
    return res.json();
}

async function raw(path) {
    const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(path.ref)}/${path.file}`);
    if (!res.ok) return null;
    return await res.text();
}

/**
 * 判断本地这个文件有没有被我们改过：
 * 拿「基线提交里的上游原版」按转换规则转一遍，跟本地现有内容比。
 * raw.githubusercontent 不消耗 API 额度，所以可以逐个文件比对。
 */
async function isLocallyModified(upstreamPath, localPath) {
    if (!existsSync(join(ROOT, localPath))) return { exists: false, modified: true, reason: '本地不存在' };
    try {
        const baselineText = await raw({ ref: BASELINE_SHA, file: upstreamPath });
        if (baselineText === null) return { exists: true, modified: true, reason: '上游基线里没有这个文件' };
        const converted = upstreamPath.startsWith('functions/') ? convertHandlerNames(baselineText) : baselineText;
        const localText = readFileSync(join(ROOT, localPath), 'utf8');
        const same = localText.trim() === converted.trim();
        return { exists: true, modified: !same, reason: same ? '' : '与上游基线不一致' };
    } catch (error) {
        return { exists: true, modified: true, reason: `比对失败：${error.message}` };
    }
}

function mapToLocal(upstreamPath) {
    if (upstreamPath.startsWith('functions/')) {
        return 'core/' + upstreamPath.slice('functions/'.length);
    }
    return upstreamPath;
}

function convertHandlerNames(source) {
    const pairs = [
        ['export async function onRequestGet', 'export async function handleGet'],
        ['export async function onRequestPost', 'export async function handlePost'],
        ['export async function onRequestPut', 'export async function handlePut'],
        ['export async function onRequestPatch', 'export async function handlePatch'],
        ['export async function onRequestDelete', 'export async function handleDelete'],
        ['export async function onRequestOptions', 'export async function handleOptions'],
        ['export async function onRequest', 'export async function handle'],
        ['export function onRequestGet', 'export function handleGet'],
        ['export function onRequestPost', 'export function handlePost'],
        ['export function onRequest', 'export function handle'],
    ];
    let out = source;
    for (const [from, to] of pairs) out = out.split(from).join(to);
    return out;
}

function categorize(path) {
    if (path.startsWith('functions/')) return '边缘函数（需转换：functions/ → core/ + onRequest* → handle*）';
    if (path.startsWith('frontend-dist/') || path.startsWith('frontend/')) return '前端产物（需重跑 scripts/patch-frontend-edgeone.mjs）';
    if (path.startsWith('.github/') || path === 'package.json' || path.includes('package-lock')) return '构建/CI（人工确认）';
    if (path.endsWith('.md')) return '文档（可忽略）';
    return '其它';
}

async function fetchHead(ref) {
    if (ref) {
        const info = await api(`/repos/${REPO}/commits/${ref}`);
        return { sha: info.sha, date: info.commit?.author?.date || '', message: (info.commit?.message || '').split('\n')[0] };
    }
    const list = await api(`/repos/${REPO}/commits/main?per_page=1`);
    const head = Array.isArray(list) ? list[0] : list;
    return { sha: head.sha, date: head?.commit?.author?.date || '', message: (head?.commit?.message || '').split('\n')[0] };
}

async function doCheck() {
    if (!BASELINE_SHA) throw new Error('core/utils/upstreamBaseline.js 里没读到基线 sha');
    const head = await fetchHead();
    console.log(`上游 ${REPO}`);
    console.log(`基线 ${BASELINE_SHA.slice(0, 7)}  →  main ${head.sha.slice(0, 7)}  (${head.date})`);
    console.log(`最新提交：${head.message}`);

    if (head.sha === BASELINE_SHA) {
        console.log('结论：与基线一致，无需同步。');
        return null;
    }

    const cmp = await api(`/repos/${REPO}/compare/${BASELINE_SHA}...${head.sha}`);
    console.log(`\n落后 ${cmp.ahead_by} 个提交，涉及 ${cmp.files?.length || 0} 个文件（GitHub 单次最多列 300 个）`);
    const buckets = {};
    for (const f of cmp.files || []) {
        const key = categorize(f.filename);
        buckets[key] = (buckets[key] || 0) + 1;
    }
    for (const [k, v] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(v).padStart(4)}  ${k}`);
    }
    const protectedHits = (cmp.files || []).filter((f) => PROTECTED.includes(mapToLocal(f.filename)));
    if (protectedHits.length) {
        console.log(`\n其中 ${protectedHits.length} 个是我们改过的文件，只能人工合并：`);
        for (const f of protectedHits) console.log(`  - ${f.filename}  →  ${mapToLocal(f.filename)}`);
    }
    return { head, cmp };
    }

async function doFetch(ref) {
    if (!BASELINE_SHA) throw new Error('core/utils/upstreamBaseline.js 里没读到基线 sha');
    const head = await fetchHead(ref);
    const targetRef = ref || head.sha;
    const cmp = await api(`/repos/${REPO}/compare/${BASELINE_SHA}...${head.sha}`);
    const files = cmp.files || [];

    const outDir = join(ROOT, '.upstream-sync', head.sha.slice(0, 12));
    const upstreamDir = join(outDir, 'upstream');
    const convertedDir = join(outDir, 'converted');
    mkdirSync(upstreamDir, { recursive: true });
    mkdirSync(convertedDir, { recursive: true });

    const rows = [];
    for (const f of files) {
        const localPath = mapToLocal(f.filename);
        const category = categorize(f.filename);
        const localState = await isLocallyModified(f.filename, localPath);
        let action = '待合并';
        let note = localState.reason || '';

        if (f.status === 'removed') {
            action = localState.modified ? '人工确认删除（本地改过）' : '可直接删除';
            rows.push({ path: f.filename, localPath, status: f.status, action, category, note });
            continue;
        }

        const text = await raw({ ref: targetRef, file: f.filename });
        if (text === null) {
            rows.push({ path: f.filename, localPath, status: f.status, action: '抓取失败', category, note });
            continue;
        }
        const saveUpstream = join(upstreamDir, f.filename);
        mkdirSync(dirname(saveUpstream), { recursive: true });
        writeFileSync(saveUpstream, text);

        const converted = f.filename.startsWith('functions/') ? convertHandlerNames(text) : text;
        const saveConverted = join(convertedDir, localPath);
        mkdirSync(dirname(saveConverted), { recursive: true });
        writeFileSync(saveConverted, converted);

        if (!localState.exists) {
            action = '新增文件';
        } else if (localState.modified) {
            action = '人工合并（本地有改动）';
        } else {
            action = '可直接覆盖（用 converted/ 里的版本）';
        }

        rows.push({ path: f.filename, localPath, status: f.status, action, category, note });
    }

    const report = [];
    report.push(`# 上游同步报告\n`);
    report.push(`- 上游：https://github.com/${REPO}`);
    report.push(`- 基线：\`${BASELINE_SHA}\`（${(baselineSource.match(/version:\s*'([^']+)'/) || [])[1] || ''}）`);
    report.push(`- 目标：\`${head.sha}\`${ref ? `（${ref}）` : ''}   ${head.date}`);
    report.push(`- 落后：${cmp.ahead_by} 个提交 / ${files.length} 个文件\n`);
    report.push(`| 上游文件 | 对应本仓库 | 状态 | 处理方式 |`);
    report.push(`| --- | --- | --- | --- |`);
    for (const r of rows) {
        report.push(`| \`${r.path}\` | \`${r.localPath}\` | ${r.status} | ${r.action} |`);
    }
    report.push(`\n## 收尾步骤\n`);
    report.push(`1. 把「可直接覆盖」的文件用 \`.upstream-sync/${head.sha.slice(0, 12)}/converted/\` 里的版本替换。`);
    report.push(`2. 「人工合并」的按 diff 手动改（这些是我们的适配/修复，别丢）。`);
    report.push(`3. 前端有变化时重跑：\`node scripts/patch-frontend-edgeone.mjs\`。`);
    report.push(`4. 新增/删除的路由要同步 \`deploy/edgeone/index.js\` 里的 import 与 routes 表。`);
    report.push(`5. 改完后把 \`core/utils/upstreamBaseline.js\` 的 version / sha / date 更新为目标版本，再提交。`);

    const reportPath = join(outDir, 'REPORT.md');
    writeFileSync(reportPath, report.join('\n'));

    const counts = {};
    for (const r of rows) counts[r.action] = (counts[r.action] || 0) + 1;
    console.log(`目标 ${head.sha.slice(0, 7)}，共 ${files.length} 个文件`);
    for (const [k, v] of Object.entries(counts)) console.log(`  ${String(v).padStart(4)}  ${k}`);
    console.log(`\n报告：${reportPath}`);
    console.log(`预转换产物：${convertedDir}`);
}

const [mode, ref] = process.argv.slice(2);
try {
    if (mode === 'fetch') {
        await doFetch(ref);
    } else {
        await doCheck();
    }
} catch (error) {
    console.error(`失败：${error.message}`);
    process.exitCode = 1;
}
