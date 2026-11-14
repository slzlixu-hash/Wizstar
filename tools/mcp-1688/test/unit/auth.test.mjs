'use strict';

/**
 * MCP-HMAC 鉴权单测（对应规范 2.2 / 第 7 章「鉴权核验」）。
 *
 * 覆盖：签名原串、头解析容错、时间容差、nonce 防重放、篡改检测、密钥隔离。
 * 全部用注入时钟，不依赖真实时间/网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signRequest, sha256Hex, createAuth } from '../../src/http/auth.js';

const SECRET = 'unit-test-secret-0123456789-不要用于生产';
const KEY_ID = 'k1';
const NOW_SEC = 1_700_000_000;
const BODY = '{"jsonrpc":"2.0","id":1,"method":"tools/call"}';
const PATH = '/mcp?tenant=demo';

/** 每个测试独立鉴权器，避免 nonce 互相污染 */
function makeAuth(overrides = {}) {
  return createAuth({
    keys: { [KEY_ID]: SECRET },
    toleranceSec: 300,
    nonceTtlSec: 600,
    now: () => NOW_SEC * 1000,
    ...overrides,
  });
}

function makeHeader({ secret = SECRET, keyId = KEY_ID, method = 'POST', path = PATH, rawBody = BODY, ts = NOW_SEC, nonce = 'nonce-test-0001' } = {}) {
  return signRequest({ secret, keyId, method, path, rawBody, ts, nonce });
}

/** 断言失败信封：code 精确 + 中文消息 + 不泄露密钥 */
function assertAuthError(result, code, messageRe) {
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
  assert.equal(typeof result.message, 'string');
  assert.match(result.message, messageRe);
  assert.ok(!result.message.includes(SECRET), '错误消息不得包含密钥明文');
}

test('sha256Hex：字符串/Buffer/空串与 Node crypto 一致', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(Buffer.from('abc', 'utf8')), sha256Hex('abc'));
  // 用独立实现对照，防止实现里误用 base64/utf16
  const expected = crypto.createHash('sha256').update(Buffer.from('中文 body', 'utf8')).digest('hex');
  assert.equal(sha256Hex('中文 body'), expected);
  assert.equal(sha256Hex(null), sha256Hex(''));
  assert.equal(sha256Hex(undefined), sha256Hex(''));
});

test('signRequest：生成规范格式的 Authorization 头，且确定性可复现', () => {
  const header = makeHeader();
  assert.match(header, /^MCP-HMAC keyId=k1,ts=1700000000,nonce=nonce-test-0001,sig=[A-Za-z0-9_-]+$/);
  // 同一组输入必须得到同一签名
  assert.equal(makeHeader(), header);
  // 换 nonce / body 必须换签名
  assert.notEqual(makeHeader({ nonce: 'nonce-test-0002' }), header);
  assert.notEqual(makeHeader({ rawBody: BODY + ' ' }), header);
  // sig 是 base64url：不含 + / =
  const sig = header.slice(header.indexOf('sig=') + 4);
  assert.ok(!/[+/=]/.test(sig));
  assert.equal(Buffer.from(sig, 'base64url').length, 32);
});

test('signRequest：缺 secret / keyId / method 直接抛 TypeError', () => {
  assert.throws(() => signRequest({ keyId: 'k1', method: 'POST', path: '/mcp' }), TypeError);
  assert.throws(() => signRequest({ secret: 's', method: 'POST', path: '/mcp' }), TypeError);
  assert.throws(() => signRequest({ secret: 's', keyId: 'k1', path: '/mcp' }), TypeError);
});

test('verify：正常请求通过并返回 keyId/ts/nonce', () => {
  const auth = makeAuth();
  try {
    const result = auth.verify({ method: 'POST', path: PATH, headers: { authorization: makeHeader() }, rawBody: BODY });
    assert.deepEqual(result, { ok: true, keyId: KEY_ID, ts: NOW_SEC, nonce: 'nonce-test-0001' });
    assert.equal(auth.size(), 1);
  } finally {
    auth.close();
  }
});

