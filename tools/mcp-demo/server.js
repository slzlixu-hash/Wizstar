#!/usr/bin/env node
/**
 * mcp-demo —— 零依赖本地 MCP 演示服务（Streamable HTTP，规范 V1.0 对齐）
 *
 * 端点：
 *   GET  /healthz   探活（无副作用）
 *   POST /mcp       JSON-RPC 2.0：initialize / notifications/initialized / tools/list / tools/call
 *
 * 演示工具（覆盖三级风险档，schema 带 x-risk 声明）：
 *   get_market_notes      read          免审批
 *   save_scratch_note     write         可逆写
 *   publish_listing       irreversible  强制 HITL（服务端返回统一信封，审批由平台层裁决）
 *
 * MCP-HMAC：设置环境变量 WIZSTAR_DEMO_HMAC_SECRET 后启用校验（规范 §2.2）；
 * 未设置时跳过签名校验（本地演示默认放行）。
 *
 * 启动：node tools/mcp-demo/server.js  （端口取 PORT 环境变量，默认 5307）
 */
'use strict';

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 5307);
const HMAC_SECRET = process.env.WIZSTAR_DEMO_HMAC_SECRET || '';
const SERVER_NAME = 'mcp-demo';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2025-06-18';

const notes = [];

// ---------------------------------------------------------------- 工具定义

const TOOLS = [
  {
    name: 'get_market_notes',
    description: '查询已记录的市场观察笔记（只读，免审批）。',
    xRisk: 'read',
    inputSchema: { type: 'object', properties: {} },
    risk: 'read',
    execute() {
      return {
        success: true,
        data: { total: notes.length, notes: notes.slice(-20) },
        usage: { costCents: 0, unit: 'call', quantity: 1 },
        error: null,
        server: { name: SERVER_NAME, version: SERVER_VERSION, toolVersion: '1.0', elapsedMs: 1 },
        traceId: randomId(),
        replayed: false
      };
    }
  },
  {
    name: 'save_scratch_note',
    description: '保存一条市场观察笔记（可逆写操作）。',
    xRisk: 'write',
    inputSchema: {
      type: 'object',
      required: ['content'],
      properties: { content: { type: 'string', description: '笔记正文' } }
    },
    risk: 'write',
    execute(args) {
      if (!args || typeof args.content !== 'string' || !args.content.trim()) {
        return envelopeError(40001, '参数 content 不能为空');
      }
      notes.push({ content: args.content, at: new Date().toISOString() });
      return {
        success: true,
        data: { saved: true, total: notes.length },
        usage: { costCents: 0, unit: 'call', quantity: 1 },
        error: null,
        server: { name: SERVER_NAME, version: SERVER_VERSION, toolVersion: '1.0', elapsedMs: 1 },
        traceId: randomId(),
        replayed: false
      };
    }
  },
  {
    name: 'publish_listing',
    description: '发布商品上架（不可逆操作：对外可见，触发店铺审核；需平台人工审批）。',
    xRisk: 'irreversible',
    inputSchema: {
      type: 'object',
      required: ['title', 'priceCents'],
      properties: {
        title: { type: 'string', description: '商品标题，30 字以内' },
        priceCents: { type: 'integer', description: '价格（分）' },
        operationId: { type: 'string', description: '平台下发的唯一幂等操作流水号' }
      }
    },
    risk: 'irreversible',
    execute(args) {
      if (!args || !args.title || typeof args.priceCents !== 'number') {
        return envelopeError(40001, '参数 title / priceCents 不能为空');
      }
      // 平台层审批通过后才会真正落到这里；服务端只做最终执行
      return {
        success: true,
        data: { productId: 'p-' + randomId().slice(0, 8), auditStatus: 1, title: args.title },
        usage: { costCents: 0, unit: 'call', quantity: 1 },
        error: null,
        server: { name: SERVER_NAME, version: SERVER_VERSION, toolVersion: '1.0', elapsedMs: 2 },
        traceId: randomId(),
        replayed: false
      };
    }
  }
];

function envelopeError(code, message) {
  return {
    success: false,
    data: null,
    usage: { costCents: 0, unit: 'call', quantity: 1 },
    error: { code, message, retryable: code === 42001 || code === 50001 },
    server: { name: SERVER_NAME, version: SERVER_VERSION, toolVersion: '1.0', elapsedMs: 1 },
    traceId: randomId(),
    replayed: false
  };
}

function randomId() {
  return crypto.randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------- MCP-HMAC 校验

function verifyHmac(req, rawBody) {
  if (!HMAC_SECRET) return { ok: true };

  const header = req.headers['authorization'] || '';
  const match = /^MCP-HMAC keyId=([^,]+),ts=(\d+),nonce=([^,]+),sig=([A-Za-z0-9_-]+)$/.exec(header);
  if (!match) return { ok: false, code: 41001, message: '缺少或非法的 MCP-HMAC Authorization 头' };

  const [, keyId, ts, nonce, sig] = match;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
    return { ok: false, code: 41001, message: '时间戳超出容差（±300s）' };
  }

  const bodyHash = crypto.createHash('sha256').update(rawBody || '').digest('hex');
  const stringToSign = [req.method, req.url, ts, nonce, bodyHash, keyId].join('\n');
  const expected = crypto.createHmac('sha256', HMAC_SECRET).update(stringToSign).digest('base64url');
  if (expected !== sig) {
    return { ok: false, code: 41001, message: '签名不符' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- HTTP 服务

const sessions = new Map(); // sessionId -> { initialized: true }

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    sendJson(res, 200, { status: 'ok', uptimeSeconds: Math.floor(process.uptime()), notes: notes.length });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/mcp') {
    sendJson(res, 404, jsonRpcError(null, -32601, 'method not found'));
    return;
  }

  let chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');

    const auth = verifyHmac(req, rawBody);
    if (!auth.ok) {
      sendJson(res, 200, envelopeError(auth.code, auth.message));
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
    const method = message.method || '';

    // initialize：回 serverInfo + session id
    if (method === 'initialize') {
      const sessionId = randomId();
      sessions.set(sessionId, { initialized: true });
      const payload = {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
        }
      };
      const body = JSON.stringify(payload);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Mcp-Session-Id': sessionId
      });
      res.end(body);
      return;
    }

    if (method === 'notifications/initialized') {
      res.writeHead(202, {});
      res.end();
      return;
    }

    // 其余方法要求已握手
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !sessions.has(sessionId)) {
      sendJson(res, 200, jsonRpcError(id, -32002, 'not initialized: 请先调用 initialize'));
      return;
    }

    if (method === 'tools/list') {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            'x-risk': tool.xRisk,
            inputSchema: tool.inputSchema
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

      const envelope = tool.execute(args);
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
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mcp-demo] listening on http://127.0.0.1:${PORT} (hmac=${HMAC_SECRET ? 'on' : 'off'})`);
});
