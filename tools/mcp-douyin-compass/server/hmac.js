#!/usr/bin/env node
/**
 * 鉴权（规范 §2.2 扩展：三档可插拔）+ nonce 防重放
 *
 * 与 Wizstar.Mcp/McpHmacSigner.cs 严格对齐（HMAC 档）：
 *   签名原串 = {method}\n{path}\n{ts}\n{nonce}\n{sha256hex(rawBody)}\n{keyId}
 *   sig      = base64url(HMAC-SHA256(secret, 签名原串))
 *   Authorization: MCP-HMAC keyId=...,ts=...,nonce=...,sig=...
 *
 * 三档短路（兼顾安全与即插即用）：
 *   1. 回环豁免：127.0.0.1 / ::1 直连放行（WIZSTAR_COMPASS_AUTH_LOOPBACK_BYPASS=0 关闭）；
 *   2. Bearer 静态令牌：Authorization: Bearer <keyId:secret|secret>，第三方工具免算签名；
 *   3. MCP-HMAC 严格验签：跨公网高危通道，ts 容差 ±300s + nonce 一次性防重放。
 *
 * 安全口径：
 *   - GET /healthz 不带副作用，按规范免签（与 mcp-demo、McpJsonRpcClient.HealthProbeAsync 一致）。
 *   - POST /mcp 在配置 WIZSTAR_COMPASS_HMAC_SECRET 后启用鉴权；未配置时本地开发放行。
 *   - keyId 必须与配置的 WIZSTAR_COMPASS_HMAC_KEY_ID 匹配（配置了才校验）。
 */
'use strict';

const crypto = require('crypto');
const { ErrorCodes } = require('./envelope');

const HEADER_RE = /^MCP-HMAC keyId=([^,]+),ts=(\d+),nonce=([^,]+),sig=([A-Za-z0-9_-]+)$/;
/** 时间戳容差 ±300s（规范 §2.2，防过期）。 */
const TS_TOLERANCE_SECONDS = 300;
/** nonce 防重放窗口 600s（规范 §2.2 Replay Guard），与时间戳容差是两个独立窗口。 */
const NONCE_TTL_SECONDS = 600;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value || '', 'utf8').digest('hex');
}

function stringToSign(method, path, ts, nonce, bodyHash, keyId) {
  return [method, path, ts, nonce, bodyHash, keyId].join('\n');
}

function sign(secret, text) {
  return crypto.createHmac('sha256', secret).update(text, 'utf8').digest('base64url');
}

/** 供冒烟测试 / 客户端构造 Authorization 头（口径与 C# 完全一致）。 */
function buildAuthorizationHeader({ keyId, secret, method = 'POST', path = '/mcp', body = '', ts, nonce }) {
  const timestamp = ts === undefined ? Math.floor(Date.now() / 1000) : ts;
  const n = nonce || crypto.randomBytes(16).toString('hex');
  const sig = sign(secret, stringToSign(method, path, timestamp, n, sha256Hex(body), keyId));
  return `MCP-HMAC keyId=${keyId},ts=${timestamp},nonce=${n},sig=${sig}`;
}

/**
 * nonce 去重表：内存态，按 ts 容差窗口自动淘汰。
 * 仅保存签名校验通过后的 nonce，避免攻击者用非法签名撑爆内存。
 */
class NonceGuard {
  constructor(windowSeconds = NONCE_TTL_SECONDS) {
    this.windowMs = windowSeconds * 1000;
    this.seen = new Map(); // `${keyId}:${nonce}` -> expiresAt(ms)
    this.lastSweep = Date.now();
  }

  /** 返回 true 表示可放行（首次出现），false 表示重放。 */
  consume(keyId, nonce, tsSeconds) {
    const now = Date.now();
    if (now - this.lastSweep > 60_000) this.sweep(now);

    const key = `${keyId}:${nonce}`;
    const hit = this.seen.get(key);
    if (hit !== undefined && hit > now) return false;

    // 以签名时间戳为基准，保留到容差窗口结束；防止窗口边界重放
    const expiresAt = Math.max(now + 1000, Number(tsSeconds) * 1000 + this.windowMs);
    this.seen.set(key, expiresAt);
    return true;
  }

