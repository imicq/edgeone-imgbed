/**
 * 把 CloudFlare 版（原版）后台「数据导出」得到的 JSON 直接导入 EdgeOne 版索引。
 *
 * 原版导出的结构是 KV dump：
 *   { timestamp, version, data: { fileCount, files: { "<文件ID>": { metadata, value } }, settings } }
 * 而本项目的 /api/manage/batch/index/* 系列接口要的是记录数组：
 *   [{ id, metadata }]
 * 直接在网页里点「导入」会因为格式不匹配导致文件索引一条都没写进去（设置项却会被应用）。
 * 这个脚本负责格式转换 + 分块上传 + finalize，绕开浏览器端 1MB 请求体限制。
 *
 * 用法：
 *   node scripts/import-cf-dump.mjs <备份.json> --url https://pic.hxy.cc --username admin --password admin
 * 可选：
 *   --chunk 300        每次上传的记录条数（默认 300，body 约 200~400KB，安全低于 EdgeOne 1MB）
 *   --dry-run          只打印将要导入的条数，不发请求
 *   --skip-login       复用已有 cookie（--cookie "k=v; k2=v2"）
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

function parseArgs(argv) {
    const out = { chunk: 300, dryRun: false };
    const rest = [];
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--dry-run') out.dryRun = true;
        else if (a === '--url') out.url = (argv[++i] || '').replace(/\/$/, '');
        else if (a === '--username') out.username = argv[++i];
        else if (a === '--password') out.password = argv[++i];
        else if (a === '--chunk') out.chunk = Number(argv[++i]) || 300;
        else if (a === '--cookie') out.cookie = argv[++i];
        else if (a === '--skip-login') out.cookie = '__keep__';
        else rest.push(a);
    }
    out.file = rest[0];
    return out;
}

async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function pickCookie(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    return raw.map((c) => c.split(';')[0]).join('; ');
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.file || !fs.existsSync(opts.file)) {
        console.error('用法: node scripts/import-cf-dump.mjs <备份.json> --url https://pic.hxy.cc --username admin --password admin');
        process.exit(1);
    }

    const dump = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
    const filesRaw = dump?.data?.files;
    if (!filesRaw) {
        console.error('备份文件里没有 data.files，确认这是原版后台「数据导出」的 JSON');
        process.exit(1);
    }

    // 兼容两种结构：对象（KV dump）与数组（已是记录格式）
    let records;
    if (Array.isArray(filesRaw)) {
        records = filesRaw.map((r) => ({ id: r.id ?? r.name, metadata: r.metadata ?? r.value?.metadata ?? {} }));
    } else {
        records = Object.entries(filesRaw).map(([id, v]) => ({ id, metadata: v?.metadata ?? v?.value?.metadata ?? {} }));
    }
    records = records.filter((r) => typeof r.id === 'string' && r.id.length > 0);

    console.log(`备份文件: ${opts.file}`);
    console.log(`声明 fileCount=${dump?.data?.fileCount ?? '?'}，可导入记录 ${records.length} 条`);
    if (opts.dryRun) return;
    if (!opts.url) { console.error('缺少 --url'); process.exit(1); }

    let cookie = opts.cookie;
    if (cookie === '__keep__') {
        console.error('--skip-login 需要同时给 --cookie');
        process.exit(1);
    }
    if (!cookie) {
        if (!opts.username || !opts.password) { console.error('缺少 --username/--password'); process.exit(1); }
        const res = await fetch(`${opts.url}/api/auth/adminLogin`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: opts.username, password: opts.password }),
        });
        if (!res.ok) {
            console.error(`登录失败: ${res.status} ${await res.text()}`);
            process.exit(1);
        }
        cookie = pickCookie(res);
        console.log('登录成功');
    }

    const sessionId = `rebuild_${Date.now()}_imp`;
    const chunks = [];
    for (let i = 0; i < records.length; i += opts.chunk) chunks.push(records.slice(i, i + opts.chunk));

    for (let c = 0; c < chunks.length; c += 1) {
        const data = chunks[c];
        const checksum = await sha256Hex(JSON.stringify(data));
        const res = await fetch(`${opts.url}/api/manage/batch/index/chunk`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({ chunkId: String(c), sessionId, data, checksum }),
        });
        const text = await res.text();
        if (!res.ok) {
            console.error(`分块 ${c} 上传失败: ${res.status} ${text}`);
            process.exit(1);
        }
        console.log(`分块 ${c}/${chunks.length - 1} → ${data.length} 条 ${text}`);
    }

    const fin = await fetch(`${opts.url}/api/manage/batch/index/finalize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ sessionId, totalChunks: chunks.length, totalFiles: records.length }),
    });
    const finText = await fin.text();
    if (!fin.ok) {
        console.error(`finalize 失败: ${fin.status} ${finText}`);
        process.exit(1);
    }
    console.log(`finalize → ${finText}`);

    const check = await fetch(`${opts.url}/api/manage/list?start=0&count=1`, { headers: { cookie } });
    console.log(`列表校验 → ${await check.text()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