test('verify：头解析容错（标准大小写/数组值/乱序/空格/引号）', () => {
  const auth = makeAuth();
  let seq = 0;
  // 每个变体用新 nonce，避免被防重放逻辑误伤
  const fresh = () => {
    seq += 1;
    return makeHeader({ nonce: `n-parse-${seq}` });
  };
  /** 打乱字段顺序 + 多余空格 + 值加引号 */
  const shuffle = (header) => {
    const [scheme, rest] = header.split(' ');
    return `${scheme} ${rest
      .split(',')
      .slice()
      .reverse()
      .map((f, i) => {
        const eq = f.indexOf('=');
        const k = f.slice(0, eq);
        const v = f.slice(eq + 1);
        return i === 0 ? `${k} = "${v}"` : `  ${k}=${v}  `;
      })
      .join(' , ')}`;
  };

  try {
    const variants = [
      () => ({ Authorization: fresh() }), // 标准头名（Node 的 req.headers 是小写，两者都要认）
      () => ({ authorization: fresh() }),
      () => ({ authorization: [fresh(), 'MCP-HMAC 其它废值'] }), // 重复头取第一个
      () => ({ authorization: fresh().replace(' ', '    ') }), // 方案后多个空格
      () => ({ authorization: shuffle(fresh()) }), // 乱序 + 引号 + 空格
      () => ({ 'content-type': 'application/json', authorization: fresh() }),
    ];
    for (const make of variants) {
      const headers = make();
      const result = auth.verify({ method: 'POST', path: PATH, headers, rawBody: BODY });
      assert.equal(result.ok, true, `变体应通过：${JSON.stringify(headers)}`);
    }
  } finally {
    auth.close();
  }
});

test('verify：method 大小写不敏感，path 必须完全一致', () => {
  const auth = makeAuth();
  try {
    const header = makeHeader({ method: 'POST', nonce: 'n-case' });
    // 客户端小写 method 签名，服务端大写解析：归一化后仍应通过
    assert.equal(auth.verify({ method: 'post', path: PATH, headers: { authorization: header }, rawBody: BODY }).ok, true);
    // 路径不同（含 query 变化）必须失败
    assertAuthError(
      auth.verify({ method: 'POST', path: '/mcp', headers: { authorization: makeHeader({ nonce: 'n-path' }) }, rawBody: BODY }),
      41001,
      /签名校验失败/,
    );
  } finally {
    auth.close();
  }
});

test('verify：请求体/方法/路径/keyId 被篡改都返回 41001', () => {
  const auth = makeAuth();
  const header = makeHeader();
  try {
    const cases = [
      { rawBody: '{"jsonrpc":"2.0","id":2}' },
      { method: 'PUT' },
      { path: '/mcp?tenant=demo2' },
      { headers: { authorization: makeHeader({ keyId: 'k2' }) } }, // 未配置的 keyId
    ];
    for (const c of cases) {
      const result = auth.verify({ method: 'POST', path: PATH, headers: { authorization: header }, rawBody: BODY, ...c });
      assert.equal(result.ok, false);
      assert.equal(result.code, 41001);
    }
    // 空 body 与缺省 body 等价（都不能匹配非空签名）
    assertAuthError(auth.verify({ method: 'POST', path: PATH, headers: { authorization: header } }), 41001, /签名校验失败/);
  } finally {
    auth.close();
  }
});