  sweep(now = Date.now()) {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key);
    }
    this.lastSweep = now;
  }

  get size() {
    return this.seen.size;
  }
}

/** 是否本机回环地址（含 IPv4 映射 IPv6 形式）：单机部署 / 同机进程间调用可免签直连 */
function isLoopbackAddress(address) {
  const value = String(address || '').replace(/^::ffff:/i, '');
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

/** 等长常量时间比较（长度差异先短路，避免 timingSafeEqual 抛错） */
function timingSafeEqualStr(expected, provided) {
  const a = Buffer.from(String(expected), 'utf8');
  const b = Buffer.from(String(provided), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 校验请求（三档短路：回环豁免 → Bearer 静态令牌 → MCP-HMAC 严格验签）。
 * @param {object} req      Node IncomingMessage
 * @param {string} rawBody  原始请求体（未解析）
 * @param {object} cfg      { secret, keyId, nonceGuard, loopbackBypass }
 * @returns {{ok:boolean, code?:number, message?:string, via?:string}}
 */
function verifyHmac(req, rawBody, cfg) {
  const secret = cfg.secret || '';
  if (!secret) return { ok: true, via: 'open' }; // 未配置密钥：本地开发放行（日志会明确标注 hmac=off）

  // 1) 回环豁免：本机直连免签（cfg.loopbackBypass === false 时关闭，跨机部署强制验签）
  if (cfg.loopbackBypass !== false && isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
    return { ok: true, via: 'loopback' };
  }

  const header = req.headers['authorization'] || '';

  // 2) Bearer 静态令牌：`<keyId>:<secret>` 或裸 `<secret>`，第三方工具免算签名秒级接入
  const bearer = /^Bearer[ \t]+(.+)$/i.exec(header);
  if (bearer) {
    const token = bearer[1].trim();
    const pair = cfg.keyId ? `${cfg.keyId}:${secret}` : null;
    if ((pair && timingSafeEqualStr(pair, token)) || timingSafeEqualStr(secret, token)) {
      return { ok: true, via: 'bearer' };
    }
    return {
      ok: false,
      code: ErrorCodes.AuthFailed,
      message: 'Bearer Token 无效：应为 `<keyId>:<secret>` 或 `<secret>`',
    };
  }

  // 3) MCP-HMAC 严格验签
  const match = HEADER_RE.exec(header);
  if (!match) {
    return {
      ok: false,
      code: ErrorCodes.AuthFailed,
      message: '缺少或非法的 Authorization 头：支持 Bearer <token>（快速接入）或 MCP-HMAC 签名',
    };
  }

  const [, keyId, tsRaw, nonce, sig] = match;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TS_TOLERANCE_SECONDS) {
    return { ok: false, code: ErrorCodes.AuthFailed, message: '时间戳超出容差（±300s）' };
  }

  if (cfg.keyId && keyId !== cfg.keyId) {
    return { ok: false, code: ErrorCodes.AuthFailed, message: 'keyId 不匹配' };
  }

  const path = String(req.url || '').split('?')[0] || '/mcp';
  const method = String(req.method || 'POST').toUpperCase();
  const expected = sign(secret, stringToSign(method, path, tsRaw, nonce, sha256Hex(rawBody), keyId));

  // 定长比较，避免时序侧信道
  if (!timingSafeEqualStr(expected, sig)) {
    return { ok: false, code: ErrorCodes.AuthFailed, message: '签名不符' };
  }

  const guard = cfg.nonceGuard || (cfg.nonceGuard = new NonceGuard());
  if (!guard.consume(keyId, nonce, ts)) {
    // 规范 §2.2 提到专用码 41009，但 §5.2 契约码表与 Wizstar.Contracts.ErrorCodes 均未收录，
    // 按「错误码归一化」铁律收敛为 41001（鉴权失败），原因在 message 里如实标注。
    return { ok: false, code: ErrorCodes.AuthFailed, message: 'nonce 重放（规范 §2.2 / 41009，已归一化）' };
  }

  return { ok: true };
}

module.exports = {
  HEADER_RE,
  TS_TOLERANCE_SECONDS,
  NONCE_TTL_SECONDS,
  sha256Hex,
  stringToSign,
  sign,
  buildAuthorizationHeader,
  NonceGuard,
  isLoopbackAddress,
  verifyHmac
};
