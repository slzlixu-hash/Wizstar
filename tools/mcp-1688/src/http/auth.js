'use strict';

/**
 * MCP-HMAC 统一鉴权（规范 2.2）。
 *
 * 设计要点：
 * - 签名原串固定为 `{method}\n{path}\n{ts}\n{nonce}\n{sha256hex(rawBody)}\n{keyId}`，
 *   必须对「原始字节」取 sha256 —— 绝不能先 JSON.parse 再 stringify，
 *   否则空格/键序变化会让签名在不同实现间对不上；
 * - 时间戳容差与 nonce 一次性都用同一套 41001/41009 错误码，
 *   平台侧无需区分类别，统一按「鉴权失败需人工检查」处理；
 * - nonce 表只存内存：进程重启即失效，代价是重启后旧 nonce 可被重放，
 *   但配合 300s 时间窗，风险窗口极小，换来零磁盘依赖；
 * - 所有失败消息都用中文且不包含密钥片段，避免错误信息进入日志/Prompt 后泄漏。
 */
import crypto from 'node:crypto';
import { ERROR_CODES } from '../core/errors.js';

/** Authorization 方案名（大小写不敏感解析，输出统一大写） */
const SCHEME = 'MCP-HMAC';

/** 请求体转字节：Buffer 原样、字符串按 UTF-8、对象先 JSON.stringify（仅客户端便利） */
function bodyBytes(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  if (rawBody == null) return Buffer.alloc(0);
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  const text = JSON.stringify(rawBody);
  return Buffer.from(text == null ? '' : text, 'utf8');
}

/** sha256(Buffer|string) -> 小写 hex；导出给签名/测试/账本参数哈希复用 */
export function sha256Hex(input) {
  return crypto.createHash('sha256').update(bodyBytes(input)).digest('hex');
}

/** HTTP 方法统一大写：标准实现里 req.method 一定是大写，但手工调用/测试可能小写 */
function normalizeMethod(method) {
  return String(method || 'GET').trim().toUpperCase();
}

/** path 必须包含 query（平台按下发的完整 request-target 签名），空值退化为 '/' */
function normalizePath(path) {
  const p = path == null ? '' : String(path);
  return p === '' ? '/' : p;
}

/** 待签名原串（严格按规范 2.2，行分隔不可增删） */
function signingString({ method, path, ts, nonce, bodyHash, keyId }) {
  return [normalizeMethod(method), normalizePath(path), String(ts), String(nonce), bodyHash, String(keyId)].join('\n');
}

function hmacBase64Url(secret, message) {
  return crypto.createHmac('sha256', secret).update(message, 'utf8').digest('base64url');
}

/**
 * 生成完整 Authorization 头值：
 * `MCP-HMAC keyId=<keyId>,ts=<ts>,nonce=<nonce>,sig=<base64url>`
 *
 * @param {object} o
 * @param {string} o.secret 平台/店铺共享的 HMAC 密钥
 * @param {string} o.keyId 密钥标识（服务端按此查 secret）
 * @param {string} o.method HTTP 方法
 * @param {string} o.path 含 query 的 request-target
 * @param {string|Buffer|object} [o.rawBody] 原始请求体（字符串最安全，保证字节一致）
 * @param {number} [o.ts] Unix 秒，默认当前时间
 * @param {string} [o.nonce] 一次性随机串，默认 UUID
 * @returns {string}
 */
export function signRequest({
  secret,
  keyId,
  method,
  path,
  rawBody = '',
  ts = Math.floor(Date.now() / 1000),
  nonce = crypto.randomUUID(),
} = {}) {
  if (typeof secret !== 'string' || secret.length === 0) throw new TypeError('signRequest 需要非空 secret');
  if (keyId == null || String(keyId) === '') throw new TypeError('signRequest 需要 keyId');
  if (!method) throw new TypeError('signRequest 需要 method');

  const sig = hmacBase64Url(
    secret,
    signingString({ method, path, ts, nonce, bodyHash: sha256Hex(rawBody), keyId }),
  );
  return `${SCHEME} keyId=${keyId},ts=${ts},nonce=${nonce},sig=${sig}`;
}

/** 大小写不敏感取头（Node 的 req.headers 是小写，测试里常写成标准大小写） */
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const target = String(name).toLowerCase();
  const entries = headers instanceof Map ? headers.entries() : Object.entries(headers);
  for (const [k, v] of entries) {
    if (String(k).toLowerCase() !== target) continue;
    if (Array.isArray(v)) return v.length ? String(v[0]) : null;
    return v == null ? null : String(v);
  }
  return null;
}

/**
 * 参数片段：`key=value`，值允许引号包裹或裸 token（裸 token 可包含 '='，兼容 base64 padding）。
 * 用全局扫描而不是 split 的原因：既支持逗号分隔也支持空格分隔，还能容忍 `keyId = value` 这种空格。
 */
