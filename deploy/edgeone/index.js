/**
 * EdgeOne Makers 部署适配层
 *
 * 由 deploy/worker/index.js（Workers 入口，自动生成）派生，路由表与中间件链保持不变，
 * 只替换运行时差异：
 *   - 入口由 EdgeOne 的 handle 触发，不再是 Cloudflare 的 fetch/scheduled
 *   - 环境绑定、KV、caches、request.cf 由 deploy/edgeone/env.js 适配
 *   - 没有 ASSETS 绑定，未命中的路径交给 Makers 静态资源处理
 */

import { maybeServeFromCache } from './cache.js';
import { SPA_INDEX_HTML } from './spa-index.js';
import { withProjectHeaders } from '../../core/utils/projectHeaders.js';
import { toPagesContext } from './env.js';

// --- 中间件（自动生成） ---
import * as mw_root from '../../core/_middleware.js';
import * as mw_api from '../../core/api/_middleware.js';
import * as mw_api_manage from '../../core/api/manage/_middleware.js';
import * as mw_dav from '../../core/dav/_middleware.js';
import * as mw_file from '../../core/file/_middleware.js';
import * as mw_random from '../../core/random/_middleware.js';
import * as mw_upload from '../../core/upload/_middleware.js';

// --- 路由模块（自动生成） ---
import * as apiManageBatchIndexChunk from '../../core/api/manage/batch/index/chunk.js';
import * as apiManageBatchIndexConfig from '../../core/api/manage/batch/index/config.js';
import * as apiManageBatchIndexFinalize from '../../core/api/manage/batch/index/finalize.js';
import * as apiManageBatchRestoreChunk from '../../core/api/manage/batch/restore/chunk.js';
import * as apiManageAiTags from '../../core/api/manage/ai/tags.js';
import * as apiManageAiTest from '../../core/api/manage/ai/test.js';
import * as apiManageBatchList from '../../core/api/manage/batch/list.js';
import * as apiManageBatchSettings from '../../core/api/manage/batch/settings.js';
import * as apiManageCusConfigBlockip from '../../core/api/manage/cusConfig/blockip.js';
import * as apiManageCusConfigBlockipList from '../../core/api/manage/cusConfig/blockipList.js';
import * as apiManageCusConfigFiles from '../../core/api/manage/cusConfig/files.js';
import * as apiManageCusConfigList from '../../core/api/manage/cusConfig/list.js';
import * as apiManageCusConfigWhiteip from '../../core/api/manage/cusConfig/whiteip.js';
import * as apiManageDedupScan from '../../core/api/manage/dedup/scan.js';
import * as apiManageDeleteBatch from '../../core/api/manage/delete/batch.js';
import * as apiManageSysConfigAi from '../../core/api/manage/sysConfig/ai.js';
import * as apiManageSysConfigOthers from '../../core/api/manage/sysConfig/others.js';
import * as apiManageSysConfigPage from '../../core/api/manage/sysConfig/page.js';
import * as apiManageSysConfigSecurity from '../../core/api/manage/sysConfig/security.js';
import * as apiManageSysConfigUpload from '../../core/api/manage/sysConfig/upload.js';
import * as apiManageTagsApply from '../../core/api/manage/tags/apply.js';
import * as apiManageTagsAutocomplete from '../../core/api/manage/tags/autocomplete.js';
import * as apiManageTagsBatch from '../../core/api/manage/tags/batch.js';
import * as apiAuthAdminLogin from '../../core/api/auth/adminLogin.js';
import * as apiAuthLogin from '../../core/api/auth/login.js';
import * as apiAuthLogout from '../../core/api/auth/logout.js';
import * as apiAuthResetAuth from '../../core/api/auth/resetAuth.js';
import * as apiAuthSessionCheck from '../../core/api/auth/sessionCheck.js';
import * as apiBingWallpaper_index from '../../core/api/bing/wallpaper/index.js';
import * as apiManageApiTokens from '../../core/api/manage/apiTokens.js';
import * as apiManageExpiry from '../../core/api/manage/expiry.js';
import * as apiManageList from '../../core/api/manage/list.js';
import * as apiManageQuota from '../../core/api/manage/quota.js';
import * as apiManageUpstream from '../../core/api/manage/upstream.js';
import * as apiPublicList from '../../core/api/public/list.js';
import * as uploadHuggingfaceCommitUpload from '../../core/upload/huggingface/commitUpload.js';
import * as uploadHuggingfaceCompleteMultipart from '../../core/upload/huggingface/completeMultipart.js';
import * as uploadHuggingfaceGetUploadUrl from '../../core/upload/huggingface/getUploadUrl.js';
import * as apiChannels from '../../core/api/channels.js';
import * as apiDirectoryTree from '../../core/api/directoryTree.js';
import * as apiFetchRes from '../../core/api/fetchRes.js';
import * as apiUserConfig from '../../core/api/userConfig.js';
import * as random_index from '../../core/random/index.js';
import * as upload_index from '../../core/upload/index.js';
import * as apiManageBlockCatchAll from '../../core/api/manage/block/[[path]].js';
import * as apiManageDeleteCatchAll from '../../core/api/manage/delete/[[path]].js';
import * as apiManageMetadataCatchAll from '../../core/api/manage/metadata/[[path]].js';
import * as apiManageMoveCatchAll from '../../core/api/manage/move/[[path]].js';
import * as apiManageRenameCatchAll from '../../core/api/manage/rename/[[path]].js';
import * as apiManageTagsCatchAll from '../../core/api/manage/tags/[[path]].js';
import * as apiManageWhiteCatchAll from '../../core/api/manage/white/[[path]].js';
import * as davCatchAll from '../../core/dav/[[path]].js';
import * as fileCatchAll from '../../core/file/[[path]].js';

