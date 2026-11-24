// EdgeOne Makers 入口：api/index.js
// 复用 deploy/edgeone/index.js 中的路由表与中间件链，业务代码无需改动。
import { handleRequest } from '../../deploy/edgeone/index.js';

export async function onRequest(context) {
    return await handleRequest(context);
}