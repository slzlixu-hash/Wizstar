'use strict';

/**
 * 凭证隔离单测（规范 2.3：X-Shop-Credential 头解析、凭证禁入参数体、AES-256-GCM 落盘）。
 *
 * 时间全部注入，加密落盘用 mkdtemp 临时目录，测试结束删除。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decodeShopCredential,
  assertNoSecretsInBody,
  createCredentialRegistry,
} from '../../src/security/credentials.js';

const T0 = 1_700_000_000_000;

function makeClock(start = T0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
      return t;
    },
  };
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function b64(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

function assertContractError(fn, code, messageRe) {
  assert.throws(fn, (e) => {
    assert.equal(e.name, 'ContractError');
    assert.equal(e.code, code);
    if (messageRe) assert.match(e.message, messageRe);
    return true;
  });
}

/** 捕获 console.error，避免测试输出噪音，同时可断言「静默降级」 */
function captureConsoleError(fn) {
  const original = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.map(String).join(' '));
  try {
    return { result: fn(), logs };
  } finally {
    console.error = original;
  }
}

test('decodeShopCredential：base64url / 标准 base64 / 空白 / 数组头都能解析', () => {
  const payload = { appId: 'app-1688-001', appSecret: 's3cr3t-值', shopId: 'shop-9' };

  const expected = {
    appId: 'app-1688-001',
    shopId: 'shop-9',
    shopKey: 'app-1688-001:shop-9',
    appSecret: 's3cr3t-值',
  };

  assert.deepEqual(decodeShopCredential(b64url(payload)), expected);
  // 标准 base64（含 + / = 与 padding）
  assert.deepEqual(decodeShopCredential(b64(payload)), expected);
  // HTTP 客户端折行/多余空白
  assert.deepEqual(decodeShopCredential(`  ${b64url(payload)}\r\n`), expected);
  // Node 会把重复头合成数组
  assert.deepEqual(decodeShopCredential([b64url(payload)]), expected);
});

test('decodeShopCredential：shopId 缺省 default，appId/appSecret 去空白，appSecret 可缺省', () => {
  const onlyAppId = decodeShopCredential(b64url({ appId: '  app-1  ' }));
  assert.equal(onlyAppId.appId, 'app-1');
  assert.equal(onlyAppId.shopId, 'default');
  assert.equal(onlyAppId.shopKey, 'app-1:default');
  assert.equal(onlyAppId.appSecret, '');

  const withShop = decodeShopCredential(b64url({ appId: 'app-2', shopId: '   ' }));
  assert.equal(withShop.shopId, 'default');
});

test('decodeShopCredential：缺头 / 非法编码 / 非对象 / 缺 appId / 非法字符 → 41001', () => {
  assertContractError(() => decodeShopCredential(undefined), 41001, /缺少 X-Shop-Credential/);
  assertContractError(() => decodeShopCredential(null), 41001, /缺少 X-Shop-Credential/);
  assertContractError(() => decodeShopCredential('   '), 41001, /缺少 X-Shop-Credential/);

  assertContractError(() => decodeShopCredential('not-a-base64-json!!'), 41001, /X-Shop-Credential 解析失败/);
  assertContractError(() => decodeShopCredential(Buffer.from('{}').toString('base64')), 41001, /appId/);
  // 合法 JSON 但不是对象
  assertContractError(() => decodeShopCredential(b64url(['app'])), 41001, /必须是 JSON 对象/);
  assertContractError(() => decodeShopCredential(Buffer.from('null').toString('base64')), 41001, /必须是 JSON 对象/);
  // appId 含冒号会破坏 shopKey 结构
  assertContractError(() => decodeShopCredential(b64url({ appId: 'a:b' })), 41001, /非法字符/);
  assertContractError(() => decodeShopCredential(b64url({ appId: 'a b' })), 41001, /非法字符/);
  assertContractError(() => decodeShopCredential(b64url({ appId: 'a', shopId: 'x:y' })), 41001, /非法字符/);
  // 超长
  assertContractError(() => decodeShopCredential(b64url({ appId: 'a'.repeat(129) })), 41001, /过长/);
});

