#!/usr/bin/env node
/**
 * 统一出参信封 + 契约错误码（规范 §5）
 *
 * 字段口径与 Wizstar.Contracts/Envelope.cs 逐字段对齐：
 *   { success, data, usage, error, server, traceId, replayed }
 *   usage  = { unit, quantity, costCents }
 *   error  = { code, message, retryable }
 *   server = { name, version, toolVersion, elapsedMs }
 *
 * 契约码共 8 个（40001/41001/42001/42002/43002/43009/43010/50001），
 * 另保留 50000 作为服务内部未分类异常（不上报为契约码）。
 */
'use strict';

const crypto = require('crypto');

const SERVER_NAME = 'mcp-douyin-compass';
const SERVER_VERSION = '1.0.0';
const TOOL_VERSION = '1.0';

const ErrorCodes = Object.freeze({
  ValidationError: 40001,     // 入参校验失败或字段缺失
  AuthFailed: 41001,          // HMAC 签名错误 / 凭证失效，不可重试
  RateLimited: 42001,         // 上游限频，指数退避可重试
  QuotaExhausted: 42002,      // 日调用额度用完，挂起告警
  PermissionDenied: 43002,    // 缺少类目权限 / 未开通功能
  IdempotencyConflict: 43009, // 相同 operationId 但参数被篡改
  BusinessRejected: 43010,    // 上游业务拒绝，透传原因
  NetworkError: 50001,        // 上游网络超时 / 连接失败，平台重试 3 次
  InternalError: 50000        // 内部未分类（异常兜底，不对外当契约码）
});

const CONTRACT_CODES = Object.freeze([
  40001, 41001, 42001, 42002, 43002, 43009, 43010, 50001
]);

/** 仅 42001 / 50001 允许自动重试，与 ErrorCodes.IsRetryable 一致。 */
function isRetryable(code) {
  return code === 42001 || code === 50001;
}

function newTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

function serverInfo(startedAt, toolVersion = TOOL_VERSION) {
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    toolVersion,
    elapsedMs: Math.max(0, Date.now() - startedAt)
  };
}

/**
 * 构造成功信封。
 * @param {*} data 业务负载
 * @param {object} opts { startedAt, traceId, replayed, usage, toolVersion }
 */
function ok(data, opts = {}) {
  const startedAt = Number.isFinite(opts.startedAt) ? opts.startedAt : Date.now();
  return {
    success: true,
    data: data === undefined ? null : data,
    usage: opts.usage || { costCents: 0, unit: 'call', quantity: 1 },
    error: null,
    server: serverInfo(startedAt, opts.toolVersion),
    traceId: opts.traceId || newTraceId(),
    replayed: Boolean(opts.replayed)
  };
}

/**
 * 构造失败信封。message 只放可展示给 Agent 的原因，不含凭证/Cookie。
 * @param {number} code 契约码
 */
function fail(code, message, opts = {}) {
  const startedAt = Number.isFinite(opts.startedAt) ? opts.startedAt : Date.now();
  const normalized = CONTRACT_CODES.includes(code) ? code : ErrorCodes.InternalError;
  return {
    success: false,
    data: null,
    usage: opts.usage || { costCents: 0, unit: 'call', quantity: 1 },
    error: {
      code: normalized,
      message: String(message || '未知错误'),
      retryable: isRetryable(normalized)
    },
    server: serverInfo(startedAt, opts.toolVersion),
    traceId: opts.traceId || newTraceId(),
    replayed: Boolean(opts.replayed)
  };
}

/** 幂等回放：把历史信封原样返回，仅改写 replayed=true。 */
function replayed(envelope) {
  if (!envelope || typeof envelope !== 'object') return ok(null, { replayed: true });
  return { ...envelope, replayed: true };
}

module.exports = {
  SERVER_NAME,
  SERVER_VERSION,
  TOOL_VERSION,
  ErrorCodes,
  CONTRACT_CODES,
  isRetryable,
  newTraceId,
  ok,
  fail,
  replayed
};
