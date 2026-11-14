'use strict';

/**
 * MAF 契约错误码（见《MAF 架构下 MCP 服务开发规范》5.2 统一错误码映射表）。
 *
 * 设计要点：
 * - MCP 工具必须把上游几百个私有错误码归一化后再暴露给 MAF；
 * - `retryable` 决定平台是否指数退避重试，必须准确；
 * - `category` 用于平台侧告警与人工介入分流；
 * - JSON-RPC 层错误（鉴权/传输）与工具层错误使用同一套码，便于平台统一处理。
 */
export const ERROR_CODES = Object.freeze({
  INVALID_PARAMS: 40001,
  AUTH_FAILED: 41001,
  AUTH_REPLAY: 41009,
  RATE_LIMITED: 42001,
  QUOTA_EXHAUSTED: 42002,
  PERMISSION_DENIED: 43002,
  IDEMPOTENCY_CONFLICT: 43009,
  BUSINESS_REJECTED: 43010,
  UPSTREAM_NETWORK: 50001,
});

/** 码 → 分类 / 是否可重试 / 默认 HTTP 状态（JSON-RPC 层用） */
const ERROR_META = Object.freeze({
  40001: { category: 'invalid_params', retryable: false, httpStatus: 400, label: '参数错误' },
  41001: { category: 'auth_failed', retryable: false, httpStatus: 401, label: '鉴权失败' },
  41009: { category: 'auth_replay', retryable: false, httpStatus: 401, label: '请求重放' },
  42001: { category: 'rate_limited', retryable: true, httpStatus: 429, label: '频控拦截' },
  42002: { category: 'quota_exhausted', retryable: false, httpStatus: 429, label: '配额耗尽' },
  43002: { category: 'permission_denied', retryable: false, httpStatus: 403, label: '权限不足' },
  43009: { category: 'idempotency_conflict', retryable: false, httpStatus: 409, label: '幂等冲突' },
  43010: { category: 'business_rejected', retryable: false, httpStatus: 422, label: '业务拒绝' },
  50001: { category: 'upstream_network', retryable: true, httpStatus: 502, label: '网络异常' },
});

export function errorMeta(code) {
  return ERROR_META[code] ?? { category: 'unknown', retryable: false, httpStatus: 500, label: '未知错误' };
}

/** 统一的契约错误：工具层与 HTTP/JSON-RPC 层都抛/序列化它 */
export class ContractError extends Error {
  /**
   * @param {number} code 契约错误码
   * @param {string} message 面向人/大模型的中文说明（会进入 error.message）
   * @param {object} [opts]
   * @param {boolean} [opts.retryable] 覆盖默认可重试性
   * @param {object} [opts.data] 附加结构化信息（如上游错误详情）
   * @param {object} [opts.upstream] 上游原始错误 { code, message }
   * @param {number} [opts.httpStatus] 覆盖默认 HTTP 状态
   */
  constructor(code, message, opts = {}) {
    super(message);
    const meta = errorMeta(code);
    this.name = 'ContractError';
    this.code = code;
    this.category = meta.category;
    this.retryable = opts.retryable ?? meta.retryable;
    this.httpStatus = opts.httpStatus ?? meta.httpStatus;
    this.label = meta.label;
    this.upstream = opts.upstream ?? null;
    this.data = opts.data ?? null;
  }

  /** 错误信封里的 error 段（不含 traceId/elapsedMs，由 envelope 补） */
  toJSON() {
    return {
      code: this.code,
      category: this.category,
      label: this.label,
      message: this.message,
      retryable: this.retryable,
      upstream: this.upstream,
      data: this.data,
    };
  }
}

export function isContractError(e) {
  return e instanceof ContractError;
}

/** 明确不可重试的输入/协议错误 */
export function invalidParams(message, data) {
  return new ContractError(ERROR_CODES.INVALID_PARAMS, message, { data });
}

/** 鉴权失败（HMAC/凭证/登录态/风控拦截） */
export function authFailed(message, data) {
  return new ContractError(ERROR_CODES.AUTH_FAILED, message, { data });
}

/** 幂等冲突：同 operationId 参数被篡改，或上一次仍在执行 */
export function idempotencyConflict(message, data) {
  return new ContractError(ERROR_CODES.IDEMPOTENCY_CONFLICT, message, { data });
}

/**
 * 把上游（1688 浏览器抓取 / mtop 接口 / 网络）错误归一化成契约错误。
 *
 * 归一化顺序：显式契约错误 → 网络/超时 → 频控/配额 → 权限 → 登录态/风控 → 业务拒绝。
 * 具体平台私有码只在 `upstream` 里保留，不向上暴露。
 */
export function normalizeUpstreamError(err) {
  if (err instanceof ContractError) return err;

  const rawMessage = String(err?.message || err || '未知错误');
  const msg = rawMessage.toLowerCase();
  // playwright 的 TimeoutError 常常只有 name 带 timeout 语义，必须一起看
  const haystack = `${String(err?.name || '').toLowerCase()} ${msg}`;
  const upstreamCode = err?.code ?? err?.errCode ?? err?.status ?? null;

  // 1) 网络 / 超时（playwright 的 TimeoutError、Node 的 ETIMEDOUT/ECONN*）
  if (
    /timeouterror|timeout|timedout|etimedout|etimeout|econnreset|econnrefused|enotfound|eai_again|socket hang up|net::err|network|fetch failed|目标计算机拒绝/.test(
      haystack,
    )
  ) {
    return new ContractError(ERROR_CODES.UPSTREAM_NETWORK, `上游网络异常：${rawMessage}`, {
      upstream: { code: upstreamCode, message: rawMessage },
    });
  }

  // 2) 频控 / 配额
  if (/rate.?limit|too many requests|429|限频|频率/.test(msg)) {
    return new ContractError(ERROR_CODES.RATE_LIMITED, `上游限频，建议指数退避后重试：${rawMessage}`, {
      upstream: { code: upstreamCode, message: rawMessage },
    });
  }
  if (/quota|额度|配额/.test(msg)) {
    return new ContractError(ERROR_CODES.QUOTA_EXHAUSTED, `上游调用配额耗尽：${rawMessage}`, {
      upstream: { code: upstreamCode, message: rawMessage },
    });
  }

  // 3) 权限
  if (/forbidden|permission|权限|无权限|未开通/.test(msg)) {
    return new ContractError(ERROR_CODES.PERMISSION_DENIED, `缺少上游权限：${rawMessage}`, {
      upstream: { code: upstreamCode, message: rawMessage },
    });
  }

  // 4) 登录态 / 滑块风控（1688 浏览器抓取特有）
  if (/not_logged_in|登录态|login\.1688|login\.taobao/.test(msg)) {
    return new ContractError(ERROR_CODES.AUTH_FAILED, `1688 登录态无效，请先完成扫码登录：${rawMessage}`, {
      upstream: { code: upstreamCode, message: rawMessage },
    });
  }
  if (/risk_control|punish|滑块|x5secdata|风控/.test(msg)) {
    return new ContractError(ERROR_CODES.AUTH_FAILED, `命中 1688 风控/滑块，需人工处理登录窗口：${rawMessage}`, {
      upstream: { code: upstreamCode, message: rawMessage },
    });
  }

  // 5) 业务拒绝（类目资质、重名、下架等）：如实透传原因供 Agent 决策
  return new ContractError(ERROR_CODES.BUSINESS_REJECTED, `上游业务拒绝：${rawMessage}`, {
    upstream: { code: upstreamCode, message: rawMessage },
  });
}