test('verify：缺头/空头/格式错/字段缺失都返回 41001 且消息为中文', () => {
  const auth = makeAuth();
  try {
    const bad = [
      { headers: {} },
      { headers: { authorization: '' } },
      { headers: { authorization: 'Bearer abc.def' } },
      { headers: { authorization: 'MCP-HMAC' } },
      { headers: { authorization: 'MCP-HMAC keyId=k1,ts=1700000000' } },
      { headers: { authorization: `MCP-HMAC keyId=k1,ts=1700000000,nonce=n,sig=bad,extra=${'x'.repeat(4)} junk` } },
      { headers: { authorization: 'MCP-HMAC keyId k1,ts=1,nonce=n,sig=s' } },
    ];
    for (const c of bad) {
      const result = auth.verify({ method: 'POST', path: PATH, rawBody: BODY, ...c });
      assert.equal(result.ok, false, JSON.stringify(c));
      assert.equal(result.code, 41001);
      assert.match(result.message, /[\u4e00-\u9fa5]/);
    }
    // 首条消息应指出缺少 Authorization 头（并提示两种可用方案）
    assertAuthError(auth.verify({ method: 'POST', path: PATH, headers: {}, rawBody: BODY }), 41001, /缺少 Authorization 头.*Bearer/);
    // MCP-HMAC 格式错误应给出可照抄的模板；Bearer 通道的错令牌单独断言
    assertAuthError(
      auth.verify({ method: 'POST', path: PATH, headers: { authorization: 'MCP-HMAC junk' }, rawBody: BODY }),
      41001,
      /MCP-HMAC keyId=/,
    );
    assertAuthError(
      auth.verify({ method: 'POST', path: PATH, headers: { authorization: 'Bearer x' }, rawBody: BODY }),
      41001,
      /Bearer Token 无效/,
    );
  } finally {
    auth.close();
  }
});

test('verify：未知 keyId 返回 41001 且不泄露密钥表内容', () => {
  const auth = makeAuth({ keys: { [KEY_ID]: SECRET, other: 'another-secret-value' } });
  try {
    // 用 k1 的 secret 签名，但声称 keyId=k2（不存在）
    const header = makeHeader({ keyId: 'k2' });
    const result = auth.verify({ method: 'POST', path: PATH, headers: { authorization: header }, rawBody: BODY });
    assertAuthError(result, 41001, /未知的 keyId/);
    assert.ok(!result.message.includes('another-secret-value'));

    // 用 k1 签名但改成 k2 的 keyId（签名原串包含 keyId，必然不符）
    const swapped = header.replace('keyId=k2', 'keyId=k1');
    assertAuthError(
      auth.verify({ method: 'POST', path: PATH, headers: { authorization: swapped }, rawBody: BODY }),
      41001,
      /签名校验失败/,
    );
  } finally {
    auth.close();
  }
});

test('verify：时间戳容差边界（±300s 通过，301s 拒绝）', () => {
  const auth = makeAuth();
  try {
    let seq = 0;
    const check = (skewSec) => {
      seq += 1;
      const header = makeHeader({ ts: NOW_SEC + skewSec, nonce: `n-skew-${seq}` });
      return auth.verify({ method: 'POST', path: PATH, headers: { authorization: header }, rawBody: BODY });
    };
    assert.equal(check(0).ok, true);
    assert.equal(check(-300).ok, true, '请求偏旧 300s 恰好在容差内');
    assert.equal(check(300).ok, true, '请求偏新 300s 恰好在容差内');
    assertAuthError(check(-301), 41001, /容差窗口/);
    assertAuthError(check(301), 41001, /容差窗口/);
    assertAuthError(
      auth.verify({
        method: 'POST',
        path: PATH,
        headers: { authorization: `MCP-HMAC keyId=k1,ts=abc,nonce=n-bad,sig=x` },
        rawBody: BODY,
      }),
      41001,
      /ts/,
    );
  } finally {
    auth.close();
  }
});

test('verify：nonce 一次性，重复即 41009；不同 nonce 可继续通过', () => {
  const auth = makeAuth();
  try {
    const first = auth.verify({ method: 'POST', path: PATH, headers: { authorization: makeHeader({ nonce: 'n-replay' }) }, rawBody: BODY });
    assert.equal(first.ok, true);
    const second = auth.verify({ method: 'POST', path: PATH, headers: { authorization: makeHeader({ nonce: 'n-replay' }) }, rawBody: BODY });
    assertAuthError(second, 41009, /重复 nonce/);
    // 新 nonce 正常
    const third = auth.verify({ method: 'POST', path: PATH, headers: { authorization: makeHeader({ nonce: 'n-fresh' }) }, rawBody: BODY });
    assert.equal(third.ok, true);
  } finally {
    auth.close();
  }
});

