#!/usr/bin/env node
/**
 * 工具目录（7 个，规范 §3「≤10 个高频语义工具」；平台已取消工具数硬上限）
 *
 * 命名口径（重要）：Wizstar.Agents/Governance/RiskClassifier.cs 按工具名「开头」做动词兜底，
 *   ReadPrefixes = get_ / query_ / search_ / list_ / fetch_ / count_ / meta.
 *   WritePrefixes = create_ / update_ / save_ / sync_ / submit_ / import_
 *   且「x-risk 只升不降」：显式声明 read 无法压过动词推断出的 write。
 * 因此语义工具一律用 get_compass_* 前缀（而非 compass.sync_*），才能在平台侧真正按
 * read 免审批放行；meta 三件套用 meta. 前缀，天然 read。
 *
 * 所有工具均为 read：本服务只做「采集 → 归一化 → 返回结构化清单」，
 * 不写平台业务主库（规范 §1.1 铁律），写业务库由 Wizstar.Api / Agent 层决定。
 */
'use strict';

const { ErrorCodes, ok, fail } = require('./envelope');

/** 工具内部可抛出的契约错误，由 index.js 统一转成失败信封。 */
class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 步骤 2/5 之前，桥接与探针尚未就绪时统一返回可读的离线错误，绝不伪造成功或伪造在线。 */
function bridgeNotReady(ctx, feature) {
  const state = ctx.probeState ? ctx.probeState() : { connected: false };
  if (state.connected) return null;
  return new ToolError(
    ErrorCodes.NetworkError,
    `${feature} 需要罗盘页面探针：当前 WS 桥接未连接（${state.reason || 'bridge 尚未接线'}）。` +
      `请在已登录抖店罗盘的浏览器安装 extension-mv3/ 后再调用。`
  );
}

// ------------------------------------------------------------------ meta 三件套

function metaHealth(args, ctx) {
  const probe = ctx.probeState ? ctx.probeState() : { connected: false, reason: 'bridge 尚未接线' };
  return {
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    protocolVersion: ctx.protocolVersion,
    server: { name: ctx.serverName, version: ctx.serverVersion },
    // 规范 §6：活跃 Token 状态（本服务不使用 Token，凭证是浏览器页面会话 Cookie，
    // 只留在浏览器主世界，绝不进入消息体 / 日志 / Prompt —— 规范 §2.3 安全红线）
    credential: {
      mode: 'page-session-cookie',
      tokenActive: false,
      note: '不使用 Token；罗盘凭证留在浏览器主世界，探针只回传响应体'
    },
    probe: {
      connected: Boolean(probe.connected),
      reason: probe.reason || null,
      tabs: probe.tabs || 0,
      loggedIn: Boolean(probe.loggedIn),
      generation: probe.generation === undefined ? null : probe.generation
    },
    ledger: ctx.ledgerStats
      ? ctx.ledgerStats()
      : { available: false, entries: 0, note: '幂等账本将在步骤 2 接入' },
    toolCount: ctx.tools.length,
    hmac: ctx.hmacEnabled ? 'on' : 'off'
  };
}

function metaDescribe(args, ctx) {
  return {
    protocol: {
      transport: 'Streamable HTTP',
      jsonRpc: '2.0',
      protocolVersion: ctx.protocolVersion
    },
    server: { name: ctx.serverName, version: ctx.serverVersion },
    toolVersion: '1.0',
    limits: {
      maxConcurrency: 1, // 罗盘页面同一时刻只允许一个采集任务，避免并发翻页触发风控
      toolCount: ctx.tools.length,
      probeTimeoutMs: 20000,
      ledgerRetentionDays: 30
    },
    capabilities: {
      semanticTools: true,
      genericTools: false,
      note: '本期仅暴露 4 个高阶语义工具；底层原子接口不直接暴露给 LLM（规范 §1.3）'
    },
    // 规范 §6：Schema 目录清单（平台注册的唯一元数据源）
    schemas: ctx.tools.map((t) => ({
      name: t.name,
      description: t.description,
      'x-risk': t.xRisk,
      inputSchema: t.inputSchema
    })),
    dictionaries: {
      rankTypes: ctx.rankTypes || [],
      secondFilterFields: ctx.secondFilterFields || {},
      note: 'filters 的 value 为桶下标字符串；可用 describeFields(rankType) 取桶清单'
    },
    dataSource: {
      site: 'compass.jinritemai.com',
      mode: 'borrowed-page-session',
      note: '借已登录页面会话发起站内请求；不实现 a_bogus 签名、不绕过滑块风控'
    }
  };
}

