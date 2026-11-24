// EdgeOne 统一入口（单一 catch-all 函数）。
//
// 注意：核心业务处理函数统一命名为 handle* 而不是 Pages 的 onRequestGet/onRequestPost。
// 原因：EdgeOne 的函数运行时会按方法名扫描打包产物里的 onRequestXxx 导出并直接调用它们，
// 会绕过本入口的路由分发（导致任意 GET 都落到同一个 handler）。改名后由
// deploy/edgeone/index.js 内部按 URL 路径与方法自行分发。
import { handleRequest } from '../deploy/edgeone/index.js';

export default async function onRequest(context) {
  const response = await handleRequest(context);

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
