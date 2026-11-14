'use strict';

/**
 * 幂等账本单测（对应规范第 4 章 / 第 7 章「幂等回放」「参数防篡改」）。
 *
 * 用 :memory: 覆盖状态机与查询语义，用 mkdtemp 覆盖真实文件 + WAL 持久化。
 * 全部注入时钟，不依赖真实时间。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLedger } from '../../src/ledger/db.js';

const T0 = 1_700_000_000_000; // 固定起点，避免测试随真实时间漂移
const DAY = 24 * 60 * 60 * 1000;
const SHOP = 'app-1688:shop-001';

/** 可手动推进的时钟 */
function makeClock(start = T0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
      return t;
    },
    set: (ms) => {
      t = ms;
      return t;
    },
  };
}

function assertContractError(fn, code, messageRe) {
  assert.throws(fn, (e) => {
    assert.equal(e.name, 'ContractError');
    assert.equal(e.code, code);
    if (messageRe) assert.match(e.message, messageRe);
    return true;
  });
}

test('openLedger：path 只读、new 记录各字段正确', () => {
  const clock = makeClock();
  const ledger = openLedger({ path: ':memory:', now: clock.now });
  try {
    assert.equal(ledger.path, ':memory:');
    assert.throws(() => {
      ledger.path = 'other.db';
    }, TypeError);

    const result = ledger.begin({
      shopKey: SHOP,
      operationId: 'op-taskA-step1-abc123',
      tool: 'publish_product',
      paramsHash: 'hash-a',
      paramsJson: '{"title":"测试商品"}',
      traceId: 'trace-1',
    });
    assert.deepEqual(result, { state: 'new' });
    assert.equal(ledger.count(), 1);

    const record = ledger.get(SHOP, 'op-taskA-step1-abc123');
    assert.equal(record.shopKey, SHOP);
    assert.equal(record.operationId, 'op-taskA-step1-abc123');
    assert.equal(record.tool, 'publish_product');
    assert.equal(record.paramsHash, 'hash-a');
    assert.equal(record.paramsJson, '{"title":"测试商品"}');
    assert.equal(record.status, 'EXECUTING');
    assert.equal(record.result, null);
    assert.equal(record.error, null);
    assert.equal(record.traceId, 'trace-1');
    assert.equal(record.createdAt, T0);
    assert.equal(record.updatedAt, T0);
  } finally {
    ledger.close();
  }
});

test('begin：同参数 EXECUTING 返回 in_progress，完成/失败后返回 replay', () => {
  const clock = makeClock();
  const ledger = openLedger({ path: ':memory:', now: clock.now });
  const key = { shopKey: SHOP, operationId: 'op-1' };
  try {
    assert.equal(ledger.begin({ ...key, tool: 't', paramsHash: 'h1', paramsJson: '{"a":1}' }).state, 'new');

    // 上一次还在执行：绝不能重复调用上游
    clock.advance(10);
    const inProgress = ledger.begin({ ...key, tool: 't', paramsHash: 'h1', paramsJson: '{"a":1}' });
    assert.equal(inProgress.state, 'in_progress');
    assert.equal(inProgress.record.status, 'EXECUTING');

    // 成功 → SUCCEEDED，再调用回放结果
    clock.advance(10);
    ledger.complete({ ...key, result: { productId: '10002341', auditStatus: 1 } });
    const afterComplete = ledger.get(SHOP, 'op-1');
    assert.equal(afterComplete.status, 'SUCCEEDED');
    assert.deepEqual(afterComplete.result, { productId: '10002341', auditStatus: 1 });
    assert.equal(afterComplete.updatedAt, T0 + 20);
    assert.equal(afterComplete.createdAt, T0);

    const replay = ledger.begin({ ...key, tool: 't', paramsHash: 'h1' });
    assert.equal(replay.state, 'replay');
    assert.deepEqual(replay.record.result, { productId: '10002341', auditStatus: 1 });
    assert.equal(replay.record.status, 'SUCCEEDED');
  } finally {
    ledger.close();
  }
});