function metaListOperations(args, ctx) {
  // 规范 §6：入参 { operationIds: string[], since: timestamp }，用于孤儿对账。
  const operationIds = Array.isArray(args.operationIds)
    ? args.operationIds.filter((x) => typeof x === 'string')
    : [];
  const since = args.since === undefined ? null : args.since;

  if (!ctx.ledgerList) {
    return {
      available: false,
      total: 0,
      operations: [],
      note: '幂等账本将在步骤 2 接入；当前无历史操作可对账'
    };
  }
  const rows = ctx.ledgerList({ operationIds, since });
  return {
    available: true,
    total: rows.length,
    operations: rows
  };
}

// ------------------------------------------------------------------ 4 个语义工具
// 步骤 1 仅定义 schema 与离线守卫；真实采集链路在步骤 5 接入（bridge → probe → parser → filter）。

function compassCategories(args, ctx) {
  const err = bridgeNotReady(ctx, '类目树同步');
  if (err) throw err;
  return ctx.compass.syncCategories(args);
}

function compassProductRank(args, ctx) {
  const err = bridgeNotReady(ctx, '商品榜单采集');
  if (err) throw err;
  return ctx.compass.fetchProductRank(args);
}

function compassSearchWords(args, ctx) {
  const err = bridgeNotReady(ctx, '搜索词分析');
  if (err) throw err;
  return ctx.compass.fetchSearchWords(args);
}

function compassWordProducts(args, ctx) {
  const err = bridgeNotReady(ctx, '词下商品采集');
  if (err) throw err;
  return ctx.compass.fetchWordProducts(args);
}

// ------------------------------------------------------------------ 目录

const TOOLS = [
  {
    name: 'meta.health',
    description: '服务探活：运行状态、Uptime、凭证模式、罗盘探针连接/登录态、账本条目数。',
    xRisk: 'read',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    execute: metaHealth
  },
  {
    name: 'meta.describe',
    description: '服务自述：协议版本、工具版本、Schema 目录清单、并发限额与数据来源。平台注册的元数据源。',
    xRisk: 'read',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    execute: metaDescribe
  },
  {
    name: 'meta.list_operations',
    description: '按 operationIds 或 since 反查本地幂等账本，供任务超时/断网后的孤儿对账。',
    xRisk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        operationIds: {
          type: 'array',
          items: { type: 'string' },
          description: '待对账的操作流水号列表（平台下发的 op-{taskId}-{stepCode}-{hash16}）'
        },
        since: {
          type: ['integer', 'string', 'null'],
          description: '起始时间戳（Unix 秒/毫秒或 ISO 字符串），返回此时间之后的操作'
        }
      }
    },
    execute: metaListOperations
  },
  {
    name: 'get_compass_categories',
    description: '同步抖店罗盘类目树到本地缓存（仅服务内部缓存，不写平台业务库）。返回类目层级与可选叶子类目。',
    xRisk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        forceRefresh: { type: 'boolean', description: '忽略本地缓存强制重新捕获，默认 false' },
        operationId: { type: 'string', description: '平台下发的幂等操作流水号（可选）' }
      }
    },
    execute: compassCategories
  },
  {
    name: 'get_compass_product_rank',
    description: '采集抖店罗盘「商品榜单」：按榜单类型分页拉取，归一化后按二级指标筛选，返回立项摘要与 Top 商品清单。',
    xRisk: 'read',
    inputSchema: {
      type: 'object',
      required: ['rankType'],
      properties: {
        rankType: {
          type: 'string',
          description: '榜单名（总榜/搜索榜/直播榜/商品卡榜/达人带货榜/短视频榜/实时爆品挖掘榜/退后购买榜/同行低退榜）或规则 id（rank_total 等）'
        },
        categoryId: { type: 'string', description: '类目 id（可选，缺省为全部类目）' },
        dateRange: { type: 'string', description: '统计周期，如 day / week / month（可选）' },
        pages: { type: 'integer', description: '翻页数上限，默认 1，最大 10' },
        filters: { type: 'object', description: '二级筛选条件（c1 字典指标 + 阈值），见筛选 DSL' },
        operationId: { type: 'string', description: '平台下发的幂等操作流水号（可选）' }
      }
    },
    execute: compassProductRank
  },
  {
    name: 'get_compass_search_words',
    description: '采集抖店罗盘「搜索词分析」：先取最新可用日期，再分页拉取行业搜索词榜单并归一化。',
    xRisk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        categoryId: { type: 'string', description: '类目 id（可选）' },
        dateRange: { type: 'string', description: '统计周期（可选，缺省取罗盘最新日期）' },
        pages: { type: 'integer', description: '翻页数上限，默认 1，最大 10' },
        filters: { type: 'object', description: '搜索词二级筛选条件' },
        operationId: { type: 'string', description: '平台下发的幂等操作流水号（可选）' }
      }
    },
    execute: compassSearchWords
  },
  {
    name: 'get_compass_word_products',
    description: '按搜索词逐个采集「词下商品」明细（industry_detail_list_v2），过滤后返回结构化商品清单。',
    xRisk: 'read',
    inputSchema: {
      type: 'object',
      required: ['words'],
      properties: {
        words: {
          type: 'array',
          items: { type: 'string' },
          description: '搜索词列表（通常来自 get_compass_search_words 的结果）'
        },
        pages: { type: 'integer', description: '每个词的翻页数上限，默认 1，最大 5' },
        filters: { type: 'object', description: '商品二级筛选条件' },
        operationId: { type: 'string', description: '平台下发的幂等操作流水号（可选）' }
      }
    },
    execute: compassWordProducts
  }
];

