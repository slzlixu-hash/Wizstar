'use strict';

/**
 * 规范验收测试（MAF 架构下 MCP 服务开发规范 V1.0 第 6 章 checklist）：
 *
 *  1. GET /healthz 返回 200 且 <50ms；
 *  2. 缺签名 / 错签名 → HTTP 401 + 41001；
 *  3. tools/list 暴露的语义工具 ≤10，且每个工具都带 x-risk；
 *  4. 同一 operationId 连调两次写操作：第二次 replayed=true 且上游调用次数不变；
 *  5. 同 operationId 改任一参数 → 43009；
 *  6. 上游超时/限流时信封结构正确、error.retryable 符合预期。
 *
 * 全部走离线 mock 适配器 + 内存账本，不启动 Chrome、不访问网络。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createMockAdapter } from '../src/adapters/mock.js';
import { createAuth, signRequest } from '../src/http/auth.js';
import { createHttpServer } from '../src/http/server.js';
import { openLedger } from '../src/ledger/db.js';
import { createCredentialRegistry } from '../src/security/credentials.js';

const KEY_ID = 'test-key';
const SECRET = 'test-secret-please-rotate';
const SHOP = { appId: 'app-test', appSecret: 'shop-secret-demo', shopId: 'shop-01' };
const SHOP_KEY = `${SHOP.appId}:${SHOP.shopId}`;
const SHOP_HEADER = Buffer.from(JSON.stringify(SHOP), 'utf8').toString('base64url');

let instance;
let adapters;
let ledger;
let credentials;
let baseUrl;

before(async () => {
  adapters = createMockAdapter();
  ledger = openLedger({ path: ':memory:' });
  credentials = createCredentialRegistry({ ttlSec: 300 });
  // 契约测试要验证「缺签/错签 → 401」，必须关闭回环豁免，否则 127.0.0.1 请求被免签放行
  const auth = createAuth({ keys: { [KEY_ID]: SECRET }, toleranceSec: 300, nonceTtlSec: 600, loopbackBypass: false });
  instance = createHttpServer({ adapters, ledger, credentials, auth });
  const addr = await instance.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await instance?.close();
  ledger?.close();
});

/** 构造签名请求；可以故意破坏签名/复用 nonce */
function signedFetch(bodyText, { keyId = KEY_ID, secret = SECRET, ts, nonce, extraHeaders = {}, path = '/mcp' } = {}) {
  const authorization = signRequest({ secret, keyId, method: 'POST', path, rawBody: bodyText, ts, nonce });
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      authorization,
      ...extraHeaders,
    },
    body: bodyText,
  });
}

let rpcId = 0;
async function rpc(method, params, opts = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method, params: params ?? {} });
  const res = await signedFetch(body, opts);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, json, text, body };
}

/** 从 tools/call 结果里取出统一信封（content[0].text 与 structuredContent 应一致） */
function envelopeOf(rpcResult) {
  const r = rpcResult?.json?.result;
  assert.ok(r, '响应里必须包含 result');
  const fromText = JSON.parse(r.content[0].text);
  if (r.structuredContent) assert.deepEqual(r.structuredContent, fromText, 'structuredContent 必须与 content 信封一致');
  return { env: fromText, raw: r };
}

async function initialize() {
  const r = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'contract-test', version: '1.0.0' },
  });
  assert.equal(r.res.status, 200, r.text);
  assert.equal(r.json.result.serverInfo.name, 'mcp-1688');
  assert.equal(r.json.result.protocolVersion, '2025-06-18');
}

async function callTool(name, args, opts = {}) {
  return rpc('tools/call', { name, arguments: args }, opts);
}

const OP_ID = 'op-task001-step02-1a2b3c4d5e6f7788';

test('1) GET /healthz 免鉴权、200、<50ms', async () => {
  // 先预热一次（首个请求包含 TCP 握手/路由初始化）
  await fetch(`${baseUrl}/healthz`);
  const samples = [];
  for (let i = 0; i < 10; i += 1) {
    const t0 = process.hrtime.bigint();
    const res = await fetch(`${baseUrl}/healthz`);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.server.name, 'mcp-1688');
    samples.push(ms);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length / 2)];
  assert.ok(p50 < 50, `healthz 中位延迟应 <50ms，实测 ${p50.toFixed(2)}ms（样本 ${samples.map((n) => n.toFixed(1)).join(',')}）`);
});

