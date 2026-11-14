#!/usr/bin/env node
/**
 * 冒烟测试（规范 §7 验收清单）
 *
 * 覆盖：
 *   1. GET /healthz 200 且 < 50ms、无副作用
 *   2. initialize 握手 + Mcp-Session-Id
 *   3. tools/list 返回 7 个工具、全部带 x-risk=read
 *   4. meta 三件套返回统一信封、字段齐全
 *   5. 未接线语义工具明确返回 50001 offline（不伪造在线）
 *   6. HMAC：错签 / 缺头 / 篡改 body / nonce 重放 / keyId 不匹配 → 41001
 *   7. 参数校验 → 40001；错误归一化 retryable 标记正确
 *
 * 运行：node tools/mcp-douyin-compass/test/smoke.js  （自动起临时服务，无需外部依赖）
 */
'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server/index');
const { buildAuthorizationHeader, sign, stringToSign, sha256Hex, verifyHmac } = require('../server/hmac');

const SECRET = 'smoke-test-secret';
const KEY_ID = 'wizstar-local';
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures.push({ name, error: e.message });
    console.log(`  FAIL  ${name} :: ${e.message}`);
  }
}

function request(port, path, { method = 'POST', body = '', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (_) { /* 非 JSON 响应保持 null */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function authHeader(body, opts = {}) {
  return buildAuthorizationHeader({
    keyId: KEY_ID,
    secret: SECRET,
    method: 'POST',
    path: '/mcp',
    body,
    ...opts
  });
}

function rpcBody(method, params, id = 1) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

function assertEnvelope(env, label) {
  assert(env && typeof env === 'object', `${label}: 不是对象`);
  for (const key of ['success', 'data', 'usage', 'error', 'server', 'traceId', 'replayed']) {
    assert(Object.prototype.hasOwnProperty.call(env, key), `${label}: 缺少信封字段 ${key}`);
  }
  assert(env.server && env.server.name === 'mcp-douyin-compass', `${label}: server.name 不对`);
  assert(typeof env.traceId === 'string' && env.traceId.length > 0, `${label}: traceId 无效`);
  assert(typeof env.replayed === 'boolean', `${label}: replayed 必须为布尔`);
}

async function main() {
  // HMAC 校验由环境变量控制，测试进程内先设置再 createServer
  process.env.WIZSTAR_COMPASS_HMAC_SECRET = SECRET;
  process.env.WIZSTAR_COMPASS_HMAC_KEY_ID = KEY_ID;
  // 关闭回环豁免：本冒烟要验证「缺签/错签 → 41001」，不能让 127.0.0.1 免签放行
  process.env.WIZSTAR_COMPASS_AUTH_LOOPBACK_BYPASS = '0';
  // 步骤 2 之后 ledger.js 会被 index.js 自动接线；测试必须用临时账本目录，
  // 既不污染服务私有 data/ledger.db，也让 meta.list_operations 的 total 可预期为 0。
  const tmpLedgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizstar-compass-smoke-'));
  process.env.WIZSTAR_COMPASS_LEDGER_DIR = tmpLedgerDir;
  // 清掉模块缓存，确保 index.js 读到新 env
  for (const key of Object.keys(require.cache)) {
    if (key.includes('mcp-douyin-compass')) delete require.cache[key];
  }
  const { createServer: freshCreateServer } = require('../server/index');
  const { buildAuthorizationHeader: freshAuth, sign: freshSign, stringToSign: freshSts, sha256Hex: freshHash } = require('../server/hmac');
  const freshTools = require('../server/tools');

  const server = freshCreateServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`\n[mcp-douyin-compass smoke] 临时服务 127.0.0.1:${port}\n`);

  try {
    // ---- 1. 探活 ----
    const t0 = Date.now();
    const health = await request(port, '/healthz', { method: 'GET' });
    const elapsed = Date.now() - t0;
    check('GET /healthz 200', () => assert.strictEqual(health.status, 200));
    check('GET /healthz < 50ms', () => assert(elapsed < 50, `实测 ${elapsed}ms`));
    check('healthz 明确标注探针 offline', () => {
      assert.strictEqual(health.json.status, 'ok');
      assert.strictEqual(health.json.probe.connected, false);
      assert(health.json.probe.reason, 'offline 必须给出原因');
    });
    check('healthz 报出 7 个工具', () => assert.strictEqual(health.json.tools, 7));

    // ---- 2. 握手 ----
    const initBody = rpcBody('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      clientInfo: { name: 'smoke', version: '1.0' }
    });
    const init = await request(port, '/mcp', {
      body: initBody,
      headers: { Authorization: freshAuth({ keyId: KEY_ID, secret: SECRET, method: 'POST', path: '/mcp', body: initBody }) }
    });
    check('initialize 200 + result', () => {
      assert.strictEqual(init.status, 200);
      assert(init.json.result && init.json.result.serverInfo, '缺少 serverInfo');
      assert.strictEqual(init.json.result.protocolVersion, '2025-06-18');
    });
    const sessionId = init.headers['mcp-session-id'];
    check('initialize 返回 Mcp-Session-Id', () => assert(sessionId && sessionId.length >= 16, '缺少会话 id'));

    // ---- 3. tools/list ----
    const listBody = rpcBody('tools/list', {}, 2);
    const list = await request(port, '/mcp', {
      body: listBody,
      headers: {
        'Mcp-Session-Id': sessionId,
        Authorization: freshAuth({ keyId: KEY_ID, secret: SECRET, method: 'POST', path: '/mcp', body: listBody })
      }
    });
    check('tools/list 返回 7 个工具（≤10）', () => {
      const tools = list.json.result.tools;
      assert.strictEqual(tools.length, 7);
      assert(tools.length <= 10);
    });
    check('tools/list 每个工具都带 x-risk=read', () => {
      for (const t of list.json.result.tools) {
        assert.strictEqual(t['x-risk'], 'read', `${t.name} 的 x-risk 不是 read`);
        assert(t.inputSchema && t.inputSchema.type === 'object', `${t.name} 缺 inputSchema`);
      }
    });
    check('工具名全部命中平台 read 动词前缀', () => {
      const okPrefix = /^(get_|query_|search_|list_|fetch_|count_|meta\.)/;
      for (const t of list.json.result.tools) {
        assert(okPrefix.test(t.name), `${t.name} 会被 RiskClassifier 判成 write`);
      }
    });

    // 封装一次合法的 tools/call
    async function callTool(name, args, id) {
      const body = rpcBody('tools/call', { name, arguments: args }, id);
      return request(port, '/mcp', {
        body,
        headers: {
          'Mcp-Session-Id': sessionId,
          Authorization: freshAuth({ keyId: KEY_ID, secret: SECRET, method: 'POST', path: '/mcp', body, nonce: 'n-' + id + '-' + Date.now() })
        }
      });
    }
    function envelopeOf(resp) {
      return JSON.parse(resp.json.result.content[0].text);
    }

    // ---- 4. meta 三件套 ----
    const h = await callTool('meta.health', {}, 10);
    check('meta.health 统一信封', () => {
      const env = envelopeOf(h);
      assertEnvelope(env, 'meta.health');
      assert.strictEqual(env.success, true);
      assert.strictEqual(env.data.credential.mode, 'page-session-cookie');
      assert.strictEqual(env.data.credential.tokenActive, false);
      assert.strictEqual(env.data.probe.connected, false, '不得伪造在线');
    });
    const d = await callTool('meta.describe', {}, 11);
    check('meta.describe 含 Schema 目录与并发限额', () => {
      const env = envelopeOf(d);
      assertEnvelope(env, 'meta.describe');
      assert.strictEqual(env.data.schemas.length, 7);
      assert(env.data.limits && env.data.limits.maxConcurrency >= 1);
      assert.strictEqual(env.data.protocol.protocolVersion, '2025-06-18');
    });
    const o = await callTool('meta.list_operations', { operationIds: [], since: null }, 12);
    check('meta.list_operations 账本接线后返回可对账清单', () => {
      const env = envelopeOf(o);
      assertEnvelope(env, 'meta.list_operations');
      assert.strictEqual(env.success, true);
      assert.strictEqual(env.data.available, true, '步骤 2 之后账本应已自动接线');
      assert(Array.isArray(env.data.operations), 'operations 必须是数组');
      assert.strictEqual(env.data.total, env.data.operations.length);
      assert.strictEqual(env.data.total, 0, '临时账本目录应为空');
    });
    // 降级分支仍要覆盖：账本模块缺失时不得伪造历史操作。
    const listTool = freshTools.TOOLS.find((t) => t.name === 'meta.list_operations');
    const offlineEnv = await freshTools.invoke(listTool, { operationIds: [], since: null }, { tools: freshTools.TOOLS });
    check('meta.list_operations 账本未接线时如实标注', () => {
      assertEnvelope(offlineEnv, 'meta.list_operations(offline)');
      assert.strictEqual(offlineEnv.success, true);
      assert.strictEqual(offlineEnv.data.available, false);
      assert.strictEqual(offlineEnv.data.total, 0);
      assert(/步骤 2/.test(offlineEnv.data.note), '需给出未接线原因');
    });

    // ---- 5. 未接线语义工具 offline ----
    const r = await callTool('get_compass_product_rank', { rankType: 'market_hot_sale' }, 13);
    check('未接线语义工具返回 50001 且 retryable', () => {
      const env = envelopeOf(r);
      assertEnvelope(env, 'product_rank');
      assert.strictEqual(env.success, false);
      assert.strictEqual(env.error.code, 50001);
      assert.strictEqual(env.error.retryable, true);
      assert(/探针|未连接|尚未接线/.test(env.error.message), '错误信息必须说明离线原因');
    });

    // ---- 6. 参数校验 ----
    const v = await callTool('get_compass_product_rank', {}, 14);
    check('缺必填参数 → 40001 不可重试', () => {
      const env = envelopeOf(v);
      assert.strictEqual(env.error.code, 40001);
      assert.strictEqual(env.error.retryable, false);
      assert(/rankType/.test(env.error.message));
    });
    const p = await callTool('get_compass_product_rank', { rankType: 'x', pages: 999 }, 15);
    check('pages 超限 → 40001', () => assert.strictEqual(envelopeOf(p).error.code, 40001));

    // ---- 7. HMAC ----
    const body = rpcBody('tools/list', {}, 90);
    const noHeader = await request(port, '/mcp', { body });
    check('缺少 Authorization → 41001 信封', () => {
      assert.strictEqual(noHeader.json.error.code, 41001);
      assert.strictEqual(noHeader.json.success, false);
    });

    const badSig = await request(port, '/mcp', {
      body,
      headers: { Authorization: freshAuth({ keyId: KEY_ID, secret: 'wrong-secret', method: 'POST', path: '/mcp', body }) }
    });
    check('错误签名 → 41001', () => assert.strictEqual(badSig.json.error.code, 41001));

    const tampered = await request(port, '/mcp', {
      body: body + ' ',
      headers: { Authorization: freshAuth({ keyId: KEY_ID, secret: SECRET, method: 'POST', path: '/mcp', body }) }
    });
    check('篡改请求 Body → 41001 签名不符', () => {
      assert.strictEqual(tampered.json.error.code, 41001);
      assert(/签名不符/.test(tampered.json.error.message));
    });

    const staleTs = Math.floor(Date.now() / 1000) - 400;
    const stale = await request(port, '/mcp', {
      body,
      headers: { Authorization: freshAuth({ keyId: KEY_ID, secret: SECRET, method: 'POST', path: '/mcp', body, ts: staleTs }) }
    });
    check('时间戳超出 ±300s → 41001', () => assert.strictEqual(stale.json.error.code, 41001));

    const badKey = await request(port, '/mcp', {
      body,
      headers: { Authorization: freshAuth({ keyId: 'other-key', secret: SECRET, method: 'POST', path: '/mcp', body }) }
    });
    check('keyId 不匹配 → 41001', () => assert.strictEqual(badKey.json.error.code, 41001));

    const replayNonce = 'smoke-replay-nonce';
    const replayHeader = freshAuth({ keyId: KEY_ID, secret: SECRET, method: 'POST', path: '/mcp', body, nonce: replayNonce });
    const first = await request(port, '/mcp', { body, headers: { Authorization: replayHeader, 'Mcp-Session-Id': sessionId } });
    const second = await request(port, '/mcp', { body, headers: { Authorization: replayHeader, 'Mcp-Session-Id': sessionId } });
    check('nonce 首次通过、重放被拒', () => {
      assert(first.json.result, '首次请求应通过');
      assert.strictEqual(second.json.error.code, 41001);
      assert(/重放|41009/.test(second.json.error.message), '重放原因需标注规范来源');
    });

    check('sign/stringToSign/sha256Hex 与 C# 口径一致', () => {
      const text = stringToSign('POST', '/mcp', '100', 'abc', sha256Hex('{}'), KEY_ID);
      assert.strictEqual(text, `POST\n/mcp\n100\nabc\n${sha256Hex('{}')}\n${KEY_ID}`);
      assert.strictEqual(freshSign(SECRET, text), freshSign(SECRET, text));
    });

    // ---- 7.5 Bearer 静态令牌（第三方快速接入，免算签名）----
    const bearerBody = rpcBody('tools/list', {}, 92);
    const bearerPair = await request(port, '/mcp', {
      body: bearerBody,
      headers: { 'Mcp-Session-Id': sessionId, Authorization: `Bearer ${KEY_ID}:${SECRET}` }
    });
    check('Bearer <keyId:secret> 直通 tools/list', () => {
      assert(bearerPair.json.result && Array.isArray(bearerPair.json.result.tools), 'Bearer 通道应免签放行');
      assert.strictEqual(bearerPair.json.result.tools.length, 7);
    });

    const bearerBareBody = rpcBody('tools/list', {}, 93);
    const bearerBare = await request(port, '/mcp', {
      body: bearerBareBody,
      headers: { 'Mcp-Session-Id': sessionId, Authorization: `Bearer ${SECRET}` }
    });
    check('Bearer 裸 <secret> 也可直通', () => {
      assert(bearerBare.json.result && Array.isArray(bearerBare.json.result.tools));
    });

    const bearerBad = await request(port, '/mcp', {
      body: rpcBody('tools/list', {}, 94),
      headers: { Authorization: 'Bearer wrong-token' }
    });
    check('错误 Bearer Token → 41001 且提示 Bearer 格式', () => {
      assert.strictEqual(bearerBad.json.error.code, 41001);
      assert(/Bearer/.test(bearerBad.json.error.message));
      assert(!bearerBad.json.error.message.includes(SECRET), '错误消息不得泄露密钥');
    });

    // ---- 7.6 回环豁免（单元级：真实 HTTP 服务上已按 =0 关闭）----
    const fakeReq = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers, url: '/mcp', method: 'POST' });
    check('verifyHmac 回环地址免签放行（默认口径）', () => {
      for (const addr of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
        const r = verifyHmac(fakeReq(addr), '{}', { secret: SECRET, keyId: KEY_ID });
        assert.strictEqual(r.ok, true, `${addr} 应免签`);
        assert.strictEqual(r.via, 'loopback');
      }
    });
    check('verifyHmac 关闭回环豁免后回环请求必须验签', () => {
      const r = verifyHmac(fakeReq('127.0.0.1'), '{}', { secret: SECRET, keyId: KEY_ID, loopbackBypass: false });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, 41001);
    });

    // ---- 8. 未握手 ----
    const notInit = await request(port, '/mcp', {
      body: rpcBody('tools/list', {}, 91),
      headers: { Authorization: freshAuth({ keyId: KEY_ID, secret: SECRET, method: 'POST', path: '/mcp', body: rpcBody('tools/list', {}, 91) }) }
    });
    check('未握手调用 tools/list → -32002', () => assert.strictEqual(notInit.json.error.code, -32002));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.WIZSTAR_COMPASS_LEDGER_DIR;
    try { fs.rmSync(tmpLedgerDir, { recursive: true, force: true }); } catch (_) { /* 临时目录清理失败不影响测试结论 */ }
  }

  console.log(`\n[smoke] ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`  - ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('[smoke] 崩溃:', e);
  process.exitCode = 1;
});
