/**
 * EdgeOne Makers KV 兼容层
 *
 * 把 EdgeOne KV 命名空间包装成 Cloudflare Workers KV 的接口形态，业务代码不需要改动：
 *   - put(key, value, { expirationTtl, metadata })
 *   - get(key, options) / getWithMetadata(key, options)
 *   - delete(key) / list({ prefix, limit, cursor })
 *
 * EdgeOne KV 与 Cloudflare KV 的差异（官方文档，2026-11）：
 *   1. key 只允许「字母、数字、下划线」，长度 ≤ 512B；业务代码里的 key 形如
 *      `manage@index@meta`、`a/b/c.jpg`、`expiry@...`，必须做可逆编码。
 *   2. 不支持 metadata，需要单独存一条 `_m_` 前缀的键。
 *   3. 不支持 expirationTtl，需要单独写一条 `_t_` 前缀的过期时间戳，读取时惰性判断。
 *   4. list 返回的是 { key } 而不是 { name }，字段叫 complete 而不是 list_complete，
 *      且单次 limit 上限 256（Cloudflare 是 1000），这里内部自动翻页补齐。
 */

const SAFE_CHAR = /^[A-Za-z0-9]$/;
const META_PREFIX = '_m_';
const TTL_PREFIX = '_t_';
const HASH_PREFIX = '_h_';
const MAX_KEY_BYTES = 500;

/**
 * 把任意字符串编码成只含 [A-Za-z0-9_] 的形式。
 * 规则：字母数字原样保留；下划线编码为 `_u`；其它字符编码为 `_<4位小写hex>x`。
 * 每个字符独立编码，因此「字符串前缀」在编码后仍然是前缀，list({prefix}) 依然可用。
 */
export function encodeKey(key) {
  const input = String(key ?? '');
  let out = '';
  for (const ch of input) {
    if (SAFE_CHAR.test(ch)) {
      out += ch;
    } else if (ch === '_') {
      out += '_u';
    } else {
      const code = ch.codePointAt(0);
      if (code <= 0xffff) {
        out += '_' + code.toString(16).padStart(4, '0') + 'x';
      } else {
        // 增补平面字符（emoji 等），按 8 位编码
        out += '_' + code.toString(16).padStart(8, '0') + 'y';
      }
    }
  }
  return out;
}

/** encodeKey 的逆运算 */
export function decodeKey(encoded) {
  const input = String(encoded ?? '');
  let out = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch !== '_') {
      out += ch;
      i += 1;
      continue;
    }
    const tag = input[i + 1];
    if (tag === 'u') {
      out += '_';
      i += 2;
      continue;
    }
    // 读连续的十六进制位，直到遇到 x / y 终止符
    let j = i + 1;
    while (j < input.length && /[0-9a-f]/.test(input[j])) j += 1;
    const hex = input.slice(i + 1, j);
    const term = input[j];
    if ((hex.length === 4 || hex.length === 8) && (term === 'x' || term === 'y')) {
      const code = parseInt(hex, 16);
      if (Number.isFinite(code)) {
        out += String.fromCodePoint(code);
        i = j + 1;
        continue;
      }
    }
    // 非法编码片段，原样保留
    out += ch;
    i += 1;
  }
  return out;
}

function hashKey(key) {
  // 极端长 key 的兜底：用 djb2 生成定长散列，只保证点查可用（前缀列举会失效）
  let hash = 5381;
  const input = String(key);
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return HASH_PREFIX + hash.toString(36);
}

function dataKey(key) {
  const encoded = encodeKey(key);
  if (encoded.length <= MAX_KEY_BYTES) return encoded;
  return hashKey(key);
}

function metaKey(key) {
  return META_PREFIX + dataKey(key);
}

function ttlKey(key) {
  return TTL_PREFIX + dataKey(key);
}

async function safeGet(raw, key, type) {
  try {
    // 注意：EdgeOne KV 的 get 带 {type:'text'} 选项时异常缓慢（实测单次 30s+），
    // 默认返回的就是字符串，所以 text 类型不传 options。
    const value = type && type !== 'text' ? await raw.get(key, { type }) : await raw.get(key);
    return value === undefined ? null : value;
  } catch (error) {
    console.warn(`[kv] get ${key} failed: ${error?.message || error}`);
    return null;
  }
}

async function safeDelete(raw, key) {
  try {
    await raw.delete(key);
  } catch (error) {
    // 删除不存在或已失效的键，忽略
    const message = error?.message || String(error);
    if (!/not.?found|不存在|404/i.test(message)) {
      console.warn(`[kv] delete ${key} failed: ${message}`);
    }
  }
}

/**
 * EdgeOne KV 命名空间适配器
 */
export class EdgeKVNamespace {
  constructor(raw) {
    if (!raw || typeof raw.get !== 'function' || typeof raw.put !== 'function') {
      throw new TypeError('Invalid EdgeOne KV namespace');
    }
    this.raw = raw;
  }