test('begin：同 operationId 改参数返回 tampered（43009 的判定依据）', () => {
  const clock = makeClock();
  const ledger = openLedger({ path: ':memory:', now: clock.now });
  const key = { shopKey: SHOP, operationId: 'op-tamper' };
  try {
    ledger.begin({ ...key, tool: 'publish_product', paramsHash: 'hash-original', paramsJson: '{"price":1}' });
    const tampered = ledger.begin({ ...key, tool: 'publish_product', paramsHash: 'hash-changed', paramsJson: '{"price":2}' });
    assert.equal(tampered.state, 'tampered');
    // 原始记录保持不变，便于平台对账
    assert.equal(tampered.record.paramsHash, 'hash-original');
    assert.equal(tampered.record.paramsJson, '{"price":1}');
    assert.equal(ledger.count(), 1);

    // 成功之后改参数同样是 tampered
    ledger.complete({ ...key, result: { ok: true } });
    assert.equal(ledger.begin({ ...key, paramsHash: 'hash-changed' }).state, 'tampered');
  } finally {
    ledger.close();
  }
});

test('fail：错误快照可回放，状态为 FAILED', () => {
  const clock = makeClock();
  const ledger = openLedger({ path: ':memory:', now: clock.now });
  const key = { shopKey: SHOP, operationId: 'op-fail' };
  try {
    ledger.begin({ ...key, tool: 't', paramsHash: 'h-fail', traceId: 'trace-f' });
    clock.advance(5);
    ledger.fail({ ...key, error: { code: 50001, message: '上游网络异常', retryable: true } });

    const record = ledger.get(SHOP, 'op-fail');
    assert.equal(record.status, 'FAILED');
    assert.equal(record.traceId, 'trace-f', '未显式传 traceId 时应保留原值');
    assert.deepEqual(record.error, { code: 50001, message: '上游网络异常', retryable: true });

    const replay = ledger.begin({ ...key, paramsHash: 'h-fail' });
    assert.equal(replay.state, 'replay');
    assert.deepEqual(replay.record.error, { code: 50001, message: '上游网络异常', retryable: true });

    // 重新执行时传新 traceId 会覆盖
    ledger.fail({ ...key, error: { code: 43010 }, traceId: 'trace-new' });
    assert.equal(ledger.get(SHOP, 'op-fail').traceId, 'trace-new');
  } finally {
    ledger.close();
  }
});

test('get/complete/fail：不存在或非法的入参按契约处理', () => {
  const ledger = openLedger({ path: ':memory:' });
  try {
    assert.equal(ledger.get(SHOP, 'never-exists'), null);
    assert.equal(ledger.get(SHOP, ''), null);
    // 对不存在的行 complete/fail 静默 no-op（可能已被保留期清理）
    assert.doesNotThrow(() => ledger.complete({ shopKey: SHOP, operationId: 'not-there', result: { ok: 1 } }));
    assert.doesNotThrow(() => ledger.fail({ shopKey: SHOP, operationId: 'not-there', error: { code: 1 } }));
    assert.equal(ledger.count(), 0);

    // 缺少 operationId / paramsHash / shopKey 一律 40001
    assertContractError(() => ledger.begin({ shopKey: SHOP, paramsHash: 'h' }), 40001, /operationId/);
    assertContractError(() => ledger.begin({ shopKey: SHOP, operationId: 'op-x' }), 40001, /paramsHash/);
    assertContractError(() => ledger.begin({ operationId: 'op-x', paramsHash: 'h' }), 40001, /shopKey/);
    assertContractError(() => ledger.list({ operationIds: ['op-x'] }), 40001, /shopKey/);
  } finally {
    ledger.close();
  }
});

test('json：result 为字符串/数字/中文时 JSON 往返一致', () => {
  const ledger = openLedger({ path: ':memory:' });
  try {
    const key = { shopKey: SHOP, paramsHash: 'h' };
    ledger.begin({ ...key, operationId: 'op-str' });
    ledger.complete({ shopKey: SHOP, operationId: 'op-str', result: '纯文本结果' });
    assert.equal(ledger.get(SHOP, 'op-str').result, '纯文本结果');

    ledger.begin({ ...key, operationId: 'op-num' });
    ledger.complete({ shopKey: SHOP, operationId: 'op-num', result: 0 });
    assert.equal(ledger.get(SHOP, 'op-num').result, 0);

    // paramsJson 传对象时按 JSON 文本落库
    ledger.begin({ shopKey: SHOP, operationId: 'op-obj', paramsHash: 'h-obj', paramsJson: { b: 2, a: '中文' } });
    assert.equal(ledger.get(SHOP, 'op-obj').paramsJson, JSON.stringify({ b: 2, a: '中文' }));
  } finally {
    ledger.close();
  }
});