// --- Worker Cache 与定时任务 ---
import { runExpiryCleanupJob } from '../../core/utils/fileExpiryService.js';

// ==================== 自动生成的路由表 ====================

const routes = [
    { path: '/api/manage/batch/index/chunk', module: apiManageBatchIndexChunk, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/batch/index/config', module: apiManageBatchIndexConfig, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/batch/index/finalize', module: apiManageBatchIndexFinalize, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/batch/restore/chunk', module: apiManageBatchRestoreChunk, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/ai/tags', module: apiManageAiTags, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/ai/test', module: apiManageAiTest, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/batch/list', module: apiManageBatchList, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/batch/settings', module: apiManageBatchSettings, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/cusConfig/blockip', module: apiManageCusConfigBlockip, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/cusConfig/blockipList', module: apiManageCusConfigBlockipList, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/cusConfig/files', module: apiManageCusConfigFiles, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/cusConfig/list', module: apiManageCusConfigList, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/cusConfig/whiteip', module: apiManageCusConfigWhiteip, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/dedup/scan', module: apiManageDedupScan, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/delete/batch', module: apiManageDeleteBatch, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/sysConfig/ai', module: apiManageSysConfigAi, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/sysConfig/others', module: apiManageSysConfigOthers, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/sysConfig/page', module: apiManageSysConfigPage, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/sysConfig/security', module: apiManageSysConfigSecurity, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/sysConfig/upload', module: apiManageSysConfigUpload, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/tags/apply', module: apiManageTagsApply, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/tags/autocomplete', module: apiManageTagsAutocomplete, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/tags/batch', module: apiManageTagsBatch, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/auth/adminLogin', module: apiAuthAdminLogin, middlewares: [mw_root, mw_api] },
    { path: '/api/auth/login', module: apiAuthLogin, middlewares: [mw_root, mw_api] },
    { path: '/api/auth/logout', module: apiAuthLogout, middlewares: [mw_root, mw_api] },
    { path: '/api/auth/resetAuth', module: apiAuthResetAuth, middlewares: [mw_root, mw_api] },
    { path: '/api/auth/sessionCheck', module: apiAuthSessionCheck, middlewares: [mw_root, mw_api] },
    { path: '/api/bing/wallpaper', module: apiBingWallpaper_index, middlewares: [mw_root, mw_api] },
    { path: '/api/manage/apiTokens', module: apiManageApiTokens, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/expiry', module: apiManageExpiry, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/list', module: apiManageList, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/quota', module: apiManageQuota, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/manage/upstream', module: apiManageUpstream, middlewares: [mw_root, mw_api, mw_api_manage] },
    { path: '/api/public/list', module: apiPublicList, middlewares: [mw_root, mw_api] },
    { path: '/upload/huggingface/commitUpload', module: uploadHuggingfaceCommitUpload, middlewares: [mw_root, mw_upload] },
    { path: '/upload/huggingface/completeMultipart', module: uploadHuggingfaceCompleteMultipart, middlewares: [mw_root, mw_upload] },
    { path: '/upload/huggingface/getUploadUrl', module: uploadHuggingfaceGetUploadUrl, middlewares: [mw_root, mw_upload] },
    { path: '/api/channels', module: apiChannels, middlewares: [mw_root, mw_api] },
    { path: '/api/directoryTree', module: apiDirectoryTree, middlewares: [mw_root, mw_api] },
    { path: '/api/fetchRes', module: apiFetchRes, middlewares: [mw_root, mw_api] },
    { path: '/api/userConfig', module: apiUserConfig, middlewares: [mw_root, mw_api] },
    { path: '/random', module: random_index, middlewares: [mw_root, mw_random] },
    { path: '/upload', module: upload_index, middlewares: [mw_root, mw_upload] },
    { path: '/api/manage/block/', module: apiManageBlockCatchAll, middlewares: [mw_root, mw_api, mw_api_manage], catchAll: true },
    { path: '/api/manage/delete/', module: apiManageDeleteCatchAll, middlewares: [mw_root, mw_api, mw_api_manage], catchAll: true },
    { path: '/api/manage/metadata/', module: apiManageMetadataCatchAll, middlewares: [mw_root, mw_api, mw_api_manage], catchAll: true },
    { path: '/api/manage/move/', module: apiManageMoveCatchAll, middlewares: [mw_root, mw_api, mw_api_manage], catchAll: true },
    { path: '/api/manage/rename/', module: apiManageRenameCatchAll, middlewares: [mw_root, mw_api, mw_api_manage], catchAll: true },
    { path: '/api/manage/tags/', module: apiManageTagsCatchAll, middlewares: [mw_root, mw_api, mw_api_manage], catchAll: true },
    { path: '/api/manage/white/', module: apiManageWhiteCatchAll, middlewares: [mw_root, mw_api, mw_api_manage], catchAll: true },
    { path: '/dav/', module: davCatchAll, middlewares: [mw_root, mw_dav], catchAll: true },
    { path: '/file/', module: fileCatchAll, middlewares: [mw_root, mw_file], catchAll: true },
];


// ==================== 路由匹配 ====================

function matchRoute(pathname) {
    for (const route of routes) {
        if (route.catchAll) {
            if (pathname.startsWith(route.path)) {
                const rest = pathname.slice(route.path.length);
                const pathParam = rest.split('/').filter(Boolean);
                return { route, params: { path: pathParam } };
            }
        } else {
            if (pathname === route.path || pathname === route.path + '/') {
                return { route, params: {} };
            }
        }
    }
    return null;
}


// 不允许走 SPA 回退的路径前缀（这些是 API / 上传 / 文件 / WebDAV 等动态路径）
const SPA_EXCLUDED_PREFIXES = ['/api/', '/api', '/upload', '/file', '/random', '/dav', '/s3'];

function looksLikeAsset(pathname) {
    if (SPA_EXCLUDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/') || pathname.startsWith(p))) {
        return true;
    }
    const last = pathname.split('/').pop() || '';
    return last.includes('.');
}


// ==================== 中间件链执行 ====================

function collectMiddlewares(middlewareModules) {
    const handlers = [];
    for (const mod of middlewareModules) {
        if (mod.handle) {
            if (Array.isArray(mod.handle)) {
                handlers.push(...mod.handle);
            } else {
                handlers.push(mod.handle);
            }
        }
    }
    return handlers;
}

function createNextRequest(input, init, baseRequest) {
    if (input instanceof Request) {
        return init ? new Request(input, init) : input;
    }

    const url = new URL(input, baseRequest.url).toString();
    return new Request(url, init);
}

async function executeChain(middlewares, handler, context) {
    const chain = [...middlewares, handler];
    let index = 0;
    context.next = async function (input, init) {
        if (input !== undefined) {
            context.request = createNextRequest(input, init, context.request);
        }

        if (index < chain.length) {
            return await chain[index++](context);
        }
        return new Response('Not Found', { status: 404 });
    };
    return await context.next();
}


// ==================== EdgeOne 入口 ====================

/**
 * EdgeOne Pages Functions / Edge Functions 的 handle 入口。
 * 由 edge-core/ 下的具体路由文件转发进来。
 */
export async function handleRequest(eventContext) {
    const context = toPagesContext(eventContext);
    return await dispatch(context.request, context.env, {
        waitUntil: context.waitUntil,
        passThroughOnException: () => {},
    });
}

async function dispatch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const matched = matchRoute(pathname);

    // 没有命中业务路由
    if (!matched) {
        // SPA 回退：前端是 history 模式路由（/dashboard、/adminLogin、/browse/xx 等），
        // 刷新这类无扩展名路径时静态层没有对应文件，返回 index.html 让 Vue Router 接管。
        const method = request.method.toUpperCase();
        if ((method === 'GET' || method === 'HEAD') && !looksLikeAsset(pathname)) {
            return withProjectHeaders(new Response(method === 'HEAD' ? null : SPA_INDEX_HTML, {
                status: 200,
                headers: {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-cache',
                },
            }));
        }
        return withProjectHeaders(new Response('Not Found', { status: 404 }));
    }

    const { route, params } = matched;
    const mod = route.module;

    const method = request.method.toUpperCase();
    const methodHandlerName = 'handle' + method.charAt(0) + method.slice(1).toLowerCase();

    let handler = null;
    if (typeof mod[methodHandlerName] === 'function') {
        handler = mod[methodHandlerName];
    } else if (mod.handle) {
        handler = typeof mod.handle === 'function'
            ? mod.handle
            : mod.handle[mod.handle.length - 1];
    }

    if (!handler) {
        return withProjectHeaders(new Response('Method Not Allowed', { status: 405 }));
    }

    const middlewares = collectMiddlewares(route.middlewares);

    if (Array.isArray(mod.handle) && mod.handle.length > 1 &&
        handler === mod.handle[mod.handle.length - 1]) {
        middlewares.push(...mod.handle.slice(0, -1));
    }

    const context = {
        request,
        env,
        params,
        functionPath: route.path.endsWith('/') && route.path !== '/'
            ? route.path.slice(0, -1)
            : route.path,
        waitUntil: ctx.waitUntil,
        passThroughOnException: () => {},
        next: null,
        data: { serverRuntime: 'pages' },
    };

    // 路由模块可导出 isCachedResponseServable，在返回缓存前确认缓存仍然有效
    const isCachedServable = typeof mod.isCachedResponseServable === 'function'
        ? () => mod.isCachedResponseServable(context)
        : null;

    const response = await maybeServeFromCache(request, ctx, () => executeChain(middlewares, handler, context), isCachedServable, env);
    return withProjectHeaders(response);
}

/**
 * 手动触发文件有效期清理（EdgeOne 没有 Cloudflare 的 Cron Trigger）。
 * 由 edge-core/api/expiry-cleanup.js 暴露，需要用环境变量 EXPIRY_CLEANUP_TOKEN 保护。
 */
export async function handleExpiryCleanup(eventContext) {
    const context = toPagesContext(eventContext);
    const token = context.env.EXPIRY_CLEANUP_TOKEN;
    if (token) {
        const provided = context.request.headers.get('x-cleanup-token')
            || new URL(context.request.url).searchParams.get('token');
        if (provided !== token) {
            return new Response('Forbidden', { status: 403 });
        }
    }
    const result = await runExpiryCleanupJob(context.env, 'pages', context.waitUntil);
    return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json; charset=UTF-8' },
    });
}

