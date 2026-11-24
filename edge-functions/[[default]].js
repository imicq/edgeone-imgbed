// EdgeOne 统一入口：调用预打包好的单文件函数（见 scripts/build-function.mjs）。
// 预打包保证包内不存在 onRequestGet / onRequestPost 等命名导出，
// 从而由 function-bundle 内部的 handleRequest 按 URL 路径统一分发。
import bundleHandler from '../function-bundle.mjs';

export default async function onRequest(context) {
  return bundleHandler(context);
}
