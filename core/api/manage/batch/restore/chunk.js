/**
 * BatchRestoreChunkAPI - 分批恢复数据的 API 端点
 * 
 * 接收并写入一批文件数据到 KV
 */

import { getDatabase } from '../../../../utils/databaseAdapter.js';
import { cleanPersistedMetadata } from '../../../../utils/metadata/metadataSecurity.js';
import { saveIndex } from '../index/finalize.js';

// 导入时累积所有文件记录（原版备份 = KV dump，逐文件键 + 一份索引）
const IMPORT_PENDING_KEY = 'import@files@pending';

/**
 * 导入文件时同步重建索引：
 * 上游的「重建索引」要扫描整个 KV（EdgeOne KV 的 list 接口很慢，800+ 文件要跑很久），
 * 而导入本身已经把每条记录送过来了，直接据此增量重写索引，导入完成即可在管理页看到。
 */
async function syncIndexWithPending(db, env, records) {
  try {
    const prevStr = await db.get(IMPORT_PENDING_KEY);
    const map = new Map();
    if (prevStr) {
      try {
        for (const r of JSON.parse(prevStr)) {
          if (r && typeof r.id === 'string') map.set(r.id, r);
        }
      } catch (e) {
        console.warn('[import] pending index corrupt, rebuilding from this chunk only');
      }
    }
    for (const r of records) {
      map.set(r.id, { id: r.id, metadata: r.metadata });
    }
    const all = Array.from(map.values());
    await db.put(IMPORT_PENDING_KEY, JSON.stringify(all));
    const result = await saveIndex(db, all, env);
    return { totalCount: all.length, ok: !!result?.success };
  } catch (error) {
    console.warn('[import] sync index failed:', error?.message || error);
    return { totalCount: 0, ok: false };
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
      const indexSync = await syncIndexWithPending(db, env, recordsForIndex);
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
