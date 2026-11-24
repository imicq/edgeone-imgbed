/**
 * EdgeOne Makers 运行时适配
 *
 * 把 EdgeOne 的函数上下文包装成 Cloudflare Pages Functions 的 `context` 形态，
 * 让 functions/ 下的业务代码可以在 EdgeOne 上原样运行。
 */

import { resolveKVNamespace } from './kv.js';

const LEGACY_CACHE_STUB = {
  async match() {
    return undefined;
  },
  async put() {},
  async delete() {
    return false;
  },
};

/**
 * Cloudflare 提供全局 caches.default；EdgeOne 注入了标准 Cache API 的 caches，
 * 但没有 default 属性。这里补一个空实现（不做本地缓存，只保证调用不报错）。
 */
export function ensureCachesShim() {
  if (typeof globalThis.caches === 'undefined') {
    globalThis.caches = { default: { ...LEGACY_CACHE_STUB } };
    return;
  }
  if (!globalThis.caches.default) {
    try {
      globalThis.caches.default = { ...LEGACY_CACHE_STUB };
    } catch (error) {
      console.warn('[edgeone] failed to shim caches.default:', error?.message || error);
    }
  }
}

const GEO_FALLBACK = {
  country: 'XX',
  city: 'Unknown',
  continent: 'XX',
  latitude: '0',
  longitude: '0',
  region: '',
  regionCode: '',
  timezone: '',
  postalCode: '',
  asn: 0,
  asOrganization: '',
  colo: 'EO',
  httpProtocol: 'HTTP/1.1',
  requestPriority: '',
  tlsCipher: '',
  tlsVersion: '',
};

function mapEdgeOneGeo(request) {
  const geo = request?.eo?.geo;
  if (!geo) return GEO_FALLBACK;
  return {
    ...GEO_FALLBACK,
    country: geo.countryName || geo.country || 'XX',
    city: geo.cityName || geo.city || 'Unknown',
    region: geo.regionName || geo.region || '',
    latitude: String(geo.latitude ?? '0'),
    longitude: String(geo.longitude ?? '0'),
    continent: geo.continent || 'XX',
    asn: Number(geo.asn || 0),
    asOrganization: geo.asOrganization || '',
  };
}

/**
 * 补齐 Cloudflare 的 request.cf；同时把客户端 IP 落到业务代码读取的头部上。
 * 业务侧通过 cf-connecting-ip / x-real-ip / x-forwarded-for 取上传 IP。
 */
export function normalizeRequest(request) {
  if (!request.cf) {
    try {
      request.cf = mapEdgeOneGeo(request);
    } catch {
      // Request 对象不可扩展时忽略，业务侧有兜底
    }
  }

  const hasClientIp =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip');
  if (hasClientIp) return request;

  // 注意：EdgeOne 的 Request 实现里 `new Request(request, { headers })` 会丢失原始 URL，
  // 直接复用它会让后续基于 url.pathname 的路由分发全部失效，所以这里不再重建 Request。
  // 客户端 IP 由业务侧通过 request.eo.clientIp / x-forwarded-for 兜底获取。
  return request;
}

/**
 * 构造业务代码使用的 env
 * - EdgeOne 的 KV 绑定以「变量名即全局变量」的方式注入，这里同时兼容 env[name] 与 globalThis[name]
 * - 统一把 KV 包装成 Cloudflare KV 接口
 * - 移除只有 Cloudflare 才有的绑定（img_r2 / img_d1 / ASSETS），避免业务误判运行环境
 */
export function createEdgeEnv(context) {
  ensureCachesShim();

  const base = context?.env || {};
  const env = Object.assign(Object.create(null), base);

  const kv = resolveKVNamespace(base, 'img_url');
  if (kv) {
    env.img_url = kv;
  }

  delete env.img_r2;
  delete env.img_d1;
  delete env.ASSETS;

  if (!env.SERVER_RUNTIME) env.SERVER_RUNTIME = 'pages';

  return new Proxy(env, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);
      if (prop in target) return target[prop];
      const globalValue = globalThis[prop];
      if (globalValue !== undefined && prop !== 'img_url') return globalValue;
      return undefined;
    },
    has(target, prop) {
      if (typeof prop === 'string' && prop in target) return true;
      return typeof prop === 'string' ? globalThis[prop] !== undefined : Reflect.has(target, prop);
    },
  });
}

/** 把 EdgeOne 的 EventContext 转成 Cloudflare Pages Functions 的 context */
export function toPagesContext(context) {
  const request = normalizeRequest(context.request);
  const env = createEdgeEnv(context);

  const clientIp = resolveClientIp(context, request);
  if (clientIp) {
    try {
      Object.defineProperty(request, 'clientIp', { value: clientIp, configurable: true });
    } catch {
      // Request 不可扩展时忽略
    }
  }

  return {
    request,
    env,
    params: context.params || {},
    data: { serverRuntime: 'pages' },
    clientIp,
    waitUntil: (promise) => {
      if (typeof context.waitUntil === 'function') {
        context.waitUntil(promise);
      } else if (promise && typeof promise.catch === 'function') {
        promise.catch((error) => console.error('[edgeone] waitUntil error:', error));
      }
    },
    passThroughOnException: () => {},
    next: null,
  };
}

/**
 * 解析客户端 IP。EdgeOne 不注入 cf-connecting-ip，依次尝试：
 * 上下文客户端 IP / request.eo.clientIp / eo 系列请求头 / 常见转发头。
 */
export function resolveClientIp(context, request) {
  const direct = context?.clientIp || request?.eo?.clientIp;
  if (direct) return String(direct);

  for (const name of [
    'eo-client-ip',
    'eo-connecting-ip',
    'cf-connecting-ip',
    'x-real-ip',
    'x-forwarded-for',
    'x-client-ip',
  ]) {
    const value = request?.headers?.get?.(name);
    if (value) return value.split(',')[0].trim();
  }

  return '';
}