const AUTH_FIELD_RE = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s]+))/g;

/**
 * 解析 `MCP-HMAC keyId=..,ts=..,nonce=..,sig=..`。
 * 容忍：逗号或空格分隔、参数顺序任意、多余空格、值可用引号包裹、方案名大小写。
 * @returns {{keyId:string,ts:string,nonce:string,sig:string}|null} 非法返回 null
 */
function parseAuthorization(rawValue) {
  const text = String(rawValue == null ? '' : rawValue).trim();
  const m = /^MCP-HMAC[ \t]+(.+)$/i.exec(text);
  if (!m) return null;

  const params = m[1];
  const fields = Object.create(null);
  let cursor = 0;
  AUTH_FIELD_RE.lastIndex = 0;
  for (let hit = AUTH_FIELD_RE.exec(params); hit; hit = AUTH_FIELD_RE.exec(params)) {
    // 字段之间只允许逗号/空白，出现其它杂质判为格式错误
    if (!/^[,\s]*$/.test(params.slice(cursor, hit.index))) return null;
    cursor = AUTH_FIELD_RE.lastIndex;
    const value = hit[2] ?? hit[3] ?? hit[4] ?? '';
    if (!value) return null;
    fields[hit[1].toLowerCase()] = value;
  }
  if (!/^[,\s]*$/.test(params.slice(cursor))) return null;
  if (!fields.keyid || !fields.ts || !fields.nonce || !fields.sig) return null;
  return { keyId: fields.keyid, ts: fields.ts, nonce: fields.nonce, sig: fields.sig };
}

