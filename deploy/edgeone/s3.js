/**
 * EdgeOne 版 S3 兼容层
 *
 * 与 @aws-sdk/client-s3 的 API 形状保持一致（S3Client + *Command），
 * 但实现只依赖 Web Crypto + fetch，可直接运行在 EdgeOne Edge Functions（V8，无 Node 内置模块）。
 * 体积只有几 KB，避免 AWS SDK 导致的函数包超出 EdgeOne 的 5MB 限制。
 *
 * 支持的命令：PutObject / GetObject / DeleteObject / CopyObject /
 *            CreateMultipartUpload / UploadPart / CompleteMultipartUpload / AbortMultipartUpload
 */

const TEXT_ENCODER = new TextEncoder();

function toHex(buffer) {
    const bytes = new Uint8Array(buffer);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
}

async function sha256Hex(data) {
    const digest = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? TEXT_ENCODER.encode(data) : data);
    return toHex(digest);
}

async function hmacSha256(key, data) {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        typeof key === 'string' ? TEXT_ENCODER.encode(key) : key,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, TEXT_ENCODER.encode(data)));
}

function rfc3986Encode(value) {
    return encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function encodeKeyPath(key) {
    return String(key)
        .split('/')
        .map(segment => rfc3986Encode(segment))
        .join('/');
}

function canonicalQuery(params) {
    const entries = [];
    for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined || value === null) continue;
        entries.push([rfc3986Encode(key), rfc3986Encode(String(value))]);
    }
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
    return entries.map(([k, v]) => `${k}=${v}`).join('&');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class Command {
    constructor(input) {
        this.input = input || {};
    }
}

export class PutObjectCommand extends Command {}
export class GetObjectCommand extends Command {}
export class DeleteObjectCommand extends Command {}
export class CopyObjectCommand extends Command {}
export class HeadObjectCommand extends Command {}
export class CreateMultipartUploadCommand extends Command {}
export class UploadPartCommand extends Command {}
export class CompleteMultipartUploadCommand extends Command {}
export class AbortMultipartUploadCommand extends Command {}

function parseXmlTag(xml, tag) {
    const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml || '');
    return match ? match[1] : undefined;
}

export class S3Client {
    constructor(config = {}) {
        if (!config.endpoint) throw new Error('S3Client requires an endpoint');
        this.endpoint = String(config.endpoint).replace(/\/+$/, '');
        this.region = config.region || 'auto';
        this.credentials = config.credentials || {};
        this.forcePathStyle = !!config.forcePathStyle;
        this.userAgent = null;
        // 只为兼容上游代码里的 middlewareStack.addRelativeTo(..., {toMiddleware:'getUserAgentMiddleware'})
        this.middlewareHooks = [];
        this.middlewareStack = {
            addRelativeTo: (middleware) => {
                this.middlewareHooks.push(middleware);
            },
            add: () => {},
            use: () => {},
            remove: () => {},
            removeByTag: () => {}
        };
    }

    async send(command) {
        const input = command.input || {};
        const method = this.resolveMethod(command);
        const { url, query } = this.resolveUrl(command, input);

        const headers = {};
        if (input.ContentType) headers['content-type'] = input.ContentType;
        if (input.CacheControl) headers['cache-control'] = input.CacheControl;
        if (input.ContentDisposition) headers['content-disposition'] = input.ContentDisposition;
        if (input.ContentEncoding) headers['content-encoding'] = input.ContentEncoding;
        if (input.Metadata && typeof input.Metadata === 'object') {
            for (const [k, v] of Object.entries(input.Metadata)) {
                headers[`x-amz-meta-${String(k).toLowerCase()}`] = String(v);
            }
        }
        if (input.Range) headers['range'] = input.Range;
        if (input.CopySource || input.CopySourceBucket) {
            const source = input.CopySource
                ? String(input.CopySource)
                : `/${input.CopySourceBucket || input.Bucket}/${encodeKeyPath(input.CopySourceKey || '')}`;
            headers['x-amz-copy-source'] = source.startsWith('/') ? source : `/${source}`;
        }

        // 兼容上游自定义 User-Agent 中间件
        if (this.middlewareHooks.length) {
            let args = { request: { headers: {} } };
            for (const middleware of this.middlewareHooks) {
                try {
                    const next = async () => args;
                    const handler = middleware(next);
                    const result = await handler(args);
                    if (result) args = result;
                } catch (error) {
                    // 忽略 UA 中间件失败，不影响实际请求
                }
            }
            const ua = args.request.headers['user-agent'] || args.request.headers['User-Agent'];
            if (ua) headers['user-agent'] = ua;
        }

        const body = this.resolveBody(command, input);
        const response = await this.execute({ method, url, query, headers, body });
        return this.resolveResult(command, response);
    }