test('店铺隔离：同一 operationId 在不同 shopKey 下互不影响', () => {
  const ledger = openLedger({ path: ':memory:' });
  try {
    const shopA = 'appA:shopA';
    const shopB = 'appB:shopB';
    assert.equal(ledger.begin({ shopKey: shopA, operationId: 'op-shared', paramsHash: 'h-a', paramsJson: '{"s":"A"}' }).state, 'new');
    assert.equal(ledger.begin({ shopKey: shopB, operationId: 'op-shared', paramsHash: 'h-b', paramsJson: '{"s":"B"}' }).state, 'new');
    assert.equal(ledger.count(), 2);
    assert.equal(ledger.count(shopA), 1);

    ledger.complete({ shopKey: shopA, operationId: 'op-shared', result: { shop: 'A' } });
    assert.equal(ledger.get(shopA, 'op-shared').status, 'SUCCEEDED');
    assert.equal(ledger.get(shopB, 'op-shared').status, 'EXECUTING');
    // B 店铺改自己的参数不受 A 影响
    assert.equal(ledger.begin({ shopKey: shopB, operationId: 'op-shared', paramsHash: 'h-b2' }).state, 'tampered');
    assert.equal(ledger.get(shopA, 'op-shared').status, 'SUCCEEDED');
  } finally {
    ledger.close();
  }
});

test('list：倒序 + since + operationIds + limit 组合过滤', () => {
  const clock = makeClock();
  const ledger = openLedger({ path: ':memory:', now: clock.now });
  const created = [];
  try {
    // 5 条记录，每条 created_at 间隔 1s
    for (let i = 0; i < 5; i += 1) {
      const operationId = `op-list-${i}`;
      ledger.begin({ shopKey: SHOP, operationId, tool: `tool-${i}`, paramsHash: `h-${i}` });
      ledger.complete({ shopKey: SHOP, operationId, result: { i } });
      created.push(clock.now());
      if (i < 4) clock.advance(1000);
    }

    const all = ledger.list({ shopKey: SHOP });
    assert.equal(all.length, 5);
    // 最新在前
    assert.deepEqual(
      all.map((r) => r.operationId),
      ['op-list-4', 'op-list-3', 'op-list-2', 'op-list-1', 'op-list-0'],
    );

    // since 含边界
    const since = ledger.list({ shopKey: SHOP, since: created[2] });
    assert.deepEqual(
      since.map((r) => r.operationId),
      ['op-list-4', 'op-list-3', 'op-list-2'],
    );

    // operationIds 过滤，忽略重复/非字符串
    const byIds = ledger.list({ shopKey: SHOP, operationIds: ['op-list-1', 'op-list-3', 'op-list-3', 42, ''] });
    assert.deepEqual(byIds.map((r) => r.operationId), ['op-list-3', 'op-list-1']);

    // 明确查 0 个 → 空数组
    assert.deepEqual(ledger.list({ shopKey: SHOP, operationIds: [] }), []);

    // limit 生效；非法 limit 退化为默认值；超过 500 被夹紧
    assert.equal(ledger.list({ shopKey: SHOP, limit: 2 }).length, 2);
    assert.equal(ledger.list({ shopKey: SHOP, limit: -1 }).length, 5);
    assert.equal(ledger.list({ shopKey: SHOP, limit: 99_999 }).length, 5);

    // 别的店铺查不到
    assert.deepEqual(ledger.list({ shopKey: 'other:shop' }), []);
  } finally {
    ledger.close();
  }
});