/** 等长常量时间比较：长度差异本身不是秘密，先比长度避免 timingSafeEqual 抛错 */
function timingSafeEqualStr(expected, provided) {
  const a = Buffer.from(String(expected), 'utf8');
  const b = Buffer.from(String(provided), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function fail(code, message) {
  return { ok: false, code, message };
}

/** 是否本机回环地址（含 IPv4 映射 IPv6 形式）：单机部署 / 同机进程间调用可免签直连 */
function isLoopbackAddress(address) {
  const value = String(address || '').replace(/^::ffff:/i, '');
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

/**
 * 创建校验器。nonce 表为进程内 Map，过期条目惰性清理 + 定时兜底清理。
 *
 * 鉴权分三档（自上而下短路）：
 *   1. 回环豁免：请求来自 127.0.0.1 / ::1 时直接放行（loopbackBypass=false 可关闭）；
 *   2. Bearer 静态令牌：`Authorization: Bearer <keyId:secret|secret>`，第三方工具免算签名秒级接入；
 *   3. MCP-HMAC 严格验签：跨公网高危通道，含时间窗 + nonce 防重放。
 *
 * @param {object} o
 * @param {Record<string,string>} o.keys keyId -> secret（直接引用，支持热更新密钥表）
 * @param {number} [o.toleranceSec] 时间戳容差（秒）
 * @param {number} [o.nonceTtlSec] nonce 记忆时长（秒），必须 >= 容差窗口
 * @param {boolean} [o.loopbackBypass] 本机回环免签（默认 true；仅对外监听的生产部署应显式关闭）
 * @param {() => number} [o.now] 注入时钟（毫秒），测试用
 */
export function createAuth({ keys = {}, toleranceSec = 300, nonceTtlSec = 600, loopbackBypass = true, now = () => Date.now() } = {}) {
  const keyTable = keys && typeof keys === 'object' ? keys : {};
  const tolerance = Math.max(0, Number(toleranceSec) || 0);
  // nonce 记忆时长按配置原样生效（默认 600s > 容差 300s）。
  // 调用方必须保证 nonceTtlSec >= toleranceSec，否则时间窗尾部的重放仍可能被接受，
  // 这里不做静默纠正：配置值应当所见即所得，越界属于部署配置错误。
  const ttlSec = Math.max(1, Number(nonceTtlSec) || 0);
  const ttlMs = ttlSec * 1000;

  /** @type {Map<string, number>} nonce -> 过期时间(ms) */
  const nonces = new Map();
  let closed = false;

  function purge() {
    const t = now();
    for (const [nonce, expiresAt] of nonces) {
      if (expiresAt <= t) nonces.delete(nonce);
    }
  }

  // unref：绝不能因为鉴权模块的清理定时器把进程吊住
  const timer = setInterval(purge, Math.max(1000, Math.min(ttlMs || 60_000, 60_000)));
  if (typeof timer.unref === 'function') timer.unref();

  /**
   * 校验一次请求。
   * @param {{method:string, path:string, headers:object, rawBody?:string|Buffer, remoteAddress?:string}} req
   * @returns {{ok:true,keyId:string,ts:number,nonce:string}|{ok:false,code:number,message:string}}
   */
  function verify(req = {}) {
    const { method, path, headers, rawBody = '', remoteAddress } = req;

    // 0) 未配置任何密钥：本机开发模式（免鉴权），与 mcp-douyin-compass 口径一致
    if (Object.keys(keyTable).length === 0) {
      return { ok: true, keyId: 'open', ts: 0, nonce: '' };
    }

    // 1) 回环豁免：本机 / 同机进程直连，防重放防篡改无对象，直接放行
    if (loopbackBypass && isLoopbackAddress(remoteAddress)) {
      return { ok: true, keyId: 'local-trust', ts: 0, nonce: '' };
    }

    const rawHeader = headerValue(headers, 'authorization');
    if (!rawHeader) {
      return fail(
        ERROR_CODES.AUTH_FAILED,
        '缺少 Authorization 头：支持 Bearer <keyId:secret>（快速接入）或 MCP-HMAC 签名（高安全）',
      );
    }

    // 2) Bearer 静态令牌：兼容标准 API Key 调用方（Inspector / curl / 第三方 Agent），免算签名
    const bearer = /^Bearer[ \t]+(.+)$/i.exec(rawHeader);
    if (bearer) {
      const token = bearer[1].trim();
      const matchedKey = Object.keys(keyTable).find((key) => {
        const secret = keyTable[key];
        if (typeof secret !== 'string' || secret.length === 0) return false;
        return timingSafeEqualStr(`${key}:${secret}`, token) || timingSafeEqualStr(secret, token);
      });
      if (matchedKey) return { ok: true, keyId: matchedKey, ts: 0, nonce: '' };
      return fail(ERROR_CODES.AUTH_FAILED, 'Bearer Token 无效：应为 `<keyId>:<secret>` 或 `<secret>`');
    }

    // 3) MCP-HMAC 严格验签（跨公网高危通道）
    const parsed = parseAuthorization(rawHeader);
    if (!parsed) {
      return fail(
        ERROR_CODES.AUTH_FAILED,
        'Authorization 头格式错误：应为 `MCP-HMAC keyId=...,ts=...,nonce=...,sig=...` 或 `Bearer <token>`',
      );
    }

    const secret = keyTable[parsed.keyId];
    if (typeof secret !== 'string' || secret.length === 0) {
      // 不回显 keyId 之外的信息，也不回显密钥表内容
      return fail(ERROR_CODES.AUTH_FAILED, '未知的 keyId：服务端没有该密钥配置，请核对平台与服务端的密钥表');
    }

    const tsNum = Number(parsed.ts);
    if (!Number.isFinite(tsNum)) {
      return fail(ERROR_CODES.AUTH_FAILED, 'Authorization 头中的 ts 不是合法的 Unix 秒级时间戳');
    }

    const skewSec = now() / 1000 - tsNum;
    if (Math.abs(skewSec) > tolerance) {
      return fail(
        ERROR_CODES.AUTH_FAILED,
        `请求时间戳超出 ±${tolerance} 秒容差窗口，请校准调用方与服务器的系统时钟`,
      );
    }

    // nonce 必须是单 token 可打印 ASCII：含空白/逗号会破坏头解析，超长则视为异常输入
    if (!/^[\x21-\x7e]{1,200}$/.test(parsed.nonce)) {
      return fail(ERROR_CODES.AUTH_FAILED, 'Authorization 头中的 nonce 非法：需为 1~200 个可打印 ASCII 字符');
    }

    const expectedSig = hmacBase64Url(
      secret,
      signingString({
        method,
        path,
        ts: parsed.ts,
        nonce: parsed.nonce,
        bodyHash: sha256Hex(rawBody),
        keyId: parsed.keyId,
      }),
    );
    if (!timingSafeEqualStr(expectedSig, parsed.sig)) {
      return fail(
        ERROR_CODES.AUTH_FAILED,
        '签名校验失败：密钥、method、path、ts、nonce 与请求体必须与签名时完全一致（请求体被篡改也会导致失败）',
      );
    }

    // 签名通过后才消耗 nonce，避免攻击者用伪造签名烧掉合法请求的 nonce
    const t = now();
    const usedUntil = nonces.get(parsed.nonce);
    if (usedUntil != null && usedUntil > t) {
      return fail(
        ERROR_CODES.AUTH_REPLAY,
        `检测到重复 nonce（请求重放）：同一 nonce 在 ${Math.round(ttlMs / 1000)} 秒内只能使用一次，请为新请求生成新的 nonce`,
      );
    }
    nonces.set(parsed.nonce, t + ttlMs);

    return { ok: true, keyId: parsed.keyId, ts: tsNum, nonce: parsed.nonce };
  }

  /** 当前未过期 nonce 数量（观测/测试用） */
  function size() {
    purge();
    return nonces.size;
  }

  /** 清掉定时器与内存 nonce 表；可重复调用 */
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    nonces.clear();
  }

  return { verify, size, close };
}
