// EdgeOne Makers 入口：/cron/expiry-cleanup
// EdgeOne 没有 Cron Trigger，用外部定时请求触发文件有效期清理。
import { handleExpiryCleanup } from '../../deploy/edgeone/index.js';

export async function onRequest(context) {
    return await handleExpiryCleanup(context);
}
