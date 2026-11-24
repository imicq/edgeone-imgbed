# CloudFlare ImgBed · EdgeOne Makers 版

把 [CloudFlare-ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed) 移植到 **腾讯云 EdgeOne Makers**（原 EdgeOne Pages）部署：
**边缘函数 + EdgeOne KV + S3 兼容对象存储**，不使用 Cloudflare 的 KV/D1/R2 绑定。

## 一、和上游的差异

| 项 | 上游（Cloudflare） | 本仓库（EdgeOne Makers） |
|---|---|---|
| 业务代码位置 | `functions/` | **`core/`**（避免被 Makers 当成 Pages Functions 自动挂成路由） |
| 函数入口 | Pages Functions 目录路由 + `_middleware.js` | **`edge-functions/` 下的 8 个入口**，内部复用 `deploy/edgeone/index.js` 的路由表与中间件链 |
| 元数据存储 | KV / D1 | **EdgeOne KV 命名空间**（`img_url` 绑定） |
| 对象存储 | R2 绑定 / S3 / Telegram… | **S3 兼容渠道**（COS / R2 / MinIO…），不再有 R2 绑定 |
| 定时任务 | Cron Trigger | 手动/外部定时请求 `/cron/expiry-cleanup` |
| 前端分片 | 16MB 分片、20MB 以下整包 | **900KB 分片、>900KB 全部走分片**（EdgeOne 请求体上限 1MB） |

新增文件：

```
core/                         # 原 functions/ 业务代码（相对导入不变）
deploy/edgeone/index.js       # EdgeOne 入口：路由表 + 中间件链（派生自 deploy/worker/index.js）
deploy/edgeone/env.js         # env / caches / request.cf / 客户端 IP 适配
deploy/edgeone/kv.js          # EdgeOne KV → Cloudflare KV 语义兼容层
deploy/edgeone/local-smoke.mjs# 本地冒烟测试（内存 KV，不需要登录云平台）
edge-functions/               # Makers 函数入口（api / upload / file / dav / random）
scripts/patch-frontend-edgeone.mjs # 前端分片参数补丁（幂等）
edgeone.json                  # 构建/输出目录配置
```

### KV 兼容层做了什么

EdgeOne KV 和 Cloudflare KV 有三处硬差异，`kv.js` 全部抹平：

1. **key 只允许字母、数字、下划线** → 业务 key（`manage@index@meta`、`a/b/c.jpg`、`expiry@…`）按字符逐个编码，编码后仍是前缀封闭的，`list({prefix})` 语义不变。
2. **没有 metadata** → 单独写 `_m_<key>` 存 JSON，`getWithMetadata` 读两条再合并。
3. **没有 expirationTtl** → 单独写 `_t_<key>` 存过期时间戳，读取时惰性清理；`list` 单页上限 256（CF 是 1000），内部自动翻页补齐到请求的 limit。

### S3 分片上传的额外处理

EdgeOne 边缘函数请求体只有 1MB，而 S3 multipart 每个 part 至少 5MB。所以开启 `S3_SINGLE_PUT_MERGE=true` 后：

- 分块先写入 KV（`chunk_<uploadId>_<index>`，带 1 小时 TTL）
- 合并接口把分块读出来拼成完整文件，**一次 `PutObject` 写进 S3**
- 上传完成后清理 KV 里的临时分块

> 单文件上限受「合并时的内存 + KV 单值 25MB」约束，建议控制在 25MB 内。

## 二、部署步骤（EdgeOne Makers 控制台）

1. **Fork / 导入仓库**：Makers 控制台 → 新建项目 → 连接 Git（GitHub / Gitee）→ 选本仓库，生产分支 `main`。
2. **构建配置**已经写在 `edgeone.json`：
   - `installCommand`: `npm install --workspaces=false --omit=dev`（只装 `@aws-sdk/client-s3`，不装 Docker 用的 native 依赖）
   - `outputDirectory`: `./frontend-dist`
   - `nodeVersion`: 22.11.0
3. **开通 KV**：控制台 → KV 存储 → 一键开通（现已无需审核）→ 新建命名空间 → 在项目里绑定，**变量名必须是 `img_url`**。
4. **环境变量**（项目设置 → 环境变量）：

   | 变量 | 必填 | 说明 |
   |---|---|---|
   | `S3_SINGLE_PUT_MERGE` | 是 | 固定 `true`，启用 1MB 分片 + 单次 PutObject 合并 |
   | `EXPIRY_CLEANUP_TOKEN` | 建议 | `/cron/expiry-cleanup` 的调用口令；不设则任何人可触发清理 |
   | `SERVER_RUNTIME` | 否 | 代码会自动置为 `pages`，不用手动设 |

5. **部署** → 打开默认域名 → 进入 `/admin` 用初始密码登录（与上游一致）。
6. **配置 S3 渠道**：后台 → 上传设置 → S3 渠道，填 endpoint / region / bucket / ak / sk（腾讯云 COS 用 S3 兼容 endpoint，例如 `https://<bucket>.cos.<region>.myqcloud.com`，`pathStyle` 视存储实现而定）。
7. **验证**：上传一张 >1MB 的图，确认走分片并在后台能看到记录；打开返回的 `/file/...` 链接能正常显示。

### 定时清理（可选）

EdgeOne 没有 Cron Trigger。可以用任意定时服务（腾讯云函数定时器、GitHub Actions、服务器 crontab）每天请求：

```bash
curl -H "x-cleanup-token: $EXPIRY_CLEANUP_TOKEN" https://<你的域名>/cron/expiry-cleanup
```

## 三、本地自测（不需要云账号）

```bash
npm install --workspaces=false --omit=dev
npx esbuild deploy/edgeone/local-smoke.mjs --bundle --platform=node --format=esm \
  --outfile=.tmp/smoke.mjs --external:@aws-sdk/client-s3
node .tmp/smoke.mjs
```

会验证：路由 → 中间件 → KV 兼容层 → key 编码/前缀列举。

## 四、已知限制

- **请求体 1MB**：所有超过 900KB 的文件都走分片；单文件建议 ≤25MB（受内存与 KV 单值上限约束）。
- **KV 最终一致（60s）**：刚上传的记录在其他边缘节点最长 60 秒后才可见，属平台特性。
- **函数资源**：CPU 200ms / 内存 128MB / 代码包 5MB；免费版每月 300 万次执行、300 万毫秒 CPU、KV 1GB。
- **默认域名**：Makers 默认域名带时效校验，长期使用请绑定自定义域名（加速区域含中国大陆时需 ICP 备案）。
- **WebDAV / Telegram / Discord / HF** 渠道代码保留，但能否连通取决于 EdgeOne 节点的出网情况。

## 五、升级上游

1. 拉取上游 `functions/` → 覆盖到本仓库 `core/`；
2. 重新生成 `deploy/worker/index.js`（`node deploy/worker/generate-routes.js`），再把导入路径 `../../functions/` 改成 `../../core/`，整份拷贝到 `deploy/edgeone/index.js`（保留 EdgeOne 入口与 `serverRuntime: 'pages'`）；
3. 前端升级后重新执行 `node scripts/patch-frontend-edgeone.mjs`（分片大小会被新 bundle 覆盖）。

## 六、许可

沿用上游 MIT License，原始版权与许可声明保留在 `LICENSE`。
