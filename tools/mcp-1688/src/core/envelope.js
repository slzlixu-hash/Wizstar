'use strict';

/**
 * 统一出参信封（规范 5.1）。
 *
 * 所有工具返回（成功或失败）都包装成：
 * { success, data, usage, error, server:{name,version,toolVersion,elapsedMs}, traceId, replayed }
 *
 * 平台调度引擎只依赖这个结构，不解析 MCP content 之外的任何私有格式。
 */

export const SERVER_INFO = Object.freeze({
  name: 'mcp-1688',
  version: '1.0.0',
  toolVersion: '1.0',
});

/** usage 段：1688 抓取本身不产生按次计费，默认 costCents=0 */
export function makeUsage(usage = {}) {
  return {
    costCents: Number.isFinite(usage.costCents) ? usage.costCents : 0,
    unit: usage.unit || 'call',
    quantity: Number.isFinite(usage.quantity) ? usage.quantity : 1,
  };
}

/**
 * 构造信封。
 * @param {object} o
 * @param {any} [o.data]
 * @param {object} [o.error] ContractError.toJSON() 的结果
 * @param {object} [o.usage]
 * @param {number} o.elapsedMs
 * @param {string} o.traceId
 * @param {boolean} [o.replayed]
 * @param {object} [o.server] 覆盖服务身份
 */
export function buildEnvelope({
  data = null,
  error = null,
  usage,
  elapsedMs = 0,
  traceId,
  replayed = false,
  server = SERVER_INFO,
} = {}) {
  const success = error == null;
  return {
    success,
    data: success ? data : null,
    usage: makeUsage(usage),
    error: success ? null : error,
    server: {
      name: server.name,
      version: server.version,
      toolVersion: server.toolVersion,
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
    },
    traceId,
    replayed: Boolean(replayed),
  };
}

export function okEnvelope(data, { usage, elapsedMs, traceId, replayed, server } = {}) {
  return buildEnvelope({ data, usage, elapsedMs, traceId, replayed, server });
}

export function errorEnvelope(error, { elapsedMs, traceId, replayed, server } = {}) {
  return buildEnvelope({
    error: typeof error?.toJSON === 'function' ? error.toJSON() : error,
    elapsedMs,
    traceId,
    replayed,
    server,
  });
}

/**
 * MCP 工具返回体：content 是给人/模型读的 JSON 文本，structuredContent 是同一信封，
 * 便于 MAF 直接结构化消费（MCP 2025-06-18 支持 outputSchema/structuredContent）。
 */
export function toToolResult(envelope) {
  const text = JSON.stringify(envelope, null, 2);
  return {
    content: [{ type: 'text', text }],
    structuredContent: envelope,
    ...(envelope.success ? {} : { isError: true }),
  };
}
