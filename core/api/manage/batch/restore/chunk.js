/**
 * BatchRestoreChunkAPI - 分批恢复数据的 API 端点
 * 
 * 接收并写入一批文件数据到 KV
 */

import { getDatabase } from '../../../../utils/databaseAdapter.js';
import { cleanPersistedMetadata } from '../../../../utils/metadata/metadataSecurity.js';
import { saveIndex } from '../index/finalize.js';

// 导入过程中每个文件分块的原始数据暂存键前缀。
// 说明：EdgeOne KV 是最终一致的，读到刚写入的值可能还是旧值，
// 所以导入期间绝对不能「读-改-写」累积状态，只能追加写入独立键，
// 等导入结束（收到 settings 分块）时一次性汇总、重建索引。
const IMPORT_CHUNK_PREFIX = 'import@c@';

/** 读取当前索引里的全部记录（可能失败，失败返回空数组） */
async function readIndexRecords(db) {
  const records = [];
  try {
    const metaStr = await db.get('manage@index@meta');
    const chunkCount = metaStr ? Number(JSON.parse(metaStr).chunkCount) || 0 : 0;
    for (let i = 0; i < chunkCount; i += 1) {
      const chunkStr = await db.get(`manage@index_${i}`);
      if (!chunkStr) continue;
      for (const r of JSON.parse(chunkStr)) {
        if (r && typeof r.id === 'string') records.push({ id: r.id, metadata: r.metadata || {} });
      }
    }
  } catch (e) {
    console.warn('[import] read existing index failed:', e?.message || e);
  }
  return records;
}

