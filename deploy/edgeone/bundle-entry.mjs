// 供 esbuild 预打包使用的入口：只导出 EdgeOne 认的默认函数，
// 打包时加 minify，避免包内再出现 onRequestGet / onRequestPost 这类命名导出，
// 否则 EdgeOne 会直接按方法调用它们，绕过本文件的统一路由分发。
import { handleRequest } from './index.js';

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
