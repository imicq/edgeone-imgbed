/**
 * 前端分片参数补丁（EdgeOne 1MB 请求体限制）
 *
 * CloudFlare-ImgBed 前端默认按 16MB 分片、20MB 以下整包直传。
 * EdgeOne 边缘函数的请求体上限是 1MB，必须在浏览器侧改小分片，否则 >1MB 的图会在进函数前被 413。
 *
 * 运行：node scripts/patch-frontend-edgeone.mjs
 * 幂等：重复执行不会破坏文件。
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BUNDLE = join(ROOT, 'frontend-dist', 'js', '375.43b3c74e.js');

// 900000 字节 ≈ 0.86MB，给 multipart 字段与头部留出余量
const CHUNK_BYTES = '900000';

const REPLACEMENTS = [
    // 分片大小：discord 9MB / 其它 16MB -> 统一 900KB
    ['"discord"===o?9437184:16777216', `"discord"===o?${CHUNK_BYTES}:${CHUNK_BYTES}`],
    // 整包直传阈值：20MB -> 900KB（超过就走分片）
    ['const i=20971520;e.file.size>i', `const i=${CHUNK_BYTES};e.file.size>i`],
];

let source = readFileSync(BUNDLE, 'utf8');
let changed = 0;

for (const [from, to] of REPLACEMENTS) {
    if (!source.includes(from)) {
        if (source.includes(to)) {
            console.log(`already patched: ${from.slice(0, 28)}…`);
            continue;
        }
        console.warn(`pattern not found (bundle changed?): ${from}`);
        continue;
    }
    source = source.split(from).join(to);
    changed += 1;
}

if (changed > 0) {
    writeFileSync(BUNDLE, source);
    console.log(`patched ${changed} pattern(s) in ${BUNDLE}`);
} else {
    console.log('nothing to patch');
}