/** 把本批导入记录暂存起来（追加写，每次一个独立键，不读不写旧值） */
async function stageImportRecords(db, records) {
  const key = `${IMPORT_CHUNK_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await db.put(key, JSON.stringify(records));
  return key;
}

/**
 * 导入收尾（收到设置分块时触发）：
 * 汇总所有暂存分块 → 用「备份里的记录」重建索引 → 删掉备份里没有的残留记录。
 */
async function finishImport(db, env) {
  try {
    const index = await db.list({ prefix: IMPORT_CHUNK_PREFIX, limit: 5000 });
    const stageKeys = (index?.keys || []).map((k) => k.name).filter((n) => n.startsWith(IMPORT_CHUNK_PREFIX));
    if (stageKeys.length === 0) return null;

    const importedMap = new Map();
    for (const key of stageKeys) {
      const raw = await db.get(key);
      if (!raw) continue;
      try {
        for (const r of JSON.parse(raw)) {
          if (r && typeof r.id === 'string') importedMap.set(r.id, { id: r.id, metadata: r.metadata || {} });
        }
      } catch (e) {
        console.warn(`[import] stage ${key} parse failed`);
      }
    }

    const imported = Array.from(importedMap.values());
    const importedIds = new Set(imported.map((r) => r.id));

    // 导入期间索引没动过，这里读到的就是「导入前」的记录
    const prev = await readIndexRecords(db);
    const staleIds = prev.map((r) => r.id).filter((id) => !importedIds.has(id));

    let deletedStaleCount = 0;
    for (const id of staleIds) {
      try {
        await db.delete(id);
        deletedStaleCount += 1;
      } catch (e) {
        console.warn(`[import] delete stale ${id} failed: ${e?.message || e}`);
      }
    }

    await saveIndex(db, imported, env);

    for (const key of stageKeys) {
      try {
        await db.delete(key);
      } catch (e) {
        // 忽略
      }
    }

    return { importedCount: importedIds.size, deletedStaleCount, staleIds: staleIds.slice(0, 20) };
  } catch (error) {
    console.warn('[import] finish failed:', error?.message || error);
    return null;
  }
}

// CORS 跨域响应头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

/**
 * 创建 JSON 响应
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

/**
 * 创建错误响应
 */
function errorResponse(message, status = 400, details = null) {
  const responseData = { success: false, error: message };
  if (details) {
    responseData.details = details;
  }
  return jsonResponse(responseData, status);
}

/**
 * 处理 POST 请求 - 恢复一批文件数据
 */
export async function handlePost(context) {
  const { request, env } = context;

  try {
    // 解析请求体
    let body;
    try {
      body = await request.json();
    } catch (parseError) {
      return errorResponse('Invalid JSON in request body', 400);
    }

    // 验证请求体
    const { type, data } = body;
    
    if (!type || !['files', 'settings'].includes(type)) {
      return errorResponse('type must be "files" or "settings"', 400);
    }
    
    if (!data || typeof data !== 'object') {
      return errorResponse('data must be an object', 400);
    }

    const db = getDatabase(env);
    let restoredCount = 0;
    let failedCount = 0;
    const errors = [];

    if (type === 'files') {
      // 恢复文件数据 - 并行写入
      const filePromises = Object.entries(data).map(async ([key, fileData]) => {
        try {
          const metadata = cleanPersistedMetadata(fileData.metadata);
          if (fileData.value) {
            // 有 value 的文件（如 Telegram/Discord 分块文件）
            await db.put(key, fileData.value, {
              metadata
            });
          } else if (fileData.metadata) {
            // 只有元数据的文件
            await db.put(key, '', {
              metadata
            });
          }
          return { success: true };
        } catch (error) {
          return { success: false, key, error: error.message };
        }
      });

      const results = await Promise.all(filePromises);
      for (const result of results) {
        if (result.success) {
          restoredCount++;
        } else {
          failedCount++;
          errors.push({ key: result.key, error: result.error });
        }
      }

      // 先把本批记录暂存（追加写独立键）；索引等导入结束（settings 分块）时统一重建
      const recordsForIndex = Object.entries(data)
        .filter(([, fileData]) => fileData && fileData.metadata)
        .map(([key, fileData]) => ({
          id: key,
          metadata: cleanPersistedMetadata(fileData.metadata),
        }));
      let staged = true;
      try {
        await stageImportRecords(db, recordsForIndex);
      } catch (e) {
        staged = false;
        console.warn('[import] stage failed:', e?.message || e);
      }
      return jsonResponse({
        success: true,
        restoredCount,
        failedCount,
        errors: errors.length > 0 ? errors.slice(0, 10) : undefined, // 只返回前10个错误
        staged,
      });
    } else if (type === 'settings') {
      // 恢复系统设置 - 并行写入
      // 备份时移除了 manage@ 前缀，恢复时需要加回来
      const settingPromises = Object.entries(data).map(async ([key, value]) => {
        try {
          // 设置值可能是对象或字符串
          const valueToStore = typeof value === 'string' ? value : JSON.stringify(value);
          // 加回 manage@ 前缀
          const fullKey = key.startsWith('manage@') ? key : `manage@${key}`;
          await db.put(fullKey, valueToStore);
          return { success: true };
        } catch (error) {
          return { success: false, key, error: error.message };
        }
      });

      const results = await Promise.all(settingPromises);
      for (const result of results) {
        if (result.success) {
          restoredCount++;
        } else {
          failedCount++;
          errors.push({ key: result.key, error: result.error });
        }
      }

      // 设置分块是导入流程的最后一步：此时收尾，把备份里没有的残留记录删掉，
      // 让本地的 KV/索引与备份完全一致（整库覆盖）。
      const finalize = await finishImport(db, env);
      return jsonResponse({
        success: true,
        restoredCount,
        failedCount,
        errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
        ...(finalize
          ? {
              importedCount: finalize.importedCount,
              deletedStaleCount: finalize.deletedStaleCount,
            }
          : {}),
      });
    }

    return jsonResponse({
      success: true,
      restoredCount,
      failedCount,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined // 只返回前10个错误
    });

  } catch (error) {
    console.error('Error in BatchRestoreChunkAPI:', error);
    return errorResponse(`Server error: ${error.message}`, 500);
  }
}

/**
 * 处理 OPTIONS 请求 - CORS 预检
 */
export async function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

/**
 * 默认请求处理器
 */
export async function handle(context) {
  const { request } = context;

  if (request.method === 'POST') {
    return handlePost(context);
  }

  if (request.method === 'OPTIONS') {
    return handleOptions();
  }

  return errorResponse('Method not allowed', 405);
}