test('2) 缺签名 / 错签名 → 401 + 41001；nonce 重放 → 401 + 41009', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

  const anonymous = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body,
  });
  assert.equal(anonymous.status, 401);
  const a = await anonymous.json();
  assert.equal(a.error.code, 41001);

  const wrong = await signedFetch(body, { secret: 'wrong-secret' });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, 41001);

  const nonce = 'replay-nonce-0001';
  const first = await signedFetch(body, { nonce });
  assert.equal(first.status, 200);
  const second = await signedFetch(body, { nonce });
  assert.equal(second.status, 401);
  assert.equal((await second.json()).error.code, 41009);
});

test('3) tools/list：语义工具 ≤10、默认隐藏通用工具、每个工具都带 x-risk', async () => {
  await initialize();

  const list = await rpc('tools/list', {});
  assert.equal(list.res.status, 200, list.text);
  const tools = list.json.result.tools;
  assert.ok(Array.isArray(tools) && tools.length > 0);

  const semantic = tools.filter((t) => t._meta?.tier === 'semantic');
  assert.ok(semantic.length <= 8, `语义工具应 ≤8，实际 ${semantic.length}`);
  assert.ok(tools.length <= 10, `默认 tools/list 应 ≤10 条，实际 ${tools.length}`);

  const names = tools.map((t) => t.name);
  assert.ok(names.includes('meta.health') && names.includes('meta.describe') && names.includes('meta.list_operations'));
  assert.ok(names.includes('search_products') && names.includes('publish_sourcing_order'));
  assert.ok(!names.some((n) => n.startsWith('1688.')), '通用原子工具默认必须对 LLM 隐身');

  for (const t of tools) {
    assert.ok(['read', 'write', 'irreversible'].includes(t['x-risk']), `${t.name} 缺少合法 x-risk`);
    assert.equal(t.inputSchema['x-risk'], t['x-risk'], `${t.name} 的 inputSchema 里也应带 x-risk`);
    assert.equal(t._meta['x-risk'], t['x-risk']);
  }
  assert.equal(tools.find((t) => t.name === 'publish_sourcing_order')['x-risk'], 'irreversible');

  // JIT 动态挂载：显式请求时才暴露底层原子工具
  const extended = await rpc('tools/list', {}, { extraHeaders: { 'x-mcp-include-generic': '1' } });
  const extendedNames = extended.json.result.tools.map((t) => t.name);
  assert.ok(extendedNames.includes('1688.offer.search'));
  assert.ok(extendedNames.includes('1688.order.submit'));
});

