'use strict';

/**
 * HTTP 接入层（MAF 规范第 2 章）：Streamable HTTP / JSON-RPC 2.0。
 *
 * - POST /mcp     唯一调用入口：MCP-HMAC 验签 → 解析 JSON-RPC → 注入店铺凭证上下文 → 交给 MCP Server
 * - GET  /healthz 轻量探活：免鉴权、无副作用、<50ms
 * - GET  /mcp     405（本实现不提供 SSE 推送流）
 *
 * 无状态：每个请求新建一个 Server + StreamableHTTPServerTransport 实例，
 * sessionIdGenerator 传 undefined（MCP 规范允许的无状态模式），响应完成后立即释放。
 */
import http from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { AUTH, HTTP, LEDGER, LIMITS } from '../config.js';
import {
  ContractError,
  ERROR_CODES,
  authFailed,
  errorMeta,
  invalidParams,
  isContractError,
  normalizeUpstreamError,
} from '../core/errors.js';
import { SERVER_INFO } from '../core/envelope.js';
import { createMcpServer, resolveTraceId, TRACE_HEADER } from '../mcp/server.js';
import { decodeShopCredential } from '../security/credentials.js';
import { createAuth } from './auth.js';

export const MCP_PATH = '/mcp';
export const HEALTH_PATH = '/healthz';
export const PROTOCOL_HEADER = 'mcp-protocol-version';
export const SHOP_CREDENTIAL_HEADER = 'x-shop-credential';
export const INCLUDE_GENERIC_HEADER = 'x-mcp-include-generic';

const SUPPORTED_VERSIONS = new Set([HTTP.protocolVersion, ...HTTP.legacyProtocolVersions]);

/** 读取请求体并限制大小，返回 Buffer；超限抛 40001（httpStatus 413） */
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        done(reject, new ContractError(ERROR_CODES.INVALID_PARAMS, `请求体超过上限 ${maxBytes} 字节`, { httpStatus: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done(resolve, Buffer.concat(chunks)));
    req.on('error', (e) => done(reject, e));
  });
}

/** JSON-RPC 层错误响应（鉴权/协议层，不进入工具信封） */
function sendJsonRpcError(res, httpStatus, code, message, { id = null, traceId = null, data } = {}) {
  if (res.headersSent) return;
  const body = { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
  const text = JSON.stringify(body);
  res.writeHead(httpStatus, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...(traceId ? { [TRACE_HEADER]: traceId } : {}),
  });
  res.end(text);
}

function headerValue(headers, name) {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function getPathname(req) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}

/**
 * @param {object} o
 * @param {object} [o.adapters] 已创建的适配器（缺省由调用方在 index.js 注入）
 * @param {object} o.ledger 幂等账本（openLedger 返回值）
 * @param {object} o.credentials 凭证注册表（createCredentialRegistry 返回值）
 * @param {object} [o.auth] 覆盖内部创建的 HMAC 校验器（测试注入）
 * @param {object} [o.logger] console 兼容日志器
 */