test('list：operationIds 超过 200 个时自动分批（不触发 SQLite 变量上限）', () => {
  const ledger = openLedger({ path: ':memory:' });
  try {
    for (let i = 0; i < 3; i += 1) {
      ledger.begin({ shopKey: SHOP, operationId: `op-chunk-${i}`, paramsHash: `h-${i}` });
    }
    // 260 个 id：3 个命中 + 257 个噪声，跨越两个 IN 批次
    const ids = ['op-chunk-0', 'op-chunk-1', 'op-chunk-2'];
    for (let i = 0; i < 257; i += 1) ids.push(`noise-${i}`);
    assert.equal(ids.length, 260);

    const found = ledger.list({ shopKey: SHOP, operationIds: ids });
    assert.deepEqual(found.map((r) => r.operationId).sort(), ['op-chunk-0', 'op-chunk-1', 'op-chunk-2']);

    // 带 since 的分批路径也要能跑
    const withSince = ledger.list({ shopKey: SHOP, operationIds: ids, since: 0 });
    assert.equal(withSince.length, 3);
    const future = ledger.list({ shopKey: SHOP, operationIds: ids, since: Date.now() + 1_000_000 });
    assert.deepEqual(future, []);
  } finally {
    ledger.close();
  }
});

test('cleanup：按保留期删除旧行并返回删除数', () => {
  const clock = makeClock();
  const ledger = openLedger({ path: ':memory:', retentionDays: 30, now: clock.now });
  try {
    ledger.begin({ shopKey: SHOP, operationId: 'op-old', paramsHash: 'h-old' });
    clock.advance(31 * DAY);
    const secondAt = clock.now();
    ledger.begin({ shopKey: SHOP, operationId: 'op-new', paramsHash: 'h-new' });
    assert.equal(ledger.count(), 2);

    // 默认 30 天：只删 31 天前那条
    assert.equal(ledger.cleanup(), 1);
    assert.equal(ledger.count(), 1);
    assert.equal(ledger.get(SHOP, 'op-old'), null);
    assert.equal(ledger.get(SHOP, 'op-new').createdAt, secondAt);

    // retentionDays=0 等价于「删掉此刻之前的全部」（先走过 1ms，避免边界相等）
    clock.advance(1);
    assert.equal(ledger.cleanup({ retentionDays: 0 }), 1);
    assert.equal(ledger.count(), 0);

    // 显式 now（毫秒数字）与函数两种形式都支持
    ledger.begin({ shopKey: SHOP, operationId: 'op-x', paramsHash: 'h-x' });
    clock.advance(DAY + 1000);
    assert.equal(ledger.cleanup({ retentionDays: 1, now: clock.now() }), 1);
    assert.equal(ledger.count(), 0);
  } finally {
    ledger.close();
  }
});

test('持久化：文件库 + WAL，重开后记录仍在', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '1688-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const dbPath = path.join(dir, 'nested', 'ledger.db'); // 目录不存在，应自动创建
  const clock = makeClock();

  const ledger = openLedger({ path: dbPath, now: clock.now });
  try {
    assert.equal(ledger.path, dbPath);
    assert.ok(fs.existsSync(dbPath), '账本文件应已创建');
    ledger.begin({ shopKey: SHOP, operationId: 'op-persist', tool: 't', paramsHash: 'h-p', paramsJson: '{"k":"v"}' });
    ledger.complete({ shopKey: SHOP, operationId: 'op-persist', result: { productId: 'p1' } });
    // WAL 模式下写入后会生成 -wal 旁路文件（用于验证 PRAGMA journal_mode=WAL 生效）
    assert.ok(fs.existsSync(`${dbPath}-wal`), 'WAL 模式应生成 -wal 文件');
  } finally {
    ledger.close();
  }

  const reopened = openLedger({ path: dbPath, now: clock.now });
  try {
    const record = reopened.get(SHOP, 'op-persist');
    assert.deepEqual(record.result, { productId: 'p1' });
    assert.equal(record.status, 'SUCCEEDED');
    assert.equal(record.paramsJson, '{"k":"v"}');
    assert.equal(reopened.count(), 1);
    // 重开后同参数继续判 replay
    assert.equal(reopened.begin({ shopKey: SHOP, operationId: 'op-persist', paramsHash: 'h-p' }).state, 'replay');
  } finally {
    reopened.close();
  }
});

test('close：可重复调用，关闭后拒绝继续使用', () => {
  const ledger = openLedger({ path: ':memory:' });
  ledger.begin({ shopKey: SHOP, operationId: 'op-close', paramsHash: 'h' });
  ledger.close();
  assert.doesNotThrow(() => ledger.close());
  assert.throws(() => ledger.begin({ shopKey: SHOP, operationId: 'op-2', paramsHash: 'h' }), /账本已关闭/);
  assert.throws(() => ledger.list({ shopKey: SHOP }), /账本已关闭/);
});