test('assertNoSecretsInBody：正常参数放行', () => {
  assert.doesNotThrow(() => assertNoSecretsInBody({}));
  assert.doesNotThrow(() => assertNoSecretsInBody(null));
  assert.doesNotThrow(() =>
    assertNoSecretsInBody({
      title: '商品标题',
      price: 19.9,
      skus: [{ skuId: '1', stock: 10 }],
      // 名字近似但不在黑名单里
      secretNote: 'not-a-secret-field',
      tokenCount: 12,
    }),
  );
});

test('assertNoSecretsInBody：任意层级的凭证字段 → 40001，错误只带路径不带值', () => {
  const cases = [
    [{ appSecret: 's' }, '$.appSecret'],
    [{ app_secret: 's' }, '$.app_secret'],
    [{ appKey: 'k' }, '$.appKey'],
    [{ secret: 's' }, '$.secret'],
    [{ client_secret: 's' }, '$.client_secret'],
    [{ access_token: 't' }, '$.access_token'],
    [{ refreshToken: 't' }, '$.refreshToken'],
    [{ outer: { inner: { ACCESS_TOKEN: 't' } } }, '$.outer.inner.ACCESS_TOKEN'],
    [{ list: [{ ok: 1 }, { appSecret: 's' }] }, '$.list[1].appSecret'],
  ];

  for (const [params, expectedPath] of cases) {
    assert.throws(
      () => assertNoSecretsInBody(params),
      (e) => {
        assert.equal(e.name, 'ContractError');
        assert.equal(e.code, 40001);
        assert.match(e.message, /凭证严禁放入 JSON-RPC 参数体，请改用 X-Shop-Credential 头/);
        assert.equal(e.data.path, expectedPath);
        // 绝不能把凭证值带进错误信息（会进日志）
        assert.ok(!JSON.stringify(e.toJSON()).includes('s3cr3t'), '错误体不应包含凭证值');
        return true;
      },
    );
  }
});

test('assertNoSecretsInBody：循环引用不报错，嵌套过深 → 40001', () => {
  const circular = { name: 'a' };
  circular.self = circular;
  circular.child = { parent: circular };
  assert.doesNotThrow(() => assertNoSecretsInBody(circular));

  let deep = { leaf: true };
  for (let i = 0; i < 70; i += 1) deep = { child: deep };
  assertContractError(() => assertNoSecretsInBody(deep), 40001, /嵌套层级过深/);
});

test('注册表（无 encryptionKey）：内存 TTL、副本返回、flush 不落盘', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '1688-cred-mem-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'credentials.enc.json');

  const clock = makeClock();
  const registry = createCredentialRegistry({ cacheFile, ttlSec: 10, now: clock.now });
  try {
    assert.equal(registry.size(), 0);
    assert.equal(registry.get('app-1:default'), null);
    assert.equal(registry.has('app-1:default'), false);

    const cred = decodeShopCredential(b64url({ appId: 'app-1', appSecret: 'secret-1' }));
    registry.put(cred);
    assert.equal(registry.size(), 1);
    assert.equal(registry.has('app-1:default'), true);

    const got = registry.get('app-1:default');
    assert.deepEqual(got, { appId: 'app-1', shopId: 'default', shopKey: 'app-1:default', appSecret: 'secret-1' });
    // 副本语义：外部改动不影响内部
    got.appSecret = 'tampered';
    assert.equal(registry.get('app-1:default').appSecret, 'secret-1');

    // 覆盖写同 shopKey 只保留一条
    registry.put({ appId: 'app-1', appSecret: 'secret-2' });
    assert.equal(registry.size(), 1);
    assert.equal(registry.get('app-1:default').appSecret, 'secret-2');

    // TTL 过期
    clock.advance(9_999);
    assert.equal(registry.has('app-1:default'), true);
    clock.advance(2);
    assert.equal(registry.get('app-1:default'), null);
    assert.equal(registry.size(), 0);

    // 无密钥时即使给了 cacheFile 也绝不落盘
    registry.flush();
    assert.equal(fs.existsSync(cacheFile), false);
  } finally {
    registry.close();
  }
  assert.equal(fs.existsSync(cacheFile), false);
});

test('注册表：非法写入参数 → 40001，close 后不可写', () => {
  const registry = createCredentialRegistry({});
  try {
    assertContractError(() => registry.put(null), 40001);
    assertContractError(() => registry.put({ appSecret: 'only-secret' }), 40001, /appId/);
  } finally {
    registry.close();
  }
  assert.throws(() => registry.put({ appId: 'app-1' }), /凭证注册表已关闭/);
  assert.equal(registry.get('app-1:default'), null);
  assert.equal(registry.size(), 0);
  assert.doesNotThrow(() => registry.close()); // 幂等
});

