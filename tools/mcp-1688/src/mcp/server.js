'use strict';

/**
 * MCP 服务层：把工具目录挂到低层 MCP Server 上，并在 tools/call 里统一实现
 * 规范要求的横切逻辑：参数校验、凭证隔离、幂等账本、信封输出、错误归一化、traceId。
 *
 * 使用低层 Server（而不是 McpServer.tool 的高层封装）的原因：
 * - tools/list 必须能注入 x-risk（顶层自定义字段）与 tier 元数据；
 * - tools/call 需要完全控制返回信封与错误码，而不是 MCP 的通用 isError。
 */
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { validate } from '../core/validate.js';
import {
  ContractError,
  ERROR_CODES,
  authFailed,
  idempotencyConflict,
  invalidParams,
  normalizeUpstreamError,
} from '../core/errors.js';
import { errorEnvelope, okEnvelope, toToolResult } from '../core/envelope.js';
import { assertOperationId, findTool, toMcpTool, visibleTools } from '../tools/catalog.js';
import { assertNoSecretsInBody } from '../security/credentials.js';

export const TRACE_HEADER = 'x-trace-id';
const TRACE_RE = /^[0-9a-f]{32}$/;

export function newTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

export function resolveTraceId(headerValue) {
  const v = String(headerValue || '').trim().toLowerCase();
  return TRACE_RE.test(v) ? v : newTraceId();
}

/** 稳定序列化（键排序、数组保序），用于幂等参数指纹 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** 执行超时：超时按网络异常 50001 归一化（上游可能仍在跑，写操作可通过 operationId 对账） */
function withTimeout(promise, ms, toolName) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new ContractError(ERROR_CODES.UPSTREAM_NETWORK, `工具 ${toolName} 执行超时（${ms}ms）`, { retryable: true }));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function elapsedMsOf(startedNs) {
  return Number(process.hrtime.bigint() - startedNs) / 1e6;
}

/**
 * 执行一次工具调用（含幂等/信封）。返回 MCP CallToolResult。
 * @param {string} name
 * @param {object} args
 * @param {object} ctx 请求上下文（见 src/http/server.js）
 */
export async function callTool(name, args, ctx) {
  const startedNs = process.hrtime.bigint();
  const traceId = ctx.traceId;
  const tool = findTool(name);

  const finishError = (err, replayed = false) => {
    const ce = normalizeUpstreamError(err);
    return toToolResult(
      errorEnvelope(ce, { elapsedMs: elapsedMsOf(startedNs), traceId, replayed }),
    );
  };

  if (!tool) return finishError(invalidParams(`未知工具：${name}（可通过 meta.describe 查看目录）`));

  // 1) 参数结构校验 → 40001
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const v = validate(tool.inputSchema, input);
  if (!v.ok) {
    const detail = v.errors.map((e) => `${e.path} ${e.message}`).join('；');
    return finishError(invalidParams(`参数校验失败：${detail}`, { errors: v.errors }));
  }

  // 2) 凭证隔离：密钥只允许走 HTTP 头，禁止进入 JSON-RPC 参数体
  try {
    assertNoSecretsInBody(input);
  } catch (e) {
    return finishError(e);
  }

  const mutating = tool.risk !== 'read';
  let operationId = null;
  let paramsHash = null;

  if (mutating) {
    try {
      assertOperationId(input.operationId, tool.name);
    } catch (e) {
      return finishError(e);
    }
    if (!ctx.shopKey) {
      return finishError(
        authFailed('写操作必须携带 X-Shop-Credential（base64url(JSON.stringify({appId,appSecret,shopId}))）', {
          tool: tool.name,
        }),
      );
    }
    operationId = input.operationId;
    const { operationId: _omit, ...rest } = input;
    paramsHash = sha256Hex(canonicalJson(rest));
  }

  // 3) 并发闸门：必须在账本 begin 之前判断，否则早退会把账本行留在 EXECUTING，
  //    平台用同一 operationId 重试会被误判为 in_progress（43009）。
  const stats = ctx.stats || {};
  if (Number.isFinite(stats.active) && Number.isFinite(stats.maxConcurrency) && stats.active >= stats.maxConcurrency) {
    return finishError(
      new ContractError(ERROR_CODES.RATE_LIMITED, `本服务并发已达上限（${stats.maxConcurrency}），请稍后重试`, {
        retryable: true,
      }),
    );
  }

  // 4) 幂等账本
  let beginResult = null;
  if (mutating) {
    beginResult = ctx.ledger.begin({
      shopKey: ctx.shopKey,
      operationId,
      tool: tool.name,
      paramsHash,
      paramsJson: canonicalJson(input),
      traceId,
    });

    if (beginResult.state === 'tampered') {
      return finishError(
        idempotencyConflict('相同 operationId 的请求参数与首次调用不一致，判定为状态错乱，拒绝执行', {
          operationId,
          tool: tool.name,
        }),
      );
    }
    if (beginResult.state === 'in_progress') {
      return finishError(
        idempotencyConflict('相同 operationId 的操作仍在执行中，拒绝重复提交', { operationId, tool: tool.name }),
      );
    }
    if (beginResult.state === 'replay') {
      const rec = beginResult.record;
      // 可重试的失败允许平台以同一 operationId 重试（50001/42001），不算终态
      const retryableFailure = rec?.status === 'FAILED' && rec?.error?.retryable === true;
      if (!retryableFailure) {
        if (rec.status === 'SUCCEEDED') {
          return toToolResult(
            okEnvelope(rec.result, { elapsedMs: elapsedMsOf(startedNs), traceId, replayed: true }),
          );
        }
        const err = rec.error || { message: '历史操作失败', code: ERROR_CODES.BUSINESS_REJECTED, retryable: false };
        return toToolResult(errorEnvelope(err, { elapsedMs: elapsedMsOf(startedNs), traceId, replayed: true }));
      }
    }
  }

  // 5) 执行工具（并发计数在真正调用上游时才占用）
  if (stats.active != null) stats.active += 1;

  try {
    const data = await withTimeout(
      Promise.resolve().then(() => tool.invoke({ args: input, ctx })),
      ctx.stats?.toolTimeoutMs,
      tool.name,
    );
    if (mutating) {
      ctx.ledger.complete({ shopKey: ctx.shopKey, operationId, result: data ?? null, traceId });
    }
    return toToolResult(okEnvelope(data ?? null, { elapsedMs: elapsedMsOf(startedNs), traceId }));
  } catch (e) {
    const ce = normalizeUpstreamError(e);
    if (mutating) {
      ctx.ledger.fail({ shopKey: ctx.shopKey, operationId, error: ce.toJSON(), traceId });
    }
    return finishError(ce);
  } finally {
    if (stats.active != null) stats.active -= 1;
  }
}

/**
 * 创建一个绑定请求上下文的低层 MCP Server（每个 HTTP 请求一个实例，Stateless）。
 */
export function createMcpServer(ctx) {
  const server = new Server(
    { name: 'mcp-1688', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: '1688 sourcing MCP：语义工具面向采购 Agent，通用原子工具默认隐藏，写操作受幂等账本与 HITL 保护。' },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = visibleTools({ includeGeneric: Boolean(ctx.includeGeneric) }).map(toMcpTool);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return callTool(name, args ?? {}, ctx);
  });

  return server;
}
