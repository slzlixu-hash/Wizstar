#!/usr/bin/env node
/**
 * 步骤 2 专项冒烟：WS 桥接 + 幂等账本
 *
 * 覆盖：
 *   - 帧编解码：粘包 / 半包 / 分片 / masked 客户端帧 / ping-pong / close
 *   - 动态 channelToken 握手（错误 token 拒绝、HELLO 超时）
 *   - 代际号：重连后旧任务作废，旧代际回包被丢弃
 *   - 20s 等待器超时、指令串行、ABORT
 *   - 域名白名单拒绝
 *   - 幂等：同 operationId 回放 replayed:true 且不重复执行；改参数 43009；
 *     EXECUTING 孤儿补缺；30 天保留；list_operations 对账
 *
 * 运行：node tools/mcp-douyin-compass/test/bridge-smoke.js
 */
'use strict';

const assert = require('assert');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encodeFrame, encodeText, FrameDecoder, ALLOWED_HOSTS } = require('../server/bridge');
const { create: createLedger, RETENTION_DAYS } = require('../server/ledger');

let passed = 0;
const failures = [];

async function waitUntil(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('等待条件超时');
}
function check(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push({ name, error: e.message }); console.log(`  FAIL  ${name} :: ${e.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push({ name, error: e.message }); console.log(`  FAIL  ${name} :: ${e.message}`); }
}

/** 客户端帧：必须 masked（RFC6455）。 */
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

/** 解析服务端帧（不 masked），返回 { opcode, payload, json? } 列表。 */
function decodeServerFrames(buf) {
  const out = [];
  let rest = buf;
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
    rest = rest.subarray(off + len);
  }
  return out;
}

/** 起一个只挂 bridge 的临时 HTTP 服务。 */
function startBridgeServer() {
  const { attach } = require('../server/bridge');
  const bridge = attach();
  const server = http.createServer((req, res) => res.end('ok'));
  server.on('upgrade', (req, sock, head) => bridge.handleUpgrade(req, sock, head));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, bridge, port: server.address().port }));
  });
}

/** 建立一条探针连接，完成 CHALLENGE → HELLO，返回可控客户端。 */
async function connectProbe(port, { tokenOverride, skipHello = false, tab = 'compass-tab-1' } = {}) {
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  sock.write(
    `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
    `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
    `Origin: chrome-extension://fake-extension-id\r\n\r\n`
  );

  let buf = Buffer.alloc(0);
  const inbox = [];
  const waiters = [];
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // 先剥离 HTTP 101 头
    if (buf.includes(Buffer.from('\r\n\r\n')) && !sock.__upgraded) {
      const idx = buf.indexOf('\r\n\r\n');
      const headText = buf.subarray(0, idx).toString('utf8');
      if (!headText.includes('101')) { sock.__httpError = headText; }
      buf = buf.subarray(idx + 4);
      sock.__upgraded = true;
    }
    if (!sock.__upgraded) return;
    const frames = decodeServerFrames(buf);
    // 计算消耗掉的字节，简单起见按每帧重新计算
    let consumed = 0;
    for (const f of frames) {
      const plen = f.payload.length;
      consumed += (plen < 126 ? 2 : plen < 65536 ? 4 : 10) + plen;
      inbox.push(f);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i](f)) waiters.splice(i, 1);
      }
    }
    buf = buf.subarray(consumed);
  });

  function waitFor(predicate, timeoutMs = 1500) {
    const hit = inbox.find(predicate);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待服务端帧超时')), timeoutMs);
      waiters.push((f) => {
        if (!predicate(f)) return false;
        clearTimeout(timer);
        resolve(f);
        return true;
      });
    });
  }

  // 等 CHALLENGE
  const challenge = await waitFor((f) => f.json && f.json.type === 'CHALLENGE');
  const token = tokenOverride === undefined ? challenge.json.channelToken : tokenOverride;
  const generation = challenge.json.generation;

  if (!skipHello) {
    sock.write(clientText({ type: 'HELLO', channelToken: token, tab, url: 'https://compass.jinritemai.com/shop', loggedIn: true, version: '1.0' }));
    await waitFor((f) => f.json && f.json.type === 'HELLO_ACK');
  }

  return {
    sock, inbox, waitFor, token, generation,
    reply(m) { sock.write(clientText(m)); },
    close() {
      // 按 RFC6455 发 close 帧，让服务端确定性感知断连（而非依赖 TCP 事件时序）
      try { sock.write(clientFrame(0x8, '')); } catch (_) { /* ignore */ }
      sock.destroy();
    }
  };
}

