import assert from 'node:assert/strict';

// Use the production server loader, without source rewriting or test mocks.
// This catches extensionless imports and runtime dependencies missed by unit tests.
const routes = [
    ['../../core/upload/index.js', 'onRequest'],
    ['../../core/upload/chunkUpload.js', 'handleChunkUpload'],
    ['../../core/upload/chunkMerge.js', 'handleChunkMerge'],
    ['../../core/upload/huggingface/getUploadUrl.js', 'onRequestPost'],
    ['../../core/upload/huggingface/commitUpload.js', 'onRequestPost'],
    ['../../core/file/[[path]].js', 'onRequest'],
    ['../../core/dav/[[path]].js', 'onRequest'],
    ['../../core/api/manage/ai/tags.js', 'onRequest'],
    ['../../core/api/manage/list.js', 'onRequest'],
    ['../../core/api/manage/delete/[[path]].js', 'onRequest'],
    ['../../core/api/manage/delete/batch.js', 'onRequest'],
    ['../../core/api/manage/dedup/scan.js', 'onRequest'],
    ['../../core/api/manage/metadata/[[path]].js', 'onRequest'],
    ['../../core/api/manage/rename/[[path]].js', 'onRequest'],
    ['../../core/api/manage/move/[[path]].js', 'onRequest'],
    ['../../core/api/manage/expiry.js', 'onRequest'],
    ['../../core/api/manage/batch/restore/chunk.js', 'onRequestPost'],
    ['../../core/utils/fileExpiryService.js', 'cleanupExpiredFiles'],
];

for (const [path, handler] of routes) {
    const module = await import(new URL(path, import.meta.url));
    assert.equal(typeof module[handler], 'function', `${path} must export ${handler}`);
}

const middleware = await import('../../core/api/manage/_middleware.js');
assert.ok(Array.isArray(middleware.onRequest));
assert.ok(middleware.onRequest.length > 0);
assert.ok(middleware.onRequest.every(handler => typeof handler === 'function'));
console.log(`Server imports passed: ${routes.length} routes and management middleware`);
