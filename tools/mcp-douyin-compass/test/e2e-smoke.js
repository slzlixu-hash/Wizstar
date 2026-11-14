#!/usr/bin/env node
/**
 * 步骤 5 端到端冒烟：4 个 compass 语义工具真实链路
 *
 * 用「真实 WS 探针 + 模拟罗盘响应」驱动，不依赖真实罗盘登录：
 *   tools/call → bridge.send(CMD) → WS → 模拟探针回 RESULT → parser → filter-dsl → 信封
 *
 * 覆盖：
 *   - get_compass_categories：类目树同步 + 缓存命中
 *   - get_compass_product_rank：切榜 → 分页 → 归一化 → DOM 补价 → 二级筛选 → 立项摘要
 *   - get_compass_search_words：data_range_v2 → compass_rank_v3 分页 → 归一
 *   - get_compass_word_products：逐词 industry_detail_list_v2 → 归一 → 筛选
 *   - 上游错误归一化（429/401/业务 code/非法 JSON）、离线降级、幂等回放接入
 *
 * 运行：node tools/mcp-douyin-compass/test/e2e-smoke.js
 */
'use strict';

const assert = require('assert');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push({ name, error: e.message }); console.log(`  FAIL  ${name} :: ${e.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push({ name, error: e.message }); console.log(`  FAIL  ${name} :: ${e.message}`); }
}
function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', name), 'utf8'));
}

// ------------------------------------------------------------- 最小 WS 探针客户端
function clientFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const mask = crypto.randomBytes(4);
  const len = body.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}
function clientText(obj) { return clientFrame(0x1, JSON.stringify(obj)); }

function decodeServerFrames(buf) {
  const out = [];
  let rest = buf;
  let consumedTotal = 0;
  for (;;) {
    if (rest.length < 2) break;
    let len = rest[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (rest.length < 4) break; len = rest.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (rest.length < 10) break; len = Number(rest.readBigUInt64BE(2)); off = 10; }
    if (rest.length < off + len) break;
    const opcode = rest[0] & 0x0f;
    const payload = rest.subarray(off, off + len);
    const item = { opcode, payload };
    if (opcode === 0x1) { try { item.json = JSON.parse(payload.toString('utf8')); } catch (_) {} }
    out.push(item);
    consumedTotal += off + len;
    rest = rest.subarray(off + len);
  }
  return { frames: out, consumed: consumedTotal };
}

/** 模拟探针：响应 CMD，按 URL 返回 fixture / 可注入错误。 */
async function startProbe(port, handler) {
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
  sock.write(
    `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
    `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
    `Origin: chrome-extension://fake\r\n\r\n`
  );
  let buf = Buffer.alloc(0);
  let upgraded = false;
  const state = { commands: [], generation: 0, token: null };

  sock.on('data', async (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!upgraded) {
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      buf = buf.subarray(idx + 4);
      upgraded = true;
    }
    const { frames, consumed } = decodeServerFrames(buf);
    buf = buf.subarray(consumed);
    for (const f of frames) {
      if (!f.json) continue;
      const m = f.json;
      if (m.type === 'CHALLENGE') {
        state.token = m.channelToken;
        state.generation = m.generation;
        sock.write(clientText({ type: 'HELLO', channelToken: m.channelToken, tab: 'compass', url: 'https://compass.jinritemai.com/shop', loggedIn: true, version: '1.0' }));
        continue;
      }
      if (m.type === 'PING') {
        sock.write(clientText({ type: 'PONG', generation: m.generation }));
        continue;
      }
      if (m.type !== 'CMD') continue;
      state.commands.push({ action: m.action, params: m.params });
      const result = await handler(m.action, m.params || {});
      sock.write(clientText({
        type: result && result.__error ? 'ERROR' : 'RESULT',
        commandId: m.commandId,
        generation: m.generation,
        ...(result && result.__error ? { error: result.__error } : { payload: result })
      }));
    }
  });

  await waitUntil(() => state.token !== null);
  return { sock, state, close: () => sock.destroy() };
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (predicate()) return; await new Promise((r) => setTimeout(r, 15)); }
  throw new Error('等待条件超时');
}