  async _readMeta(key) {
    const text = await safeGet(this.raw, metaKey(key), 'text');
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async _isExpired(key) {
    const raw = await safeGet(this.raw, ttlKey(key), 'text');
    if (raw == null) return false;
    const expiresAt = Number(raw);
    if (!Number.isFinite(expiresAt)) return false;
    return Date.now() > expiresAt;
  }

  async _clearExpired(key) {
    await Promise.all([
      safeDelete(this.raw, dataKey(key)),
      safeDelete(this.raw, ttlKey(key)),
    ]);
  }

  async put(key, value, options = {}) {
    const writes = [this.raw.put(dataKey(key), value)];

    if (options && options.metadata !== undefined) {
      writes.push(this.raw.put(metaKey(key), JSON.stringify(options.metadata ?? null)));
    }
    if (options && Number.isFinite(Number(options.expirationTtl)) && Number(options.expirationTtl) > 0) {
      const expiresAt = Date.now() + Number(options.expirationTtl) * 1000;
      writes.push(this.raw.put(ttlKey(key), String(expiresAt)));
    }
    await Promise.all(writes);
  }

  async get(key, options = {}) {
    if (await this._isExpired(key)) {
      await this._clearExpired(key);
      return null;
    }
    const type = options && options.type ? options.type : null;
    const value = await safeGet(this.raw, dataKey(key), type);
    return value === undefined ? null : value;
  }

  async getWithMetadata(key, options = {}) {
    if (await this._isExpired(key)) {
      await this._clearExpired(key);
      return { value: null, metadata: null };
    }
    const type = options && options.type ? options.type : null;
    const [value, metadata] = await Promise.all([
      safeGet(this.raw, dataKey(key), type),
      this._readMeta(key),
    ]);
    if (value === null) {
      return { value: null, metadata: null };
    }
    return { value, metadata };
  }

  async delete(key) {
    await Promise.all([
      safeDelete(this.raw, dataKey(key)),
      safeDelete(this.raw, metaKey(key)),
      safeDelete(this.raw, ttlKey(key)),
    ]);
  }

  /**
   * Cloudflare 形态的 list，内部按 EdgeOne 单次 ≤256 的限制翻页补齐到 limit
   * @param {{prefix?:string, limit?:number, cursor?:string}} options
   */
  async list(options = {}) {
    const prefix = options.prefix || '';
    const limit = Math.max(1, Math.min(Number(options.limit) || 1000, 5000));
    const encodedPrefix = encodeKey(prefix);
    const names = [];
    let cursor = options.cursor || undefined;
    let complete = true;
    let lastCursor;

    while (names.length < limit) {
      const pageSize = Math.min(256, limit - names.length);
      const page = await this.raw.list({
        prefix: encodedPrefix,
        limit: pageSize,
        ...(cursor ? { cursor } : {}),
      });
      const rawKeys = page?.keys || [];
      for (const item of rawKeys) {
        const name = item?.key ?? item?.name;
        if (name == null) continue;
        // 元数据键、过期戳键不暴露给业务层
        if (
          typeof name === 'string' &&
          (name.startsWith(META_PREFIX) || name.startsWith(TTL_PREFIX))
        ) {
          continue;
        }
        names.push(name);
      }
      complete = page?.complete !== false;
      lastCursor = page?.cursor || undefined;
      if (complete || rawKeys.length === 0) break;
      cursor = lastCursor;
      if (!cursor) break;
    }

    // Cloudflare KV 的 list 会带回每个 key 的 metadata（业务层「重建索引」「导出数据」依赖它），
    // EdgeOne KV 的 list 只有 key，所以这里按 _m_ 前缀并发补读一次 metadata。
    const keys = await Promise.all(
      names.map(async (name) => {
        const metaText = await safeGet(this.raw, META_PREFIX + name, 'text');
        let metadata = null;
        if (metaText) {
          try {
            metadata = JSON.parse(metaText);
          } catch {
            metadata = null;
          }
        }
        return { name: decodeKey(name), metadata };
      })
    );

    return {
      keys,
      list_complete: complete,
      cursor: complete ? undefined : (lastCursor || cursor),
    };
  }
}

/** 尽可能从 env 或全局变量里拿到 KV 绑定 */
export function resolveKVNamespace(env, bindingName) {
  const fromEnv = env ? env[bindingName] : undefined;
  const fromGlobal = typeof globalThis !== 'undefined' ? globalThis[bindingName] : undefined;
  const raw = fromEnv && typeof fromEnv.get === 'function' ? fromEnv : fromGlobal;
  if (!raw) return null;
  if (raw instanceof EdgeKVNamespace) return raw;
  return new EdgeKVNamespace(raw);
}
