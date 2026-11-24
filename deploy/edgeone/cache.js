/**
 * EdgeOne 边缘函数内的「节点级」图片缓存。
 *
 * 背景：EdgeOne Makers 的请求一旦进入 Edge Function，就不会再走站点的静态缓存层
 * （`/js/*` 这类构建产物能命中 `EO-Cache-Status: Cache Hit`，但 `/file/*` 每次都会
 * 执行函数并回源 S3/R2，TTFB 1~3 秒）。因此这里用 EdgeOne 运行时注入的 Cache API
 * 在函数内部做一层缓存，把 R2 回源的字节留在当前节点上。
 *
 * 注意点：
 * 1. EdgeOne 的 Cache API 缓存只在当前数据节点有效，不会跨节点复制，所以是「命中就快、
 *    未命中就回源」的短路径优化，而不是真正的 CDN 缓存；
 * 2. 命中缓存前仍然执行防盗链校验（空 Referer / 非白名单域名会被拒绝），避免缓存绕过
 *    后台的放行域名规则；
 * 3. 每次写入都带 `x-imgbed-cache-key`（pathname+search），命中时严格比对，
 *    以防 Cache API 的键匹配语义与预期不一致时返回错误的图片；
 * 4. 只缓存 GET、非 Range、状态 200、带 Content-Length 的响应，TTL 10 分钟。
 */
import { withProjectHeaders } from '../../core/utils/projectHeaders.js';
import { fetchSecurityConfig } from '../../core/utils/sysConfig.js';
import { isDomainAllowed } from '../../core/file/fileTools.js';

const FILE_PATH_RE = /^\/file\//;
const NODE_CACHE_TTL_SECONDS = 600;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const INTERNAL_HEADER = 'x-imgbed-cache-key';
const CACHE_NAMESPACE = 'imgbed-files';

async function openFileCache() {
    try {
        if (typeof caches === 'undefined' || !caches || typeof caches.open !== 'function') {
            return null;
        }
        return await caches.open(CACHE_NAMESPACE);
    } catch (error) {
        console.warn('EdgeOne Cache API unavailable:', error?.message || error);
        return null;
    }
}

async function refererAllowed(request, env, url) {
    try {
        const securityConfig = await fetchSecurityConfig(env);
        return isDomainAllowed({
            Referer: request.headers.get('Referer'),
            securityConfig,
            url,
        });
    } catch (error) {
        console.warn('Cache hit referer check failed, falling back to origin path:', error?.message || error);
        return false;
    }
}

function buildHitResponse(cached) {
    const headers = new Headers(cached.headers);
    headers.delete(INTERNAL_HEADER);
    // 节点缓存里为了控制 TTL 写的是 max-age=600，但对浏览器要还原成上游的 30 天，
    // 否则命中缓存的响应会把浏览器的缓存时间一起缩短。
    headers.set('Cache-Control', 'public, max-age=2592000');
    headers.set('x-imgbed-cache', 'HIT');
    return withProjectHeaders(new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers,
    }));
}

export async function maybeServeFromCache(request, ctx, producer, isCachedServable, env) {
    const method = (request.method || 'GET').toUpperCase();
    if (method !== 'GET') {
        return await producer();
    }

    let url;
    try {
        url = new URL(request.url);
    } catch (error) {
        return await producer();
    }
    if (!FILE_PATH_RE.test(url.pathname)) {
        return await producer();
    }
    // Range 请求与后台预览不走节点缓存
    if (request.headers.get('Range') || url.searchParams.get('from') === 'admin') {
        return await producer();
    }

    const cache = await openFileCache();
    if (!cache) {
        return await producer();
    }

    const cacheKey = url.pathname + url.search;

    let cached = null;
    try {
        cached = await cache.match(request.url);
    } catch (error) {
        cached = null;
    }

    if (cached && cached.headers.get(INTERNAL_HEADER) === cacheKey) {
        if (await refererAllowed(request, env, url)) {
            return buildHitResponse(cached);
        }
    }

    const response = await producer();

    if (response && response.status === 200 && response.body) {
        const contentLength = Number(response.headers.get('Content-Length') || 0);
        if (contentLength > 0 && contentLength <= MAX_CACHE_BYTES && !response.headers.get('Set-Cookie')) {
            try {
                const headers = new Headers(response.headers);
                headers.set(INTERNAL_HEADER, cacheKey);
                headers.set('Cache-Control', `public, max-age=${NODE_CACHE_TTL_SECONDS}`);
                const toStore = new Response(response.clone().body, { status: 200, headers });
                const storing = cache.put(request.url, toStore).catch((error) => {
                    console.warn('Failed to store file in node cache:', error?.message || error);
                    return null;
                });
                if (ctx && typeof ctx.waitUntil === 'function') {
                    ctx.waitUntil(storing);
                } else {
                    await storing;
                }
            } catch (error) {
                console.warn('Failed to prepare node cache entry:', error?.message || error);
            }
        }
    }

    return response;
}