    resolveMethod(command) {
        if (command instanceof PutObjectCommand) return 'PUT';
        if (command instanceof GetObjectCommand || command instanceof HeadObjectCommand) return 'GET';
        if (command instanceof DeleteObjectCommand) return 'DELETE';
        if (command instanceof CopyObjectCommand) return 'PUT';
        if (command instanceof CreateMultipartUploadCommand) return 'POST';
        if (command instanceof UploadPartCommand) return 'PUT';
        if (command instanceof CompleteMultipartUploadCommand) return 'POST';
        if (command instanceof AbortMultipartUploadCommand) return 'DELETE';
        return 'GET';
    }

    resolveUrl(command, input) {
        if (!input.Bucket) throw new Error('S3 command requires a Bucket');
        const endpointUrl = new URL(this.endpoint);
        const bucket = input.Bucket;
        const keyPath = input.Key ? encodeKeyPath(input.Key) : '';
        const query = {};
        let pathname;

        if (this.forcePathStyle) {
            const basePath = endpointUrl.pathname.replace(/\/+$/, '');
            pathname = `${basePath}/${bucket}${keyPath ? '/' + keyPath : ''}`;
        } else {
            const basePath = endpointUrl.pathname.replace(/\/+$/, '');
            pathname = `${basePath}/${keyPath}`;
        }

        const url = new URL(endpointUrl.origin);
        if (this.forcePathStyle) {
            url.pathname = pathname || '/';
        } else {
            url.hostname = `${bucket}.${endpointUrl.hostname}`;
            url.pathname = pathname || '/';
        }

        if (command instanceof CreateMultipartUploadCommand) query.uploads = '';
        if (command instanceof UploadPartCommand) {
            query.partNumber = input.PartNumber;
            query.uploadId = input.UploadId;
        }
        if (command instanceof CompleteMultipartUploadCommand) query.uploadId = input.UploadId;
        if (command instanceof AbortMultipartUploadCommand) query.uploadId = input.UploadId;

        return { url, query };
    }

    resolveBody(command, input) {
        if (command instanceof CompleteMultipartUploadCommand) {
            const parts = (input.MultipartUpload && input.MultipartUpload.Parts) || [];
            const xmlParts = parts
                .map(p => `<Part><PartNumber>${p.PartNumber}</PartNumber><ETag>${p.ETag}</ETag></Part>`)
                .join('');
            return TEXT_ENCODER.encode(`<CompleteMultipartUpload>${xmlParts}</CompleteMultipartUpload>`);
        }
        if (command instanceof CopyObjectCommand) return undefined;
        const body = input.Body;
        if (body == null) return undefined;
        if (typeof body === 'string') return TEXT_ENCODER.encode(body);
        if (body instanceof Uint8Array || body instanceof ArrayBuffer || typeof body === 'object') return body;
        return body;
    }