test('3b) filter_suppliers：MAF 下发的筛选面板条件可直接执行', async () => {
  await initialize();
  adapters.reset();

  // 1. 预设策略 + 面板中文条件（MAF 原样透传的样子）
  const relaxed = await callTool('filter_suppliers', {
    preset: 'default_price',
    filters: { 发货时效: '48小时发货', 揽收率: '24小时揽收率≥95%', 退款率: '总退款率≤3%', 增值服务: ['支持一件代发', '支持抖音密文打单'] },
  });
  const relaxedEnv = envelopeOf(relaxed).env;
  assert.equal(relaxedEnv.success, true, JSON.stringify(relaxedEnv.error));
  assert.equal(relaxedEnv.data.preset, 'default_price');
  assert.deepEqual(relaxedEnv.data.filters.shipping, { maxHours: 48 });
  assert.deepEqual(relaxedEnv.data.filters.collection, { windowHours: 24, minRate: 0.95 });
  assert.deepEqual(relaxedEnv.data.filters.refund, { kind: 'total', maxRate: 0.03 });
  assert.deepEqual(relaxedEnv.data.stats, { candidates: 3, matched: 2, rejected: 1 });
  assert.deepEqual(
    relaxedEnv.data.matched.map((m) => m.offerId),
    ['674199987929', '674199987930'],
  );
  assert.equal(relaxedEnv.data.rejected[0].offerId, '674199987931');
  assert.ok(relaxedEnv.data.rejected[0].reasons.some((r) => r.code === 'collection_rate_low'));

  // 2. 严格策略 + 只给 offerIds（适配指定货源池）
  const strict = await callTool('filter_suppliers', {
    preset: 'priority_quality',
    offerIds: ['674199987929', '674199987930', '674199987931'],
  });
  const strictEnv = envelopeOf(strict).env;
  assert.equal(strictEnv.success, true, JSON.stringify(strictEnv.error));
  assert.deepEqual(strictEnv.data.stats, { candidates: 3, matched: 1, rejected: 2 });

  // 3. MAF 传了不认识的条件时不能静默放过
  const bad = await callTool('filter_suppliers', { filters: { 履约质量: '综合体验分 4.2星' } });
  const badEnv = envelopeOf(bad).env;
  assert.equal(badEnv.success, false);
  assert.equal(badEnv.error.code, 40001);

  // 4. 既没 preset 也没 filters、既没 keywords 也没 offerIds → 40001
  const empty = await callTool('filter_suppliers', {});
  assert.equal(envelopeOf(empty).env.error.code, 40001);
});

test('4) 同一 operationId 重放：replayed=true 且上游调用次数不变', async () => {
  adapters.reset();
  const args = { operationId: OP_ID, offerId: '674199987929', quantity: 120, targetPriceCents: 270, note: '对比后选它' };

  const first = await callTool('save_sourcing_draft', args, { extraHeaders: { 'x-shop-credential': SHOP_HEADER } });
  const firstEnv = envelopeOf(first).env;
  assert.equal(firstEnv.success, true, JSON.stringify(firstEnv.error));
  assert.equal(firstEnv.replayed, false);
  assert.equal(adapters.calls.saveDraft, 1);

  const second = await callTool('save_sourcing_draft', args, { extraHeaders: { 'x-shop-credential': SHOP_HEADER } });
  const secondEnv = envelopeOf(second).env;
  assert.equal(secondEnv.success, true);
  assert.equal(secondEnv.replayed, true);
  assert.deepEqual(secondEnv.data, firstEnv.data, '回放结果必须与首次一致');
  assert.equal(adapters.calls.saveDraft, 1, '回放不得二次调用上游');

  // 账本里能查到这条操作，供 meta.list_operations 对账
  const listed = await callTool(
    'meta.list_operations',
    { operationIds: [OP_ID] },
    { extraHeaders: { 'x-shop-credential': SHOP_HEADER } },
  );
  const listEnv = envelopeOf(listed).env;
  assert.equal(listEnv.success, true);
  assert.equal(listEnv.data.total, 1);
  assert.equal(listEnv.data.operations[0].status, 'SUCCEEDED');
  assert.equal(listEnv.data.operations[0].operationId, OP_ID);
});

test('5) 同 operationId 改参数 → 43009 幂等冲突', async () => {
  const base = { operationId: OP_ID, offerId: '674199987929', quantity: 120 };
  const tampered = await callTool('save_sourcing_draft', { ...base, quantity: 121 }, {
    extraHeaders: { 'x-shop-credential': SHOP_HEADER },
  });
  const env = envelopeOf(tampered).env;
  assert.equal(env.success, false);
  assert.equal(env.error.code, 43009);
  assert.equal(env.error.category, 'idempotency_conflict');
});