export function createHttpServer({ adapters, ledger, credentials, auth, logger = console } = {}) {
  if (!ledger) throw new TypeError('createHttpServer 需要 ledger');
  if (!credentials) throw new TypeError('createHttpServer 需要 credentials');
  if (!adapters) throw new TypeError('createHttpServer 需要 adapters');

  const startedAt = Date.now();
  const verifier =
    auth ||
    createAuth({
      keys: AUTH.keys,
      toleranceSec: AUTH.toleranceSec,
      nonceTtlSec: AUTH.nonceTtlSec,
      loopbackBypass: AUTH.loopbackBypass,
    });

  /** 进程级运行态：并发计数 + 健康快照所需数据（callTool 会读写 active） */
  const state = { active: 0 };
  const stats = {
    get active() {
      return state.active;
    },
    set active(v) {
      state.active = Math.max(0, Number(v) || 0);
    },
    startedAt,
    maxConcurrency: LIMITS.maxConcurrency,
    toolTimeoutMs: LIMITS.toolTimeoutMs,
    retentionDays: LEDGER.retentionDays,
    adapterMode: adapters.mode || 'unknown',
    get uptimeMs() {
      return Date.now() - startedAt;
    },
    get ledgerCount() {
      try {
        return ledger.count();
      } catch {
        return 0;
      }
    },
    get credentialCount() {
      return credentials.size();
    },
  };

  /** healthz 结果缓存 500ms：高频探活不反复扫账本表 */
  let healthCache = null;

  function healthPayload() {
    const now = Date.now();
    if (healthCache && now - healthCache.at < 500) return healthCache.payload;
    let entries = 0;
    try {
      entries = ledger.count();
    } catch {
      entries = -1;
    }
    const authKeyIds = Object.keys(AUTH.keys);
    const payload = {
      status: 'ok',
      server: SERVER_INFO,
      protocolVersion: HTTP.protocolVersion,
      legacyProtocolVersions: [...HTTP.legacyProtocolVersions],
      uptimeMs: now - startedAt,
      startedAt: new Date(startedAt).toISOString(),
      mode: stats.adapterMode,
      // 鉴权口径（只暴露 keyId，不暴露 secret）：便于平台侧核对握手配置
      auth: {
        mode: authKeyIds.length ? 'hmac' : 'open',
        modes: authKeyIds.length ? ['mcp-hmac', 'bearer'] : ['none'],
        keyIds: authKeyIds,
        loopbackBypass: AUTH.loopbackBypass ? 'on' : 'off',
      },
      ledger: { entries, retentionDays: LEDGER.retentionDays },
      credentials: { shops: credentials.size() },
      concurrency: { active: state.active, max: LIMITS.maxConcurrency },
      timestamp: new Date(now).toISOString(),
    };
    healthCache = { at: now, payload };
    return payload;
  }

  async function handleHealth(req, res, traceId) {
    const body = JSON.stringify(healthPayload());
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      [TRACE_HEADER]: traceId,
    });
    res.end(body);
    void req;
  }

  async function handleMcpPost(req, res, traceId) {
    const t0 = process.hrtime.bigint();

    // 1) 读原始 body（签名必须基于原始字节，不能先解析再序列化）
    let rawBody;
    try {
      rawBody = await readRawBody(req, HTTP.maxBodyBytes);
    } catch (e) {
      const ce = normalizeUpstreamError(e);
      const status = ce.httpStatus || 400;
      sendJsonRpcError(res, status, ce.code, ce.message, { traceId });
      return;
    }

    // 2) 鉴权（三档短路：回环豁免 → Bearer 静态令牌 → MCP-HMAC 验签）
    const verified = verifier.verify({
      method: 'POST',
      path: MCP_PATH,
      headers: req.headers,
      rawBody,
      remoteAddress: req.socket?.remoteAddress,
    });
    if (!verified.ok) {
      sendJsonRpcError(res, 401, verified.code, verified.message, { traceId });
      logger.warn?.(`[mcp-1688] 鉴权失败 code=${verified.code} trace=${traceId}`);
      return;
    }

    // 3) 协议版本：强制 2025-06-18，兼容 2025-03-26
    const requested = headerValue(req.headers, PROTOCOL_HEADER);
    if (requested && !SUPPORTED_VERSIONS.has(String(requested).trim())) {
      sendJsonRpcError(res, 400, ERROR_CODES.INVALID_PARAMS, `不支持的 MCP 协议版本：${requested}`, {
        traceId,
        data: { supported: [...SUPPORTED_VERSIONS] },
      });
      return;
    }

    // 4) 解析 JSON-RPC 请求体
    let parsedBody;
    try {
      const text = rawBody.toString('utf8').trim();
      parsedBody = text === '' ? undefined : JSON.parse(text);
    } catch {
      sendJsonRpcError(res, 400, ERROR_CODES.INVALID_PARAMS, '请求体不是合法 JSON', { traceId });
      return;
    }
    if (parsedBody === undefined) {
      sendJsonRpcError(res, 400, ERROR_CODES.INVALID_PARAMS, '请求体为空', { traceId });
      return;
    }

    // 5) 店铺凭证：只从 HTTP 头读取，解码进内存分桶缓存（TTL 300s）
    let shopKey = null;
    const credentialHeader = headerValue(req.headers, SHOP_CREDENTIAL_HEADER);
    if (credentialHeader) {
      try {
        const cred = decodeShopCredential(credentialHeader);
        credentials.put(cred);
        shopKey = cred.shopKey;
      } catch (e) {
        const ce = normalizeUpstreamError(e);
        sendJsonRpcError(res, 401, ce.code, ce.message, { traceId });
        return;
      }
    }

    const includeGeneric = ['1', 'true', 'yes'].includes(
      String(headerValue(req.headers, INCLUDE_GENERIC_HEADER) || '').trim().toLowerCase(),
    );

    const ctx = {
      traceId,
      shopKey,
      includeGeneric,
      adapters,
      ledger,
      credentials,
      stats,
      protocolVersion: requested ? String(requested).trim() : HTTP.protocolVersion,
      legacyProtocolVersions: [...HTTP.legacyProtocolVersions],
      log: logger,
    };

    // 6) 无状态：每个请求一对 Server/Transport
    const server = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (e) {
      const ce = normalizeUpstreamError(e);
      logger.error?.(`[mcp-1688] MCP 请求处理异常 code=${ce.code} trace=${traceId}：${ce.message}`);
      sendJsonRpcError(res, 500, ce.code, ce.message, { traceId });
    } finally {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const method = Array.isArray(parsedBody) ? 'batch' : parsedBody?.method;
      const toolName = method === 'tools/call' ? parsedBody?.params?.name : '';
      logger.info?.(
        `[mcp-1688] POST /mcp 200 ${ms.toFixed(1)}ms method=${method || '-'}${toolName ? ` tool=${toolName}` : ''} ${
          shopKey ? `shop=${shopKey} ` : ''
        }trace=${traceId}`,
      );
      try {
        await transport.close();
      } catch {
        // 关闭失败不影响已写出的响应
      }
      try {
        await server.close();
      } catch {
        // 同上
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    const traceId = resolveTraceId(headerValue(req.headers, TRACE_HEADER));
    res.setHeader(TRACE_HEADER, traceId);
    const pathname = getPathname(req);

    if (pathname === HEALTH_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJsonRpcError(res, 405, ERROR_CODES.INVALID_PARAMS, `${HEALTH_PATH} 只支持 GET`, { traceId });
        return;
      }
      await handleHealth(req, res, traceId);
      return;
    }

    if (pathname !== MCP_PATH) {
      sendJsonRpcError(res, 404, ERROR_CODES.INVALID_PARAMS, `未知路径：${pathname}（可用：POST ${MCP_PATH}、GET ${HEALTH_PATH}）`, {
        traceId,
      });
      return;
    }

    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      sendJsonRpcError(res, 405, ERROR_CODES.INVALID_PARAMS, `${MCP_PATH} 只支持 POST（Streamable HTTP 无状态模式）`, {
        traceId,
      });
      return;
    }

    await handleMcpPost(req, res, traceId);
  });

  // 大请求体兜底：不要在 Node 层默认 headersTimeout 下静默挂起
  server.headersTimeout = 20_000;
  server.requestTimeout = Math.max(HTTP.maxBodyBytes > 0 ? 120_000 : 0, 120_000);

  return {
    server,
    stats,
    verifier,
    /** 启动监听；port=0 时由系统分配（测试用） */
    listen({ host = HTTP.host, port = HTTP.port } = {}) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const addr = server.address();
          resolve({ host, port: addr.port, url: `http://${host}:${addr.port}` });
        });
      });
    },
    async close() {
      healthCache = null;
      verifier.close?.();
      if (!server.listening) return;
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** 便于 entrypoint 直接使用：创建 + 监听 */
export async function startHttpServer(opts = {}) {
  const instance = createHttpServer(opts);
  const addr = await instance.listen(opts.listen || {});
  return { ...instance, address: addr, url: `${addr.url}${MCP_PATH}` };
}

export { ERROR_CODES, errorMeta, isContractError, authFailed, invalidParams };