test('注册表（AES-256-GCM，64 位 hex 密钥）：密文落盘、无明文、可回读', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '1688-cred-enc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // 故意用多层不存在的子目录，验证 mkdirSync(recursive)
  const cacheFile = path.join(dir, 'nested', 'deep', 'credentials.enc.json');
  const encryptionKey = crypto.randomBytes(32).toString('hex');
  const clock = makeClock();

  const registry = createCredentialRegistry({ encryptionKey, cacheFile, ttlSec: 300, now: clock.now });
  const cred = decodeShopCredential(b64url({ appId: 'app-enc', appSecret: 'top-secret-value-中文', shopId: 's1' }));
  try {
    registry.put(cred);
    assert.ok(fs.existsSync(cacheFile), '应有加密缓存文件');

    const raw = fs.readFileSync(cacheFile, 'utf8');
    const envelope = JSON.parse(raw);
    assert.equal(envelope.v, 1);
    for (const field of ['iv', 'tag', 'data']) {
      assert.equal(typeof envelope[field], 'string');
      assert.ok(Buffer.from(envelope[field], 'base64').length > 0);
    }
    assert.equal(Buffer.from(envelope.iv, 'base64').length, 12, 'GCM IV 应为 12 字节');
    assert.equal(Buffer.from(envelope.tag, 'base64').length, 16, 'GCM tag 应为 16 字节');
    // 磁盘上不得出现凭证明文
    assert.ok(!raw.includes('top-secret-value'), '缓存文件不得含 appSecret 明文');
    assert.ok(!raw.includes('app-enc'), '缓存文件不得含 appId 明文');
    assert.ok(!raw.includes('s1'), '缓存文件不得含 shopId 明文');

    // 原子写不会留下 tmp 文件
    const leftovers = fs.readdirSync(path.dirname(cacheFile)).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
    // 权限：POSIX 下 0600（Windows 不校验）
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
    }
  } finally {
    registry.close();
  }

  // 同密钥新实例：显式 load() 回读
  const reloaded = createCredentialRegistry({ encryptionKey, cacheFile, ttlSec: 300, now: clock.now });
  try {
    assert.equal(reloaded.load(), 1);
    const got = reloaded.get('app-enc:s1');
    assert.equal(got.appSecret, 'top-secret-value-中文');
    assert.equal(got.shopId, 's1');
  } finally {
    reloaded.close();
  }
});

test('注册表：任意口令（sha256 派生密钥）也能加解密，且 TTL 过期条目在 load 时被丢弃', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '1688-cred-pass-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'cache.json');
  const clock = makeClock();

  const registry = createCredentialRegistry({ encryptionKey: '一个较长的口令-不是 hex', cacheFile, ttlSec: 60, now: clock.now });
  registry.put({ appId: 'app-pass', appSecret: 'pw-secret' });
  registry.close();

  // 未过期：能载入
  const fresh = createCredentialRegistry({ encryptionKey: '一个较长的口令-不是 hex', cacheFile, ttlSec: 60, now: clock.now });
  try {
    assert.equal(fresh.load(), 1);
    assert.equal(fresh.get('app-pass:default').appSecret, 'pw-secret');
  } finally {
    fresh.close();
  }

  // 过期后：load 跳过，不抛
  clock.advance(61_000);
  const expired = createCredentialRegistry({ encryptionKey: '一个较长的口令-不是 hex', cacheFile, ttlSec: 60, now: clock.now });
  const { result, logs } = captureConsoleError(() => expired.load());
  try {
    assert.equal(result, 0);
    assert.equal(expired.size(), 0);
    assert.deepEqual(logs, [], '过期属于正常情况，不应告警');
  } finally {
    expired.close();
  }
});

