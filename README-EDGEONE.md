# EdgeOne ImgBed — 腾讯云 EdgeOne Makers 版部署说明

本仓库是 [CloudFlare-ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed) 的 EdgeOne（原 EdgeOne Pages，现 Makers）移植版。
**不依赖 Node / Cloud Functions 运行时**，只用：

- **Edge Functions**（`edge-functions/`，单一 catch-all 函数）承载全部动态逻辑
- **EdgeOne KV**（变量名 `img_url`）存放文件元数据与配置
- **S3 兼容对象存储渠道**（SigV4，纯 Web Crypto 实现）存放图片文件；不使用 R2 绑定

> 注意：本 fork 把上游的 `functions/` 目录改名为 `core/`，因此**不能**再直接部署回 Cloudflare Pages（CF 靠 `functions/` 目录自动挂路由）。需要 CF 版请用上游仓库。

## 目录结构

```
core/                    业务处理逻辑（原上游 functions/）
deploy/edgeone/
  index.js               60+ 路由表 + 中间件链 + handleRequest(eventContext) 入口
  env.js                 运行时适配：request.cf ← request.eo.geo，clientIp 兜底，env 代理
  kv.js                  EdgeOne KV → Cloudflare KV 语义兼容层（key 编码 / metadata / TTL / list 翻页）
  s3.js                  纯 Web Crypto 的 SigV4 S3 客户端（替代 @aws-sdk/client-s3，函数包体积从 45MB 降到 ~2.5MB）
  cache.js               缓存旁路（EdgeOne 侧不再使用 caches.default）
  local-smoke.mjs        本地冒烟测试（内存 KV + 假 S3）
edge-functions/
  [[default]].js         唯一函数入口（catch-all），转调 deploy/edgeone/index.js
frontend-dist/           构建产物（首次部署前由 npm run build 生成/打补丁）
scripts/patch-frontend-edgeone.mjs   前端补丁：分片/直传阈值压到 900KB（Edge Functions 请求体上限 1MB）
```

## 关键坑（改代码前必读）

1. **函数目录必须叫 `edge-functions/` 或 `cloud-functions`**，叫 `functions/` 不会被识别。
2. **只保留一个 catch-all 函数**。每个路由一个函数文件会让核心代码被打包 N 份（包体积超 5MB 上限后被平台静默丢弃）。
3. **业务 handler 不能叫 `onRequestGet` / `onRequestPost` 等 Pages 命名**。EdgeOne 运行时会扫描包内这些命名导出并按 HTTP 方法直接调用，绕过入口的统一路由，表现为「所有 GET 都返回同一个接口」。本仓库已统一改名为 `handle` / `handleGet` / `handlePost` / `handleOptions`。
4. 不要引入 `@aws-sdk/client-s3`、`@sentry/*` 等大依赖；S3 用 `deploy/edgeone/s3.js`。
5. Edge Functions 限制：代码包 5MB、请求体 1MB、CPU 200ms、内存 128MB。因此大文件必须走分片上传（前端阈值已补丁到 900KB），合并时用单次 PutObject（`S3_SINGLE_PUT_MERGE=true`）。

## 部署步骤

### 1. 准备构建产物

```bash
npm install --workspaces=false
npm run build        # 打前端补丁（分片 900KB），产物在 frontend-dist/
```

### 2. 创建 KV 命名空间并绑定

控制台 → EdgeOne Makers → 存储 → KV 新建命名空间（例如 `img_url`），
再到 **项目 → KV** 页面把它绑定为变量名 **`img_url`**（必须叫这个名字，业务侧按此读取）。

### 3. 设置环境变量（生产环境）

| 变量 | 说明 |
| --- | --- |
| `BASIC_USER` / `BASIC_PASS` | 后台登录账号密码（强烈建议设置） |
| `S3_SINGLE_PUT_MERGE` | 设为 `true`，分片合并改为单次 PutObject，避免超时 |
| `EXPIRY_CLEANUP_TOKEN` | 可选，定时清理过期文件的口令 |

```bash
edgeone makers env set BASIC_USER=admin -e production
edgeone makers env set BASIC_PASS=<你的密码> -e production
edgeone makers env set S3_SINGLE_PUT_MERGE=true -e production
```

### 4. 部署

```bash
npx edgeone login          # 首次
npx edgeone makers deploy . -n <项目名> --json
```

部署后控制台「函数」tab 应显示一条 `^/(.*)$` 路由、runtime `Edge`。
CLI 直传项目（direct upload）之后**不能**再切换成 Git 集成；要 Git 自动部署请在控制台用
`/edgeone/makers/new?repository-url=<仓库地址>` 新建项目。

### 5. 配置 S3 渠道（唯一需要手工填的凭据）

登录后台 → 上传设置 → S3 渠道填：

- Endpoint（如 `https://<account-id>.r2.cloudflarestorage.com` 或任意 S3 兼容服务）
- Region、Bucket、AccessKeyId、SecretAccessKey
- Path-Style：多数国内对象存储（腾讯云 COS / 七牛 / MinIO）需要开启
- 可选 CDN 域名（用于拼接访问 URL）

上传的文件走 SigV4 直传，不经 EdgeOne 中转存储。

### 6. 验证

```bash
# 预置域名带时效 token，需先拿 cookie
curl -c jar -L "https://<项目域名>?eo_token=..&eo_time=.." -o /dev/null
curl -b jar "https://<项目域名>/api/zzz"            # 期望 404
curl -b jar "https://<项目域名>/api/auth/sessionCheck"   # 期望 {"valid":false,...}
curl -b jar -X POST "https://<项目域名>/api/auth/adminLogin" \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"..."}'
```

## 已知限制 / 待办

- 预置域名 `*.edgeone.cool` 带时效 token，长期对外使用需绑定自定义域名（大陆加速需 ICP 备案）。
- `/api/manage/dedup/scan` 依赖 R2 绑定读取对象内容，EdgeOne 版返回 `supported` 但不做实际去重。
- 缓存清理（CF purge / caches.default）在 EdgeOne 下为空实现。
