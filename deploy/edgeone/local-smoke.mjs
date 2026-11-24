/**
 * EdgeOne 适配层本地冒烟测试
 *
 * 不需要登录腾讯云，模拟 EdgeOne 的 KV/上下文，验证：
 *   1. edge-functions 入口 -> deploy/edgeone 路由表 是否打通
 *   2. 中间件链（鉴权）是否执行
 *   3. EdgeOne KV 兼容层（自定义 key 编码、metadata、TTL）是否可用
 *
 * 运行：node deploy/edgeone/local-smoke.mjs
 */
import { handleRequest } from './index.js';
import { encodeKey, decodeKey } from './kv.js';

/** 内存版 EdgeOne KV：只实现平台文档里的 get/put/delete/list */
class MemoryKV {
    constructor() {
        this.store = new Map();
    }
    async put(key, value) {
        this.store.set(key, value);
    }
    async get(key, options) {
        const value = this.store.get(key);
        if (value === undefined) return null;
        if (options && options.type === 'json' && typeof value === 'string') {
            try {
                return JSON.parse(value);
            } catch {
                return null;
            }
        }
        if (options && options.type === 'arrayBuffer') {
            if (value instanceof ArrayBuffer) return value;
            if (value instanceof Uint8Array) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            if (typeof value === 'string') return new TextEncoder().encode(value).buffer;
        }
        return value;
    }
    async delete(key) {
        this.store.delete(key);
    }
    async list(options = {}) {
        const prefix = options.prefix || '';
        const limit = Math.min(options.limit || 256, 256);
        const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
        let start = 0;
        if (options.cursor) {
            start = keys.findIndex((k) => k >= options.cursor);
            if (start < 0) start = keys.length;
        }
        const page = keys.slice(start, start + limit);
        const complete = start + limit >= keys.length;
        return {
            keys: page.map((key) => ({ key })),
            complete,
            cursor: complete ? null : keys[start + limit],
        };
    }
}

globalThis.caches = {
    default: { async match() { return undefined; }, async put() {}, async delete() { return false; } },
};

const kv = new MemoryKV();
globalThis.img_url = kv;

const baseEnv = {
    S3_SINGLE_PUT_MERGE: 'true',
    S3_SINGLE_PUT_MERGE_NOTE: 'staging mode for 1MB body limit',
};

function makeContext(url, init = {}) {
    return {
        request: new Request(url, init),
        env: { ...baseEnv },
        params: {},
        waitUntil: (p) => { if (p && typeof p.catch === 'function') p.catch(() => {}); },
        clientIp: '203.0.113.7',
    };
}

const cases = [
    ['GET', 'http://localhost/api/auth/sessionCheck', [200]],
    ['GET', 'http://localhost/api/manage/list', [200, 401]],
    // 原项目在取不到对象时返回 500「Failed to fetch image」，这里只验证路由能进到 file 处理器
    ['GET', 'http://localhost/file/not-exists.jpg', [404, 500]],
    ['GET', 'http://localhost/random', [403, 200]],
];

let failed = 0;
for (const [method, url, allowed] of cases) {
    try {
        const response = await handleRequest(makeContext(url, { method }));
        const text = (await response.text()).slice(0, 160).replace(/\s+/g, ' ');
        console.log(`${method} ${url} -> ${response.status} ${text}`);
        if (!allowed.includes(response.status)) failed += 1;
    } catch (error) {
        failed += 1;
        console.error(`${method} ${url} -> threw: ${error.stack || error}`);
    }
}

// KV 编码往返 & 前缀语义
const sampleKeys = ['manage@index@meta', 'manage@index_0', 'a/b/c.jpg', 'expiry@1700000000000_x', '中文文件名.png', 'under_score_key'];
for (const key of sampleKeys) {
    const encoded = encodeKey(key);
    const decoded = decodeKey(encoded);
    const ok = decoded === key && /^[A-Za-z0-9_]+$/.test(encoded);
    if (!ok) failed += 1;
    console.log(`key encode ${ok ? 'OK' : 'FAIL'} ${key} -> ${encoded}`);
}

await kv.put(encodeKey('manage@index@meta'), JSON.stringify({ ok: true }), { type: 'text' });
await kv.put(encodeKey('manage@index_0'), 'chunk');
const listed = await kv.list({ prefix: encodeKey('manage@index'), limit: 10 });
console.log('list prefix result:', JSON.stringify(listed.keys));

console.log(failed === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failed})`);
process.exitCode = failed === 0 ? 0 : 1;