test('注册表：密钥错误 / 文件损坏 / 文件缺失 → 静默空缓存并 console.error（不抛）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '1688-cred-bad-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'cache.json');
  const clock = makeClock();
  const keyA = crypto.randomBytes(32).toString('hex');
  const keyB = crypto.randomBytes(32).toString('hex');

  const writer = createCredentialRegistry({ encryptionKey: keyA, cacheFile, now: clock.now });
  writer.put({ appId: 'app-bad', appSecret: 'secret-bad' });
  writer.close();

  // 1) 换密钥：GCM 校验失败 → 空缓存 + 告警
  const wrongKey = createCredentialRegistry({ encryptionKey: keyB, cacheFile, now: clock.now });
  const wrongResult = captureConsoleError(() => wrongKey.load());
  try {
    assert.equal(wrongResult.result, 0);
    assert.equal(wrongKey.size(), 0);
    assert.equal(wrongKey.get('app-bad:default'), null);
    assert.equal(wrongResult.logs.length, 1);
    assert.match(wrongResult.logs[0], /解密\/解析失败/);
  } finally {
    wrongKey.close();
  }

  // 2) 文件被改成垃圾 → 空缓存 + 告警
  fs.writeFileSync(cacheFile, '这不是合法 JSON {{{', 'utf8');
  const corrupted = createCredentialRegistry({ encryptionKey: keyA, cacheFile, now: clock.now });
  const corruptedResult = captureConsoleError(() => corrupted.load());
  try {
    assert.equal(corruptedResult.result, 0);
    assert.equal(corrupted.size(), 0);
    assert.equal(corruptedResult.logs.length, 1);
  } finally {
    corrupted.close();
  }

  // 3) 版本号不匹配 → 空缓存 + 告警
  fs.writeFileSync(cacheFile, JSON.stringify({ v: 99, iv: '', tag: '', data: '' }), 'utf8');
  const versionMismatch = createCredentialRegistry({ encryptionKey: keyA, cacheFile, now: clock.now });
  const versionResult = captureConsoleError(() => versionMismatch.load());
  try {
    assert.equal(versionResult.result, 0);
    assert.equal(versionResult.logs.length, 1);
  } finally {
    versionMismatch.close();
  }

  // 4) 文件不存在 → 返回 0 且完全静默（首次启动的正常路径）
  const missingFile = path.join(dir, 'missing.json');
  const missing = createCredentialRegistry({ encryptionKey: keyA, cacheFile: missingFile, now: clock.now });
  const missingResult = captureConsoleError(() => missing.load());
  try {
    assert.equal(missingResult.result, 0);
    assert.deepEqual(missingResult.logs, [], '文件缺失是正常情况，不应告警');
  } finally {
    missing.close();
  }
});

test('注册表：load 会替换内存中的旧值，且无密钥时 load 恒为 0', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '1688-cred-replace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'cache.json');
  const clock = makeClock();
  const encryptionKey = crypto.randomBytes(32).toString('hex');

  const writer = createCredentialRegistry({ encryptionKey, cacheFile, now: clock.now });
  writer.put({ appId: 'app-disk', appSecret: 'from-disk' });
  writer.close();

  const reader = createCredentialRegistry({ encryptionKey, cacheFile, now: clock.now });
  try {
    // 内存里先放一条，同时 put 会把磁盘快照覆盖成这一条
    reader.put({ appId: 'app-only-memory', appSecret: 'mem' });
    assert.equal(reader.size(), 1);

    // 另一个实例改写磁盘（模拟别的进程/重启后写入了更新的凭证）
    const writer2 = createCredentialRegistry({ encryptionKey, cacheFile, now: clock.now });
    writer2.put({ appId: 'app-from-disk2', appSecret: 'disk-2' });
    writer2.close();

    // load 用磁盘快照整体替换内存：内存独有那条消失
    assert.equal(reader.load(), 1);
    assert.equal(reader.size(), 1);
    assert.equal(reader.has('app-only-memory:default'), false);
    assert.equal(reader.has('app-disk:default'), false);
    assert.equal(reader.get('app-from-disk2:default').appSecret, 'disk-2');
  } finally {
    reader.close();
  }

  // 无 encryptionKey：load 不读文件、返回 0
  const inMemory = createCredentialRegistry({ cacheFile, now: clock.now });
  const inMemoryResult = captureConsoleError(() => inMemory.load());
  try {
    assert.equal(inMemoryResult.result, 0);
    assert.equal(inMemory.size(), 0);
    assert.deepEqual(inMemoryResult.logs, []);
  } finally {
    inMemory.close();
  }
});
