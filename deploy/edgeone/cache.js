/**
 * EdgeOne 版的 Worker Cache 替代实现。
 *
 * Cloudflare 的 caches.default 按完整 URL 作为缓存键，但 EdgeOne 的 Cache API 不支持
 * 这种「按 URL 命中」的语义（实测会忽略路径，导致所有接口命中同一份缓存）。
 * 因此 EdgeOne 版直接跳过业务层的 caches.default 缓存，只依赖站点的 CDN 缓存规则。
 */
export async function maybeServeFromCache(request, ctx, producer) {
    return await producer();
}