test('verify：先验签后消耗 nonce（伪造签名不会烧掉合法 nonce）', () => {
  const auth = makeAuth();
  const validHeader = makeHeader({ nonce: 'n-burn' });
  const forged = validHeader.replace(/sig=.*$/, 'sig=AAAA');
  try {
    assertAuthError(auth.verify({ method: 'POST', path: PATH, headers: { authorization: forged }, rawBody: BODY }), 41001, /签名校验失败/);
    assert.equal(auth.size(), 0, '验签失败的请求不得占用 nonce');
    assert.equal(
      auth.verify({ method: 'POST', path: PATH, headers: { authorization: validHeader }, rawBody: BODY }).ok,
      true,
      '合法请求仍可使用该 nonce',
    );
  } finally {
    auth.close();
  }
});

test('verify：nonce 过期后可再次使用（TTL 生效 + size 惰性清理）', () => {
  let clock = NOW_SEC * 1000;
  const auth = createAuth({
    keys: { [KEY_ID]: SECRET },
    toleranceSec: 10_000, // 时间窗放大，确保只观察 nonce TTL
    nonceTtlSec: 1,
    now: () => clock,
  });
  try {
    const header = makeHeader({ ts: NOW_SEC, nonce: 'n-ttl' });
    assert.equal(auth.verify({ method: 'POST', path: PATH, headers: { authorization: header }, rawBody: BODY }).ok, true);
    assert.equal(auth.size(), 1);
    clock += 500;
    assert.equal(auth.size(), 1, 'TTL 内仍记录');
    clock += 600; // 累计 1100ms > 1s
    assert.equal(auth.size(), 0, '过期条目被惰性清理');
    assert.equal(auth.verify({ method: 'POST', path: PATH, headers: { authorization: header }, rawBody: BODY }).ok, true);
  } finally {
    auth.close();
  }
});

test('verify：sig 长度不同不会抛 timingSafeEqual 错误，而是按签名不符处理', () => {
  const auth = makeAuth();
  try {
    const header = makeHeader({ nonce: 'n-len' });
    const shortened = header.replace(/sig=.*$/, 'sig=AAAA');
    const result = auth.verify({ method: 'POST', path: PATH, headers: { authorization: shortened }, rawBody: BODY });
    assertAuthError(result, 41001, /签名校验失败/);
  } finally {
    auth.close();
  }
});

test('signRequest：rawBody 传对象时与服务端 JSON 字符串字节一致', () => {
  const auth = makeAuth();
  try {
    const header = makeHeader({ rawBody: { a: 1, b: '中文' }, nonce: 'n-obj' });
    const result = auth.verify({
      method: 'POST',
      path: PATH,
      headers: { authorization: header },
      rawBody: JSON.stringify({ a: 1, b: '中文' }),
    });
    assert.equal(result.ok, true);
  } finally {
    auth.close();
  }
});

test('size/close：清空 nonce 表、可重复 close，且不残留定时器', () => {
  const auth = makeAuth();
  for (let i = 0; i < 3; i += 1) {
    const r = auth.verify({ method: 'POST', path: PATH, headers: { authorization: makeHeader({ nonce: `n-size-${i}` }) }, rawBody: BODY });
    assert.equal(r.ok, true);
  }
  assert.equal(auth.size(), 3);
  auth.close();
  assert.equal(auth.size(), 0);
  auth.close(); // 幂等
});

test('多密钥表：不同 keyId 各自路由到自己的 secret', () => {
  const auth = createAuth({
    keys: { k1: SECRET, k2: 'second-secret-value' },
    now: () => NOW_SEC * 1000,
  });
  try {
    const h1 = makeHeader({ keyId: 'k1', secret: SECRET, nonce: 'n-k1' });
    const h2 = makeHeader({ keyId: 'k2', secret: 'second-secret-value', nonce: 'n-k2' });
    assert.equal(auth.verify({ method: 'POST', path: PATH, headers: { authorization: h1 }, rawBody: BODY }).ok, true);
    assert.equal(auth.verify({ method: 'POST', path: PATH, headers: { authorization: h2 }, rawBody: BODY }).ok, true);
    // 交叉使用密钥（k2 头 + k1 secret 签名）必须失败
    const crossed = makeHeader({ keyId: 'k2', secret: SECRET, nonce: 'n-cross' });
    assertAuthError(auth.verify({ method: 'POST', path: PATH, headers: { authorization: crossed }, rawBody: BODY }), 41001, /签名校验失败/);
  } finally {
    auth.close();
  }
});

