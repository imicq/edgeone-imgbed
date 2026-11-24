/**
 * BatchRestoreChunkAPI - 分批恢复数据的 API 端点
 * 
 * 接收并写入一批文件数据到 KV
 */

import { getDatabase } from '../../../../utils/databaseAdapter.js';
import { cleanPersistedMetadata } from '../../../../utils/metadata/metadataSecurity.js';
import { saveIndex } from '../index/finalize.js';

// 导入会话：记录本次导入的起点（导入前索引里有哪些 id）与已导入的记录。
// 设置分块永远排在文件分块之后，所以收到 settings 分块时即可判定「文件导入已结束」，
// 此时把「导入前存在、本次备份里没有」的残留记录从 KV 中删掉，实现整库覆盖。
const IMPORT_SESSION_KEY = 'import@files@session';
const IMPORT_SESSION_TTL_MS = 60 * 60 * 1000; // 1 小时没动静就当作新的一次导入

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

/**
 * 导入文件：以「本次导入的记录」为准重建索引（整库覆盖语义），
 * 导入完成即可在管理页看到，不需要再点「重建索引」。
 */
async function syncIndexForImport(db, env, records) {
  try {
    const now = Date.now();
    let session = null;
    const raw = await db.get(IMPORT_SESSION_KEY);
    if (raw) {
      try {
        session = JSON.parse(raw);
      } catch (e) {
        session = null;
      }
    }
    if (!session || !session.startedAt || now - session.startedAt > IMPORT_SESSION_TTL_MS) {
      const existing = await readIndexRecords(db);
      session = { startedAt: now, prevIds: existing.map((r) => r.id), records: [] };
    }

    const map = new Map(session.records.map((r) => [r.id, r]));
    for (const r of records) {
      map.set(r.id, { id: r.id, metadata: r.metadata });
    }
    session.records = Array.from(map.values());
    session.updatedAt = now;

    await db.put(IMPORT_SESSION_KEY, JSON.stringify(session));
    const result = await saveIndex(db, session.records, env);
    return { totalCount: session.records.length, ok: !!result?.success };
  } catch (error) {
    console.warn('[import] sync index failed:', error?.message || error);
    return { totalCount: 0, ok: false };
  }
}

/**
 * 导入收尾（在收到设置分块时触发）：
 * 删掉「导入前有、本次备份里没有」的残留记录，并清理导入会话。
 */
async function finishImport(db, env) {
  try {
    const raw = await db.get(IMPORT_SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    const importedIds = new Set((session.records || []).map((r) => r.id));
    const staleIds = (session.prevIds || []).filter((id) => !importedIds.has(id));

    let deletedCount = 0;
    for (const id of staleIds) {
      try {
        await db.delete(id);
        deletedCount += 1;
      } catch (e) {
        console.warn(`[import] delete stale ${id} failed: ${e?.message || e}`);
      }
    }

    await saveIndex(db, session.records || [], env);
    await db.delete(IMPORT_SESSION_KEY);
    return { importedCount: importedIds.size, deletedStaleCount: deletedCount, staleIds: staleIds.slice(0, 20) };
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

      // 导入文件后立刻同步索引，用户不用再手动点「重建索引」
      const recordsForIndex = Object.entries(data)
        .filter(([, fileData]) => fileData && fileData.metadata)
        .map(([key, fileData]) => ({
          id: key,
          metadata: cleanPersistedMetadata(fileData.metadata),
        }));
      const indexSync = await syncIndexForImport(db, env, recordsForIndex);
      return jsonResponse({
        success: true,
        restoredCount,
        failedCount,
        errors: errors.length > 0 ? errors.slice(0, 10) : undefined, // 只返回前10个错误
        indexTotalCount: indexSync.totalCount,
        indexSynced: indexSync.ok,
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