test('6) 上游超时/限流 → 50001/42001，格式与 retryable 正确', async () => {
  const timeoutErr = new Error('page.goto: Timeout 30000ms exceeded.');
  timeoutErr.name = 'TimeoutError';
  adapters.failNext('searchOffers', timeoutErr);
  const timeout = await callTool('search_products', { query: '艾草防臭鞋垫' });
  const tEnv = envelopeOf(timeout).env;
  assert.equal(tEnv.success, false);
  assert.equal(tEnv.error.code, 50001);
  assert.equal(tEnv.error.retryable, true);
  assert.ok(tEnv.server && Number.isFinite(tEnv.server.elapsedMs));
  assert.ok(typeof tEnv.traceId === 'string' && tEnv.traceId.length > 0);

  adapters.failNext('searchOffers', new Error('HTTP 429 Too Many Requests（上游限流）'));
  const limited = await callTool('search_products', { query: '艾草防臭鞋垫' });
  const lEnv = envelopeOf(limited).env;
  assert.equal(lEnv.error.code, 42001);
  assert.equal(lEnv.error.retryable, true);

  adapters.failNext('searchOffers', new Error('quota exceeded：今日调用配额已用完'));
  const quota = await callTool('search_products', { query: '艾草防臭鞋垫' });
  const qEnv = envelopeOf(quota).env;
  assert.equal(qEnv.error.code, 42002);
  assert.equal(qEnv.error.retryable, false);

  // 可重试失败后，平台可用同一 operationId 重试（不算回放终态）
  const retryOp = 'op-task002-step01-99aa88bb77cc6655';
  adapters.failNext('saveDraft', timeoutErr);
  const failed = await callTool(
    'save_sourcing_draft',
    { operationId: retryOp, offerId: '674199987929', quantity: 5 },
    { extraHeaders: { 'x-shop-credential': SHOP_HEADER } },
  );
  assert.equal(envelopeOf(failed).env.error.code, 50001);
  const retried = await callTool(
    'save_sourcing_draft',
    { operationId: retryOp, offerId: '674199987929', quantity: 5 },
    { extraHeaders: { 'x-shop-credential': SHOP_HEADER } },
  );
  const rEnv = envelopeOf(retried).env;
  assert.equal(rEnv.success, true, '可重试失败后同一 operationId 应真的重试而不是回放失败');
  assert.equal(rEnv.replayed, false);
});

test('7) 写操作缺凭证/缺 operationId → 41001/40001', async () => {
  const noCred = await callTool('save_sourcing_draft', { operationId: 'op-task003-step01-deadbeefdeadbeef', offerId: '674199987929' });
  const noCredEnv = envelopeOf(noCred).env;
  assert.equal(noCredEnv.success, false);
  assert.equal(noCredEnv.error.code, 41001);

  const noOp = await callTool('save_sourcing_draft', { offerId: '674199987929' }, {
    extraHeaders: { 'x-shop-credential': SHOP_HEADER },
  });
  const noOpEnv = envelopeOf(noOp).env;
  assert.equal(noOpEnv.success, false);
  assert.equal(noOpEnv.error.code, 40001);

  // 凭证放在参数体里必须被拒（40001），绝不允许落进日志/Prompt
  const inBody = await callTool(
    'save_sourcing_draft',
    { operationId: 'op-task003-step02-deadbeefdeadbeef', offerId: '674199987929', appSecret: 'oops' },
    { extraHeaders: { 'x-shop-credential': SHOP_HEADER } },
  );
  assert.equal(envelopeOf(inBody).env.error.code, 40001);
});

test('8) 只读工具返回统一信封；不可逆工具未确认时按业务拒绝 43010', async () => {
  adapters.reset();
  const search = await callTool('search_products', { query: '艾草防臭鞋垫', max: 3 });
  const env = envelopeOf(search).env;
  assert.equal(env.success, true);
  assert.equal(env.server.name, 'mcp-1688');
  assert.equal(env.server.version, '1.0.0');
  assert.ok(Array.isArray(env.data.offers));
  assert.equal(env.usage.unit, 'call');
  assert.equal(env.usage.quantity, 1);

  const order = await callTool(
    'publish_sourcing_order',
    {
      operationId: 'op-task004-step01-0011223344556677',
      offerId: '674199987929',
      quantity: 100,
      priceCents: 280,
      confirm: false,
    },
    { extraHeaders: { 'x-shop-credential': SHOP_HEADER } },
  );
  const orderEnv = envelopeOf(order).env;
  assert.equal(orderEnv.success, false);
  assert.equal(orderEnv.error.code, 43010);
  assert.equal(orderEnv.error.retryable, false);
});
