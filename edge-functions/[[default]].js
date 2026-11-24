// EdgeOne 版统一入口：所有非静态请求都走这里，再由 deploy/edgeone/index.js 内部路由分发。
// 采用单一 catch-all 函数，避免每个路由各自打包一份代码（Edge Functions 代码包上限 5MB）。
import { handleRequest } from '../deploy/edgeone/index.js';

export default async function onRequest(context) {
    const response = await handleRequest(context);

    // EdgeOne 的默认缓存策略会缓存动态响应，且对 catch-all 函数可能忽略具体路径，
    // 这里统一给没有显式声明缓存的响应加上 no-store，避免不同接口互相串缓存。
    if (!response.headers.has('cache-control')) {
        const headers = new Headers(response.headers);
        headers.set('cache-control', 'private, no-store, max-age=0');
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    }

    return response;
}