    async execute({ method, url, query, headers, body }) {
        const queryString = canonicalQuery(query);
        if (queryString) url.search = '?' + queryString;

        const host = url.host;
        const now = new Date();
        const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
        const dateStamp = amzDate.slice(0, 8);

        const signHeaders = Object.assign({}, headers, {
            host,
            'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
            'x-amz-date': amzDate
        });

        const sortedKeys = Object.keys(signHeaders).map(k => k.toLowerCase()).sort();
        const canonicalHeaders = sortedKeys
            .map(k => {
                const value = signHeaders[k] !== undefined ? signHeaders[k] : signHeaders[Object.keys(signHeaders).find(o => o.toLowerCase() === k)];
                return `${k}:${String(value).trim().replace(/\s+/g, ' ')}\n`;
            })
            .join('');
        const signedHeaders = sortedKeys.join(';');

        const canonicalUri = url.pathname || '/';

        const canonicalRequest = [
            method,
            canonicalUri,
            queryString,
            canonicalHeaders,
            signedHeaders,
            'UNSIGNED-PAYLOAD'
        ].join('\n');

        const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
        const stringToSign = [
            'AWS4-HMAC-SHA256',
            amzDate,
            credentialScope,
            await sha256Hex(canonicalRequest)
        ].join('\n');

        const signingKey = await this.deriveSigningKey(dateStamp);
        const signature = toHex(await hmacSha256(signingKey, stringToSign));

        signHeaders.authorization = `AWS4-HMAC-SHA256 Credential=${this.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

        const requestInit = { method, headers: signHeaders };
        if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
            requestInit.body = body;
            // Node 环境下流式 body 需要 duplex，EdgeOne（V8）会忽略该字段
            requestInit.duplex = 'half';
        }

        let response;
        let lastError;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                response = await fetch(url.toString(), requestInit);
                if (response.ok || response.status === 404 || response.status === 304 || response.status === 206) break;
                if (response.status === 403 || response.status === 409 || response.status === 400) break;
                lastError = new Error(`S3 request failed: ${response.status} ${response.statusText}`);
                if (response.status < 500) break;
            } catch (error) {
                lastError = error;
            }
            await sleep(200 * (attempt + 1));
        }

        if (!response) throw lastError || new Error('S3 request failed');
        if (!response.ok && response.status !== 206 && response.status !== 404) {
            let detail = '';
            try {
                detail = (await response.text()).slice(0, 300);
            } catch (error) {
                detail = '';
            }
            const error = new Error(`S3 request failed: ${response.status} ${response.statusText}${detail ? ' - ' + detail : ''}`);
            error.statusCode = response.status;
            error.$metadata = { httpStatusCode: response.status };
            throw error;
        }
        return response;
    }

    async deriveSigningKey(dateStamp) {
        const kDate = await hmacSha256(`AWS4${this.credentials.secretAccessKey}`, dateStamp);
        const kRegion = await hmacSha256(kDate, this.region);
        const kService = await hmacSha256(kRegion, 's3');
        return hmacSha256(kService, 'aws4_request');
    }

    async resolveResult(command, response) {
        if (command instanceof PutObjectCommand || command instanceof DeleteObjectCommand || command instanceof CopyObjectCommand) {
            const etag = response.headers.get('etag');
            if (command instanceof CopyObjectCommand) {
                const xml = await response.text();
                return {
                    CopyObjectResult: { ETag: parseXmlTag(xml, 'ETag') || etag },
                    $metadata: { httpStatusCode: response.status }
                };
            }
            return { ETag: etag, $metadata: { httpStatusCode: response.status } };
        }

        if (command instanceof GetObjectCommand || command instanceof HeadObjectCommand) {
            return {
                Body: response.body,
                ContentType: response.headers.get('content-type'),
                ContentLength: response.headers.get('content-length') || undefined,
                ContentRange: response.headers.get('content-range') || undefined,
                ETag: response.headers.get('etag') || undefined,
                LastModified: response.headers.get('last-modified') || undefined,
                $metadata: { httpStatusCode: response.status }
            };
        }

        const xml = await response.text();
        if (command instanceof CreateMultipartUploadCommand) {
            return { UploadId: parseXmlTag(xml, 'UploadId'), $metadata: { httpStatusCode: response.status } };
        }
        if (command instanceof UploadPartCommand) {
            return { ETag: response.headers.get('etag'), $metadata: { httpStatusCode: response.status } };
        }
        if (command instanceof CompleteMultipartUploadCommand) {
            return { Location: parseXmlTag(xml, 'Location'), ETag: parseXmlTag(xml, 'ETag'), $metadata: { httpStatusCode: response.status } };
        }
        return { $metadata: { httpStatusCode: response.status } };
    }
}