/** 执行工具并统一包信封；ToolError 归一化为契约码，其他异常兜底 50000。 */
async function invoke(tool, args, ctx, opts = {}) {
  const startedAt = Date.now();
  const traceId = opts.traceId;
  try {
    if (!tool) throw new ToolError(ErrorCodes.ValidationError, '未知工具');
    validateArgs(tool, args);
    const data = await tool.execute(args || {}, ctx);
    return ok(data, { startedAt, traceId, toolVersion: '1.0' });
  } catch (e) {
    if (e instanceof ToolError) {
      return fail(e.code, e.message, { startedAt, traceId, toolVersion: '1.0' });
    }
    return fail(
      ErrorCodes.InternalError,
      `工具执行异常：${e && e.message ? e.message : String(e)}`,
      { startedAt, traceId, toolVersion: '1.0' }
    );
  }
}

/** 轻量入参校验：required + 基本类型；不做严格 JSON Schema 全量校验（零依赖）。 */
function validateArgs(tool, args) {
  const schema = tool.inputSchema || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const props = schema.properties || {};
  for (const key of required) {
    const value = (args || {})[key];
    if (value === undefined || value === null || value === '') {
      throw new ToolError(ErrorCodes.ValidationError, `缺少必填参数 ${key}`);
    }
  }
  for (const [key, value] of Object.entries(args || {})) {
    const rule = props[key];
    if (!rule || value === undefined || value === null) continue;
    if (rule.type === 'integer' && (!Number.isInteger(value) || value < 0)) {
      throw new ToolError(ErrorCodes.ValidationError, `参数 ${key} 必须是非负整数`);
    }
    if (rule.type === 'array' && !Array.isArray(value)) {
      throw new ToolError(ErrorCodes.ValidationError, `参数 ${key} 必须是数组`);
    }
    if (rule.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
      throw new ToolError(ErrorCodes.ValidationError, `参数 ${key} 必须是对象`);
    }
    if (rule.type === 'boolean' && typeof value !== 'boolean') {
      throw new ToolError(ErrorCodes.ValidationError, `参数 ${key} 必须是布尔值`);
    }
  }
  // 翻页数硬上限：避免一次任务过长触发平台风控
  const maxPages = tool.name === 'get_compass_word_products' ? 5 : 10;
  if (args && typeof args.pages === 'number' && args.pages > maxPages) {
    throw new ToolError(ErrorCodes.ValidationError, `pages 不能超过 ${maxPages}`);
  }
  if (args && Array.isArray(args.words) && args.words.length > 30) {
    throw new ToolError(ErrorCodes.ValidationError, 'words 一次最多 30 个');
  }
}

module.exports = { TOOLS, ToolError, invoke, validateArgs, ok, fail };