// ------------------------------------------------------------- MCP HTTP 客户端
function request(port, pathname, method = 'POST', body = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method,
      headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  console.log('\n[mcp-douyin-compass e2e-smoke]\n');

  // 隔离账本，避免污染真实 data/
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-e2e-'));
  process.env.WIZSTAR_COMPASS_LEDGER_DIR = tmpDir;

  const { createServer } = require('../server/index');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const init = await request(port, '/mcp', 'POST', JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, clientInfo: { name: 'e2e', version: '1' } }
  }));
  const sid = init.headers['mcp-session-id'];

  async function call(name, args, id = Math.floor(Math.random() * 1e6)) {
    const res = await request(port, '/mcp', 'POST', JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args }
    }), { 'Mcp-Session-Id': sid });
    return JSON.parse(res.json.result.content[0].text);
  }

  // 默认探针：按 action / URL 返回 fixture
  let fault = null;   // { status, body } 注入上游故障
  const handler = async (action, params) => {
    if (action === 'SET_RULES') return { ok: true, count: (params.rules || []).length };
    if (action === 'SWITCH_TAB') return { ok: true, label: params.label };
    if (action === 'READ_PRICES') return { rows: [] };
    if (action === 'PAGINATION') return { current: 1, hasNext: false };
    if (action === 'WAIT_CAPTURE') return { data: fixture('rank-total.json') };
    if (action === 'GET_CATEGORY') return { data: fixture('categories.json') };
    if (action === 'PAGE_FETCH') {
      if (fault) return fault;
      const url = String(params.url || '');
      let data;
      if (url.includes('cate_list')) data = fixture('categories.json');
      else if (url.includes('data_range_v2')) data = { code: 0, data: { data_range_map: { '7': { max_date: 1762800000 } } } };
      else if (url.includes('compass_rank_v3')) data = fixture('word-rank.json');
      else if (url.includes('industry_detail_list_v2')) data = fixture('word-products.json');
      else if (url.includes('market_hot_sale')) data = fixture('rank-total.json');
      else data = fixture('rank-total.json');
      return { ok: true, status: 200, body: JSON.stringify(data) };
    }
    return { ok: true };
  };

  const probe = await startProbe(port, handler);
  try {
    await checkAsync('探针握手完成，meta.health 报 connected + loggedIn', async () => {
      const env = await call('meta.health', {});
      assert.strictEqual(env.success, true);
      assert.strictEqual(env.data.probe.connected, true);
      assert.strictEqual(env.data.probe.loggedIn, true);
      assert.strictEqual(env.data.ledger.available, true);
    });

    await checkAsync('meta.describe 输出 9 榜单字典与二级筛选项', async () => {
      const env = await call('meta.describe', {});
      assert.strictEqual(env.data.dictionaries.rankTypes.length, 9);
      assert(env.data.dictionaries.secondFilterFields['总榜'].length === 4);
      assert.strictEqual(env.data.schemas.length, 7);
    });

    await checkAsync('get_compass_categories 同步并缓存', async () => {
      const first = await call('get_compass_categories', {});
      assert.strictEqual(first.success, true, first.error && first.error.message);
      assert.strictEqual(first.data.total, 4);
      assert.strictEqual(first.data.cached, false);
      const second = await call('get_compass_categories', {});
      assert.strictEqual(second.data.cached, true);
    });

    await checkAsync('get_compass_product_rank 端到端（切榜→翻页→归一化→摘要）', async () => {
      const env = await call('get_compass_product_rank', { rankType: '总榜', pages: 1 });
      assert.strictEqual(env.success, true, env.error && env.error.message);
      assert.strictEqual(env.data.rankType, '总榜');
      assert.strictEqual(env.data.capturedRows, 2);
      assert.strictEqual(env.data.top.length, 2);
      assert.strictEqual(env.data.top[0].title, '冬季加厚保暖外套 男');
      assert.strictEqual(env.data.top[0].priceMinCents, 12900);
      assert.strictEqual(env.data.top[0].priceMaxCents, 25900);
      assert(env.data.priceBandCents && env.data.priceBandCents.min === 12900);
      const actions = probe.state.commands.map((c) => c.action);
      assert(actions.includes('SET_RULES'), '未下发拦截规则');
      assert(actions.includes('SWITCH_TAB'), '未切榜');
      assert(actions.includes('PAGE_FETCH'), '未拉取榜单');
      assert(actions.includes('READ_PRICES'), '未补 DOM 价格');
    });

    await checkAsync('get_compass_product_rank 支持规则 id + 二级筛选', async () => {
      const env = await call('get_compass_product_rank', {
        rankType: 'rank_total', pages: 1,
        filters: { new_pay_amt: '0' }
      });
      assert.strictEqual(env.success, true, env.error && env.error.message);
      assert.strictEqual(env.data.appliedFilters.length, 1);
      assert(Number.isInteger(env.data.droppedByFilter));
    });

    await checkAsync('非法榜单 / 非法筛选字段 → 40001', async () => {
      const a = await call('get_compass_product_rank', { rankType: '不存在' });
      assert.strictEqual(a.error.code, 40001);
      const b = await call('get_compass_product_rank', { rankType: '总榜', filters: { nope: '0' } });
      assert.strictEqual(b.error.code, 40001);
    });

    await checkAsync('get_compass_search_words 端到端（日期→分页→归一）', async () => {
      const env = await call('get_compass_search_words', { pages: 1 });
      assert.strictEqual(env.success, true, env.error && env.error.message);
      assert.strictEqual(env.data.capturedRows, 2);
      assert.strictEqual(env.data.top[0].word, '加绒卫衣');
      assert(env.data.dateRange && env.data.dateRange.days === 7);
      assert(probe.state.commands.some((c) => c.action === 'PAGE_FETCH' && String(c.params.url).includes('data_range_v2')));
      assert(probe.state.commands.some((c) => c.action === 'PAGE_FETCH' && String(c.params.url).includes('compass_rank_v3')));
    });

    await checkAsync('get_compass_word_products 逐词采集 + priceYuan', async () => {
      const env = await call('get_compass_word_products', { words: ['加绒卫衣', '打底衫'], pages: 1 });
      assert.strictEqual(env.success, true, env.error && env.error.message);
      assert.strictEqual(env.data.capturedRows, 4);
      assert.strictEqual(env.data.perWord.length, 2);
      assert.strictEqual(env.data.top[0].priceYuan, 89);
      assert(probe.state.commands.some((c) => c.action === 'PAGE_FETCH' && String(c.params.url).includes('industry_detail_list_v2')));
    });

    async function withFault(value, fn) {
      fault = value;
      try { return await fn(); } finally { fault = null; }
    }

    await checkAsync('上游 429 → 42001 且 retryable=true', async () => {
      await withFault({ ok: false, status: 429, body: 'rate limited' }, async () => {
        const env = await call('get_compass_product_rank', { rankType: '总榜' });
        assert.strictEqual(env.success, false);
        assert.strictEqual(env.error.code, 42001);
        assert.strictEqual(env.error.retryable, true);
      });
    });

    await checkAsync('上游 401 → 43002 不可重试', async () => {
      await withFault({ ok: false, status: 401, body: 'unauthorized' }, async () => {
        const env = await call('get_compass_product_rank', { rankType: '总榜' });
        assert.strictEqual(env.error.code, 43002);
        assert.strictEqual(env.error.retryable, false);
      });
    });

    await checkAsync('上游非法 JSON → 43010', async () => {
      await withFault({ ok: true, status: 200, body: '<html>login</html>' }, async () => {
        const env = await call('get_compass_product_rank', { rankType: '总榜' });
        assert.strictEqual(env.error.code, 43010);
      });
    });

    await checkAsync('带 operationId 的采集走幂等账本（回放不重复下发）', async () => {
      const before = probe.state.commands.filter((c) => c.action === 'PAGE_FETCH').length;
      const a = await call('get_compass_search_words', { pages: 1, operationId: 'op-e2e-1' });
      const mid = probe.state.commands.filter((c) => c.action === 'PAGE_FETCH').length;
      const b = await call('get_compass_search_words', { pages: 1, operationId: 'op-e2e-1' });
      const after = probe.state.commands.filter((c) => c.action === 'PAGE_FETCH').length;
      assert.strictEqual(a.success, true);
      assert.strictEqual(a.replayed, false);
      assert.strictEqual(b.replayed, true);
      assert(after === mid, '回放不得二次下发采集指令');
      assert(mid > before, '首次必须真实下发');
    });

    await checkAsync('同 operationId 改参数 → 43009', async () => {
      const env = await call('get_compass_search_words', { pages: 2, operationId: 'op-e2e-1' });
      assert.strictEqual(env.error.code, 43009);
    });

    await checkAsync('meta.list_operations 可对账到采集记录', async () => {
      const env = await call('meta.list_operations', { operationIds: ['op-e2e-1'] });
      assert.strictEqual(env.data.available, true);
      assert.strictEqual(env.data.total, 1);
      assert.strictEqual(env.data.operations[0].scope, 'compass');
    });

    await checkAsync('探针断连后语义工具明确 50001 offline（不伪造在线）', async () => {
      probe.close();
      await waitUntil(async () => true);
      await new Promise((r) => setTimeout(r, 150));
      const env = await call('get_compass_product_rank', { rankType: '总榜' });
      assert.strictEqual(env.success, false);
      assert.strictEqual(env.error.code, 50001);
      assert(/探针|未连接|MV3/.test(env.error.message));
    });
  } finally {
    probe.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n[e2e-smoke] ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`  - ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('[e2e-smoke] 崩溃:', e); process.exitCode = 1; });
