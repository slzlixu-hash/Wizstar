#!/usr/bin/env node
/**
 * mcp-douyin-compass —— 抖店电商罗盘选品 MCP 服务（零依赖，规范 V1.0）
 *
 * 端点：
 *   GET  /healthz  探活（无副作用、免签，与 McpJsonRpcClient.HealthProbeAsync 对齐）
 *   POST /mcp      JSON-RPC 2.0：initialize / notifications/initialized / tools/list / tools/call
 *   GET  /ws       WebSocket 升级（MV3 探针接入，步骤 2 由 bridge.js 自动接线）
 *
 * 设计要点：
 *   - 统一出参信封 + 8 个契约错误码；所有失败也返回信封，不抛裸异常。
 *   - MCP-HMAC：设置 WIZSTAR_COMPASS_HMAC_SECRET 后启用；nonce TTL 600s 防重放。
 *   - 可选模块自动接线：bridge.js / ledger.js / compass.js 存在即生效，骨架无需改动，
 *     便于「分步实现、每步可验收」。缺失时明确标注 offline，绝不伪造在线。
 *   - 只监听 127.0.0.1，不对外暴露；凭证是浏览器页面会话 Cookie，不进消息体/日志。
 *
 * 启动：node tools/mcp-douyin-compass/server/index.js
 *       PORT（默认 5206）/ WIZSTAR_COMPASS_HMAC_SECRET / WIZSTAR_COMPASS_HMAC_KEY_ID
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SERVER_NAME, SERVER_VERSION, ErrorCodes, fail, newTraceId, replayed } = require('./envelope');
const { verifyHmac, NonceGuard } = require('./hmac');
const { TOOLS, invoke } = require('./tools');

const PROTOCOL_VERSION = '2025-06-18';
const PORT = Number(process.env.PORT || 5206);
const HOST = '127.0.0.1';
const HMAC_SECRET = process.env.WIZSTAR_COMPASS_HMAC_SECRET || '';
const HMAC_KEY_ID = process.env.WIZSTAR_COMPASS_HMAC_KEY_ID || '';
/** 回环免签默认开（本服务只监听 127.0.0.1）；跨机部署设 0 强制验签。 */
const LOOPBACK_BYPASS = !/^(0|false|no)$/i.test(String(process.env.WIZSTAR_COMPASS_AUTH_LOOPBACK_BYPASS || ''));
const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_TTL_MS = 30 * 60 * 1000;

/** 只在「模块不存在」时容错；文件内容报错必须暴露，不许被吞掉。 */
function optionalRequire(name) {
  try {
    return require(name);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(name)) return null;
    throw e;
  }
}

