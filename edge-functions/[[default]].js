// EdgeOne 版统一入口：所有非静态请求都走这里，再由 deploy/edgeone/index.js 内部路由分发。
// 采用单一 catch-all 函数，避免每个路由各自打包一份代码（Edge Functions 代码包上限 5MB）。
import { handleRequest } from '../deploy/edgeone/index.js';

export default async function onRequest(context) {
    return await handleRequest(context);
}