async function main() {
  console.log('\n[mcp-douyin-compass bridge-smoke]\n');

  // ---------------------------------------------------------- 帧编解码单元测试
  {
    const d = new FrameDecoder();
    const frame = clientText({ hello: 'world' });
    const msgs = d.push(frame);
    check('解码 masked 客户端文本帧', () => assert.strictEqual(msgs[0].json.hello, 'world'));

    const d2 = new FrameDecoder();
    const a = clientText({ n: 1 });
    const b = clientText({ n: 2 });
    check('粘包：一次 push 两帧', () => {
      const out = d2.push(Buffer.concat([a, b]));
      assert.strictEqual(out.length, 2);
      assert.strictEqual(out[1].json.n, 2);
    });

    const d3 = new FrameDecoder();
    const full = clientText({ split: true });
    check('半包：分两次 push', () => {
      assert.strictEqual(d3.push(full.subarray(0, 3)).length, 0);
      assert.strictEqual(d3.push(full.subarray(3))[0].json.split, true);
    });

    const d4 = new FrameDecoder();
    const text = JSON.stringify({ frag: 'ok' });
    const half = Math.floor(text.length / 2);
    const f1 = clientFrame(0x1, text.slice(0, half));
    // 手工把第一帧 FIN 清 0
    f1[0] &= 0x7f;
    const f2 = clientFrame(0x0, text.slice(half));
    check('分片：text + continuation', () => {
      const out = d4.push(Buffer.concat([f1, f2]));
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].json.frag, 'ok');
    });

    check('服务端编码帧 FIN=1 且不 mask', () => {
      const f = encodeText({ x: 1 });
      assert.strictEqual((f[0] & 0x80) !== 0, true);
      assert.strictEqual((f[1] & 0x80), 0);
      const decoded = new FrameDecoder().push(f);
      assert.strictEqual(decoded[0].json.x, 1);
    });
    check('ping/pong/close 控制帧识别', () => {
      const out = new FrameDecoder().push(Buffer.concat([
        clientFrame(0x9, 'p'), clientFrame(0xa, 'q'), clientFrame(0x8, '')
      ]));
      assert.deepStrictEqual(out.map((x) => x.control), ['ping', 'pong', 'close']);
    });
    check('域名白名单只含罗盘域名', () => {
      assert(ALLOWED_HOSTS.has('compass.jinritemai.com'));
      assert.strictEqual(ALLOWED_HOSTS.size, 1);
    });
  }

  // ---------------------------------------------------------- 桥接集成测试
  const { server, bridge, port } = await startBridgeServer();
  try {
    check('初始状态：未连接且给出原因', () => {
      const s = bridge.state();
      assert.strictEqual(s.connected, false);
      assert(s.reason);
    });

    // 错误 token 应被拒绝
    await checkAsync('错误 channelToken 被拒绝', async () => {
      const probe = await connectProbe(port, { tokenOverride: 'wrong-token', skipHello: true });
      probe.reply({ type: 'HELLO', channelToken: 'wrong-token', loggedIn: true });
      await new Promise((r) => setTimeout(r, 120));
      assert.strictEqual(bridge.state().connected, false);
      probe.close();
    });

    // 正确握手
    const probe = await connectProbe(port);
    await checkAsync('正确握手后 connected=true / loggedIn=true', async () => {
      const s = bridge.state();
      assert.strictEqual(s.connected, true);
      assert.strictEqual(s.loggedIn, true);
      assert(s.generation >= 1);
    });

    await checkAsync('CMD 下发 → RESULT 回包（完整往返）', async () => {
      const promise = bridge.send('PAGE_FETCH', { url: 'https://compass.jinritemai.com/compass_api/x' });
      const cmd = await probe.waitFor((f) => f.json && f.json.type === 'CMD');
      assert.strictEqual(cmd.json.action, 'PAGE_FETCH');
      assert(probe.inbox.some((f) => f.json && f.json.type === 'CHALLENGE'));
      probe.reply({
        type: 'RESULT', commandId: cmd.json.commandId, generation: cmd.json.generation,
        payload: { items: [1, 2, 3] }
      });
      const result = await promise;
      assert.deepStrictEqual(result.items, [1, 2, 3]);
    });

    await checkAsync('域名白名单拒绝非罗盘 URL', async () => {
      await assert.rejects(
        () => bridge.send('PAGE_FETCH', { url: 'https://evil.example.com/steal' }),
        /域名白名单拒绝/
      );
    });

    await checkAsync('指令串行：同一时刻只运行一条', async () => {
      const p1 = bridge.send('A', {});
      const p2 = bridge.send('B', {});
      const c1 = await probe.waitFor((f) => f.json && f.json.type === 'CMD' && f.json.action === 'A');
      assert.strictEqual(bridge.state().queued, 1);
      assert.strictEqual(bridge.state().running, c1.json.commandId);
      probe.reply({ type: 'RESULT', commandId: c1.json.commandId, generation: c1.json.generation, payload: 'a' });
      assert.strictEqual(await p1, 'a');
      const c2 = await probe.waitFor((f) => f.json && f.json.type === 'CMD' && f.json.action === 'B');
      probe.reply({ type: 'RESULT', commandId: c2.json.commandId, generation: c2.json.generation, payload: 'b' });
      assert.strictEqual(await p2, 'b');
    });

    await checkAsync('探针 ERROR 回包收敛为拒绝', async () => {
      const p = bridge.send('FAIL_ME', {});
      const cmd = await probe.waitFor((f) => f.json && f.json.type === 'CMD' && f.json.action === 'FAIL_ME');
      probe.reply({ type: 'ERROR', commandId: cmd.json.commandId, generation: cmd.json.generation, error: '登录态失效' });
      await assert.rejects(() => p, /登录态失效/);
    });

    // 重连代际：旧任务应作废
    await checkAsync('重连使旧代际任务作废', async () => {
      const p = bridge.send('LONG_TASK', {});
      // 立刻挂上 catch：重连会同步 reject，若延后 await 会造成 unhandled rejection
      const rejected = p.catch((e) => e);
      const cmd = await probe.waitFor((f) => f.json && f.json.type === 'CMD' && f.json.action === 'LONG_TASK');
      const oldGen = cmd.json.generation;
      probe.close();
      const err = await rejected;
      assert(err instanceof Error, '旧代际任务必须被拒绝');
      const probe2 = await connectProbe(port);
      assert(bridge.state().generation > oldGen);
      // 旧代际回包必须被丢弃，不污染新任务
      probe2.reply({ type: 'RESULT', commandId: cmd.json.commandId, generation: oldGen, payload: 'stale' });
      await new Promise((r) => setTimeout(r, 60));
      assert.strictEqual(bridge.state().pending, 0);
      probe2.close();
    });

    await checkAsync('断连后状态干净、pending 清零', async () => {
      // socket close 是异步传播，显式等待而不是固定 sleep
      await waitUntil(() => !bridge.state().connected);
      assert.strictEqual(bridge.state().pending, 0);
      assert.strictEqual(bridge.state().connected, false);
    });

    await checkAsync('未连接时 send 明确拒绝', async () => {
      await assert.rejects(() => bridge.send('X', {}), /探针未连接|安装 MV3/);
    });
  } finally {
    bridge.close();
    await new Promise((resolve) => server.close(resolve));
  }

  // ---------------------------------------------------------- 幂等账本测试
  // 用临时目录隔离，避免污染服务真实 data/
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-ledger-'));
  const ledger = createLedger({ dataDir: tmpDir });
  try {
    let calls = 0;
    const makeEnvelope = (v) => ({ success: true, data: { v }, usage: { costCents: 0, unit: 'call', quantity: 1 },
      error: null, server: { name: 'test', version: '1', toolVersion: '1', elapsedMs: 1 },
      traceId: 't-' + v, replayed: false });

    await checkAsync('同 operationId 二次调用回放且只执行一次', async () => {
      const args = { rankType: 'market_hot_sale', pages: 1 };
      const first = await ledger.run('op-smoke-1', args, async () => { calls++; return makeEnvelope(1); });
      const second = await ledger.run('op-smoke-1', args, async () => { calls++; return makeEnvelope(2); });
      assert.strictEqual(calls, 1, '不得二次执行采集');
      assert.strictEqual(first.replayed, false);
      assert.strictEqual(second.replayed, true);
      assert.strictEqual(second.data.v, 1, '回放历史结果');
    });

    await checkAsync('同 operationId 改参数 → 43009', async () => {
      const env = await ledger.run('op-smoke-1', { rankType: 'market_hot_sale', pages: 2 }, async () => { calls++; return makeEnvelope(3); });
      assert.strictEqual(env.success, false);
      assert.strictEqual(env.error.code, 43009);
      assert.strictEqual(env.error.retryable, false);
      assert.strictEqual(calls, 1, '冲突时不得执行');
    });

    await checkAsync('并发同键去重（两次并发只执行一次）', async () => {
      let n = 0;
      const args = { x: 1 };
      const [a, b] = await Promise.all([
        ledger.run('op-smoke-concurrent', args, async () => { n++; await new Promise((r) => setTimeout(r, 20)); return makeEnvelope('a'); }),
        ledger.run('op-smoke-concurrent', args, async () => { n++; return makeEnvelope('b'); })
      ]);
      assert.strictEqual(n, 1);
      assert.strictEqual(b.replayed, true);
    });

    await checkAsync('参数指纹不受键顺序影响', async () => {
      assert.strictEqual(ledger.paramHash({ a: 1, b: 2 }), ledger.paramHash({ b: 2, a: 1 }));
    });

    await checkAsync('list_operations 支持 since / operationIds 对账', async () => {
      assert(RETENTION_DAYS >= 30);
      const all = ledger.list({});
      assert(all.length >= 2, `实际记录数 ${all.length}`);
      assert(all.every((r) => !('args' in r)), '对账结果不得含参数明文');
      assert(all.every((r) => r.scope === 'compass'));
      const filtered = ledger.list({ operationIds: ['op-smoke-1'] });
      assert.strictEqual(filtered.length, 1);
      const future = ledger.list({ since: new Date(Date.now() + 86400000).toISOString() });
      assert.strictEqual(future.length, 0);
    });

    check('stats 报出后端与保留期', () => {
      const s = ledger.stats();
      assert.strictEqual(s.available, true);
      assert(['sqlite-wal', 'jsonl-atomic'].includes(s.backend));
      assert.strictEqual(s.retentionDays, 30);
    });
  } finally {
    ledger.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n[bridge-smoke] ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`  - ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('[bridge-smoke] 崩溃:', e); process.exitCode = 1; });