function createServer() {
  const sessions = new Map(); // sessionId -> expiresAt
  const nonceGuard = new NonceGuard();
  const startedAt = Date.now();

  // ---- 可选模块：步骤 2（bridge / ledger）、步骤 5（compass）落地后自动接线 ----
  const bridgeMod = optionalRequire('./bridge');
  const ledgerMod = optionalRequire('./ledger');
  const compassMod = optionalRequire('./compass');

  const ledger = ledgerMod ? ledgerMod.create() : null;
  const bridge = bridgeMod ? bridgeMod.attach({ onFrames: compassMod ? compassMod.onFrames : null }) : null;

  // 从单一数据源（selectors.json + filter-dsl）生成字典，避免 describe 与实现漂移
  let rankTypes = [];
  let secondFilterFields = {};
  if (compassMod) {
    try {
      const p = require('./parser');
      const d = require('./filter-dsl');
      rankTypes = p.SUPPORTED_RANKS.map((rankType) => ({
        rankType,
        ruleId: p.RULE_BY_RANK.get(rankType).id,
        fields: Object.keys(d.fieldsFor(rankType))
      }));
      for (const rankType of p.SUPPORTED_RANKS.concat(['搜索词分析'])) {
        secondFilterFields[rankType] = d.describeFields(rankType);
      }
    } catch (e) {
      console.warn('[compass] 字典生成失败:', e.message);
    }
  }

  const ctx = {
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    tools: TOOLS,
    hmacEnabled: Boolean(HMAC_SECRET),
    rankTypes,
    secondFilterFields,
    startedAt,
    compass: compassMod || null,
    bridge: bridge || null,
    probeState: () => (bridge ? bridge.state() : { connected: false, reason: 'bridge.js 尚未接入（步骤 2）' }),
    ledgerStats: ledger ? () => ledger.stats() : null,
    ledgerList: ledger ? (q) => ledger.list(q) : null,
    idempotency: ledger || null
  };

  // 步骤 5：语义工具需要 ctx（内含 bridge）才能下发采集指令；构造完成后一次性绑定
  if (compassMod && typeof compassMod.bind === 'function') compassMod.bind(ctx);

  function sendJson(res, status, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      ...extraHeaders
    });
    res.end(body);
  }

  function jsonRpcError(id, code, message) {
    return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
  }

  function purgeSessions(now = Date.now()) {
    for (const [sid, expiresAt] of sessions) {
      if (expiresAt <= now) sessions.delete(sid);
    }
  }

  /** 工具执行：带 operationId 时走幂等账本（步骤 2 接入后生效）。 */
  async function callTool(tool, args, traceId) {
    const operationId = args && typeof args.operationId === 'string' ? args.operationId : null;
    const run = () => invoke(tool, args, ctx, { traceId });
    if (ctx.idempotency && operationId && typeof ctx.idempotency.run === 'function') {
      return ctx.idempotency.run(operationId, args, run);
    }
    return run();
  }

  const server = http.createServer((req, res) => {
    // ---------------------------------------------------------- /healthz
    if (req.method === 'GET' && (req.url === '/healthz' || String(req.url).startsWith('/healthz?'))) {
      const probe = ctx.probeState();
      sendJson(res, 200, {
        status: 'ok',
        server: SERVER_NAME,
        version: SERVER_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        uptimeSeconds: Math.floor(process.uptime()),
        hmac: HMAC_SECRET ? 'on' : 'off',
        auth: HMAC_SECRET
          ? { modes: ['mcp-hmac', 'bearer'], loopbackBypass: LOOPBACK_BYPASS ? 'on' : 'off' }
          : { modes: ['none'], loopbackBypass: LOOPBACK_BYPASS ? 'on' : 'off' },
        tools: TOOLS.length,
        probe: { connected: Boolean(probe.connected), reason: probe.reason || null },
        ledger: ctx.ledgerStats ? ctx.ledgerStats() : { available: false },
        sessions: sessions.size
      });
      return;
    }

    // ---------------------------------------------------------- /selectors.json
    // 只读热更新源：MV3 探针每次任务前拉取，改 JSON 无需重发扩展。免签（无副作用）。
    if (req.method === 'GET' && String(req.url || '').startsWith('/selectors.json')) {
      try {
        const raw = fs.readFileSync(path.join(__dirname, 'selectors.json'), 'utf8');
        const body = JSON.stringify({ ...JSON.parse(raw), servedAt: new Date().toISOString() });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store'
        });
        res.end(body);
      } catch (e) {
        sendJson(res, 200, fail(ErrorCodes.InternalError, 'selectors.json 读取失败：' + e.message));
      }
      return;
    }

    // ---------------------------------------------------------- /mcp
    if (req.method !== 'POST' || !String(req.url || '').startsWith('/mcp')) {
      sendJson(res, 404, jsonRpcError(null, -32601, 'method not found'));
      return;
    }

    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const traceId = newTraceId();

      // 鉴权（三档短路：回环豁免 → Bearer 静态令牌 → MCP-HMAC 验签）
      const auth = verifyHmac(req, rawBody, {
        secret: HMAC_SECRET,
        keyId: HMAC_KEY_ID,
        nonceGuard,
        loopbackBypass: LOOPBACK_BYPASS,
      });
      if (!auth.ok) {
        sendJson(res, 200, fail(auth.code, auth.message, { traceId }));
        return;
      }

      let message;
      try {
        message = JSON.parse(rawBody);
      } catch (e) {
        sendJson(res, 400, jsonRpcError(null, -32700, 'parse error'));
        return;
      }

      const id = message.id === undefined ? null : message.id;
      const method = String(message.method || '');

      // initialize：回 serverInfo + Mcp-Session-Id
      if (method === 'initialize') {
        const sessionId = crypto.randomBytes(16).toString('hex');
        purgeSessions();
        sessions.set(sessionId, Date.now() + SESSION_TTL_MS);
        sendJson(
          res,
          200,
          {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
            }
          },
          { 'Mcp-Session-Id': sessionId }
        );
        return;
      }

      if (method === 'notifications/initialized') {
        res.writeHead(202, {});
        res.end();
        return;
      }

      // 其余方法要求已握手
      purgeSessions();
      const sessionId = req.headers['mcp-session-id'];
      if (!sessionId || !sessions.has(sessionId)) {
        sendJson(res, 200, jsonRpcError(id, -32002, 'not initialized: 请先调用 initialize'));
        return;
      }

      try {
        if (method === 'tools/list') {
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              tools: TOOLS.map((t) => ({
                name: t.name,
                description: t.description,
                'x-risk': t.xRisk,
                inputSchema: t.inputSchema
              }))
            }
          });
          return;
        }

        if (method === 'tools/call') {
          const toolName = message.params && message.params.name;
          const args = (message.params && message.params.arguments) || {};
          const tool = TOOLS.find((t) => t.name === toolName);
          if (!tool) {
            sendJson(res, 200, jsonRpcError(id, -32602, `unknown tool: ${toolName}`));
            return;
          }

          const envelope = await callTool(tool, args, traceId);
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(envelope) }],
              isError: !envelope.success
            }
          });
          return;
        }

        sendJson(res, 200, jsonRpcError(id, -32601, `method not found: ${method}`));
      } catch (e) {
        const envelope = fail(
          ErrorCodes.InternalError,
          `服务内部异常：${e && e.message ? e.message : String(e)}`,
          { traceId }
        );
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(envelope) }], isError: true }
        });
      }
    });
  });

  // WebSocket 升级：bridge.js 存在则由它接管，否则明确返回 426（不伪造连接）
  server.on('upgrade', (req, socket, head) => {
    if (bridge && typeof bridge.handleUpgrade === 'function') {
      bridge.handleUpgrade(req, socket, head);
      return;
    }
    socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });

  server.on('close', () => {
    if (ledger && typeof ledger.close === 'function') ledger.close();
    if (bridge && typeof bridge.close === 'function') bridge.close();
  });

  return server;
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(
      `[mcp-douyin-compass] listening on http://${HOST}:${PORT} ` +
        `(hmac=${HMAC_SECRET ? 'on' : 'off'}, tools=${TOOLS.length})`
    );
  });
}

module.exports = { createServer, PROTOCOL_VERSION, PORT, HOST, replayed };