/* ------------------------------ 快速接入通道：Bearer 静态令牌 + 回环豁免 ------------------------------ */

test('Bearer 静态令牌：keyId:secret 与裸 secret 均可直通（免算签名）', () => {
  const auth = makeAuth();
  try {
    const pair = auth.verify({
      method: 'POST', path: PATH, rawBody: BODY,
      headers: { authorization: `Bearer ${KEY_ID}:${SECRET}` },
      remoteAddress: '10.0.0.8',
    });
    assert.equal(pair.ok, true);
    assert.equal(pair.keyId, KEY_ID);

    const bare = auth.verify({
      method: 'POST', path: PATH, rawBody: BODY,
      headers: { authorization: `Bearer ${SECRET}` },
      remoteAddress: '10.0.0.8',
    });
    assert.equal(bare.ok, true);
    assert.equal(bare.keyId, KEY_ID);
  } finally {
    auth.close();
  }
});

test('Bearer 静态令牌：错误令牌 → 41001，错误消息不泄露任何密钥片段', () => {
  const auth = makeAuth();
  try {
    const r = auth.verify({
      method: 'POST', path: PATH, rawBody: BODY,
      headers: { authorization: 'Bearer wrong-token' },
      remoteAddress: '10.0.0.8',
    });
    assertAuthError(r, 41001, /Bearer Token 无效/);
  } finally {
    auth.close();
  }
});

test('回环豁免：127.0.0.1 / ::ffff:127.0.0.1 / ::1 无需任何认证头直接放行', () => {
  const auth = makeAuth();
  try {
    for (const addr of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
      const r = auth.verify({ method: 'POST', path: PATH, headers: {}, rawBody: BODY, remoteAddress: addr });
      assert.equal(r.ok, true, `${addr} 应免签放行`);
      assert.equal(r.keyId, 'local-trust');
    }
  } finally {
    auth.close();
  }
});

test('回环豁免：loopbackBypass=false 时回环请求也必须走验签（跨机高危部署口径）', () => {
  const auth = makeAuth({ loopbackBypass: false });
  try {
    const anonymous = auth.verify({
      method: 'POST', path: PATH, headers: {}, rawBody: BODY, remoteAddress: '127.0.0.1',
    });
    assertAuthError(anonymous, 41001, /Bearer/);

    // 关闭豁免后，带合法 Bearer 令牌仍可通
    const bearer = auth.verify({
      method: 'POST', path: PATH, rawBody: BODY,
      headers: { authorization: `Bearer ${KEY_ID}:${SECRET}` },
      remoteAddress: '127.0.0.1',
    });
    assert.equal(bearer.ok, true);
  } finally {
    auth.close();
  }
});

test('未配置密钥：本机开发模式免鉴权（与罗盘口径一致，便于平台直接握手）', () => {
  const auth = createAuth({ keys: {}, now: () => NOW_SEC * 1000 });
  try {
    const anonymous = auth.verify({
      method: 'POST', path: PATH, headers: {}, rawBody: BODY, remoteAddress: '10.0.0.8',
    });
    assert.equal(anonymous.ok, true);
    assert.equal(anonymous.keyId, 'open');
  } finally {
    auth.close();
  }
});

test('未配置密钥 + 显式 loopbackBypass=false：仍按开发模式放行（无密钥可验）', () => {
  const auth = createAuth({ keys: {}, loopbackBypass: false, now: () => NOW_SEC * 1000 });
  try {
    const r = auth.verify({ method: 'POST', path: PATH, headers: {}, rawBody: BODY, remoteAddress: '127.0.0.1' });
    assert.equal(r.ok, true);
    assert.equal(r.keyId, 'open');
  } finally {
    auth.close();
  }
});
