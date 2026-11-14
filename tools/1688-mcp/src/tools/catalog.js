'use strict';

/**
 * 工具目录（MAF 规范第 3 章：语义工具 / 通用原子工具 / 元工具三类分层）。
 *
 * - semantic：直接面向 Agent LLM 的高阶工具，≤8 个，入参扁平、聚合多步；
 * - generic：底层原子接口（对齐 1688 页面/mtop 接口），默认对 LLM 隐身，
 *   仅底层代码调度、兜底或 JIT 动态挂载时可通过 tools/call 调用；
 * - meta：固定 3 个，探活 / 目录自述 / 孤儿对账。
 *
 * 每个工具都声明 x-risk：read（免审批）/ write（可逆，试运行）/ irreversible（强制 HITL）。
 */
import { ContractError, ERROR_CODES } from '../core/errors.js';
import { SERVER_INFO } from '../core/envelope.js';
import { PRESETS, GUARANTEE_LABELS, VALUE_ADDED_LABELS, applyFilters, resolveFilters } from '../domain/supplier-filters.js';

export const RISK = Object.freeze({ READ: 'read', WRITE: 'write', IRREVERSIBLE: 'irreversible' });

const OFFER_ID = { type: 'string', pattern: '^\\d{6,20}$', description: '1688 商品 id（纯数字，如 674199987929）' };
const OPERATION_ID = {
  type: 'string',
  minLength: 8,
  maxLength: 128,
  pattern: '^op-[A-Za-z0-9._:-]+$',
  description: '由 MAF 平台下发的唯一幂等操作流水号，格式 op-{taskId}-{stepCode}-{contentHash16}；同一 operationId 重放会回放历史结果',
};
const SUM_SORTS = ['relevance', 'best-selling', 'price-asc', 'price-desc'];

/** 参数规范化：去掉 undefined，避免 JSON 序列化差异影响幂等参数指纹 */
function clean(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) if (v !== undefined) out[k] = v;
  return out;
}

/** 元工具返回的并发/运行态快照 */
function healthSnapshot(ctx) {
  const s = ctx.stats || {};
  return {
    status: 'ok',
    server: SERVER_INFO,
    protocolVersion: ctx.protocolVersion,
    uptimeMs: s.uptimeMs ?? 0,
    startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
    mode: s.adapterMode || 'unknown',
    ledger: { entries: s.ledgerCount ?? 0, retentionDays: s.retentionDays ?? 30 },
    credentials: { cachedShops: s.credentialCount ?? 0 },
    browser: s.browserBusy ? 'busy' : 'idle',
    concurrency: { active: s.active ?? 0, max: s.maxConcurrency ?? 0 },
  };
}

function catalogEntry(tool) {
  return {
    name: tool.name,
    tier: tool.tier,
    risk: tool.risk,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

export const TOOLS = [
  /* ============================ 语义工具（7） ============================ */
  {
    name: 'search_products',
    tier: 'semantic',
    risk: RISK.READ,
    description:
      '按关键词搜索 1688 商品，返回价格区间、供应商、产地、经营年限、30 天成交与复购率等结构化结果。只读操作，可直接调用，无需审批。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 120, description: '搜索关键词，例如「艾草防臭鞋垫」' },
        max: { type: 'integer', minimum: 1, maximum: 60, description: '返回条数，默认 20，最多 60' },
        sort: { type: 'string', enum: SUM_SORTS, description: '排序方式，默认 relevance（相关度）；best-selling=30天成交降序' },
      },
    },
    async invoke({ args, ctx }) {
      const a = clean(args);
      const r = await ctx.adapters.searchOffers({ query: a.query, max: a.max ?? 20, sort: a.sort ?? 'relevance' });
      return { query: r.query, sort: r.sort, total: r.total, offers: r.offers, source: ctx.adapters.mode };
    },
  },
  {
    name: 'search_by_image',
    tier: 'semantic',
    risk: RISK.READ,
    description:
      '以图搜款：上传本地图片绝对路径或图片 URL，返回 1688 上的同款/相似款商品列表。只读操作，可直接调用。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['image'],
      properties: {
        image: { type: 'string', minLength: 4, description: '本地图片绝对路径，或 http(s) 图片 URL' },
        max: { type: 'integer', minimum: 1, maximum: 60, description: '返回条数，默认 20' },
      },
    },
    async invoke({ args, ctx }) {
      const a = clean(args);
      const r = await ctx.adapters.searchByImage({ image: a.image, max: a.max ?? 20 });
      return { image: r.image, imageId: r.imageId, resultUrl: r.resultUrl, total: r.total, offers: r.offers, source: ctx.adapters.mode };
    },
  },
  {
    name: 'get_offer',
    tier: 'semantic',
    risk: RISK.READ,
    description: '获取单个 1688 商品的详情：标题、价格区间、起订量、供应商、SKU 属性与 SKU 列表。只读操作，可直接调用。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['offerId'],
      properties: { offerId: OFFER_ID },
    },
    async invoke({ args, ctx }) {
      return ctx.adapters.getOffer({ offerId: clean(args).offerId });
    },
  },
  {
    name: 'compare_suppliers',
    tier: 'semantic',
    risk: RISK.READ,
    description:
      '批量对比 2~10 个 1688 商品的供应商与报价：价格、起订量、30 天成交、复购率、工厂认证、产地，并给出最低价与最畅销推荐。只读操作，可直接调用。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['offerIds'],
      properties: {
        offerIds: {
          type: 'array',
          minItems: 2,
          maxItems: 10,
          items: OFFER_ID,
          description: '待对比的商品 id 列表（2~10 个）',
        },
        metrics: {
          type: 'array',
          items: { type: 'string', enum: ['price', 'sales', 'repurchase', 'verified', 'location'] },
          description: '关注指标，缺省返回全部',
        },
      },
    },
    async invoke({ args, ctx }) {
      const a = clean(args);
      const want = new Set(a.metrics || ['price', 'sales', 'repurchase', 'verified', 'location']);
      const rows = [];
      let firstError = null;
      for (const offerId of a.offerIds) {
        try {
          const o = await ctx.adapters.getOffer({ offerId });
          rows.push({
            offerId: String(offerId),
            title: o.title,
            ...(want.has('price') ? { price: o.price, moq: o.moq ?? null } : {}),
            supplier: o.supplier,
            ...(want.has('location') ? { location: o.location } : {}),
            ...(want.has('sales') ? { sales30d: o.demand?.orderCount ?? null, salesText: o.demand?.orderCountText ?? null } : {}),
            ...(want.has('repurchase') ? { repurchaseRate: o.demand?.repurchaseRate ?? null } : {}),
            ...(want.has('verified') ? { verified: o.verified } : {}),
            tags: o.tags || [],
          });
        } catch (e) {
          firstError = firstError || e;
          rows.push({ offerId: String(offerId), error: String(e?.message || e) });
        }
      }
      const okRows = rows.filter((r) => !r.error);
      if (!okRows.length) throw firstError || new Error('所有商品详情获取失败');
      const byPrice = [...okRows].filter((r) => r.price?.min != null).sort((x, y) => x.price.min - y.price.min);
      const bySales = [...okRows].filter((r) => r.sales30d != null).sort((x, y) => y.sales30d - x.sales30d);
      return {
        total: rows.length,
        rows,
        cheapestOfferId: byPrice[0]?.offerId ?? null,
        bestSellingOfferId: bySales[0]?.offerId ?? null,
        source: ctx.adapters.mode,
      };
    },
  },
  {
    name: 'filter_suppliers',
    tier: 'semantic',
    risk: RISK.READ,
    description:
      '按 MAF 下发的供应商过滤条件筛选 1688 货源：发货时效、揽收率、退款率、服务保障、履约质量（综合体验分）、增值服务。条件可直接使用筛选面板的中文标签（如「24小时揽收率≥95%」「总退款率≤3%」），也可用 preset 选用「优先高质量(pass)/默认低价」策略。返回命中的供应商指标与未命中原因，只读操作。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keywords: { type: 'string', minLength: 1, maxLength: 120, description: '候选货源关键词；与 offerIds 二选一或同时给' },
        offerIds: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: OFFER_ID,
          description: '直接在这些商品 id 上筛选供应商',
        },
        preset: {
          type: 'string',
          enum: ['priority_quality', 'default_price'],
          description: '优先策略（严格、高质量）/ 默认策略（宽松、低价）；显式 filters 会覆盖同名分组',
        },
        filters: {
          type: 'object',
          description:
            '过滤条件。中文标签或 canonical 结构均可。示例：{"发货时效":"48小时发货","揽收率":"24小时揽收率≥95%","退款率":"总退款率≤3%","服务保障":["7天无理由退换货"],"履约质量":"综合体验分 4.5-5.0星","增值服务":["支持一件代发","支持抖音密文打单"]}',
        },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回命中数上限，默认 10' },
        allowUnknownMetrics: {
          type: 'boolean',
          description: '上游缺少某项服务指标时是否放行（默认 false：按未通过处理并给出 metric_unavailable 原因）',
        },
      },
    },
    async invoke({ args, ctx }) {
      const a = clean(args);
      if (!a.preset && !a.filters) {
        throw new ContractError(ERROR_CODES.INVALID_PARAMS, 'filter_suppliers 至少需要 filters 或 preset 之一', {
          data: { presets: Object.keys(PRESETS) },
        });
      }
      if (!a.keywords && !a.offerIds) {
        // 没给候选范围时，直接在服务端候选池（例如默认搜索页）上过滤，MAF 只需传筛选条件
        ctx.log?.info?.('[1688-mcp] filter_suppliers 未指定 keywords/offerIds，使用服务端候选池', { limit: a.limit ?? 10 });
      }
      const filters = resolveFilters({ preset: a.preset, filters: a.filters });
      const limit = a.limit ?? 10;
      const candidates = await ctx.adapters.listSupplierCandidates({
        keywords: a.keywords,
        offerIds: a.offerIds,
        limit,
      });
      const result = applyFilters(candidates, filters, {
        allowUnknownMetrics: a.allowUnknownMetrics === true,
        limit,
      });
      return {
        ...result,
        preset: a.preset ?? null,
        scope: { keywords: a.keywords ?? null, offerIds: a.offerIds ?? null },
        allowUnknownMetrics: a.allowUnknownMetrics === true,
        source: ctx.adapters.mode,
      };
    },
  },
  {
    name: 'save_sourcing_draft',
    tier: 'semantic',
    risk: RISK.WRITE,
    description:
      '保存选品/采购草稿（不对外发布、不改上游状态）：记录目标商品、数量、目标价与备注。可逆写操作，受幂等账本保护，重复 operationId 会回放首次结果。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['operationId', 'offerId'],
      properties: {
        operationId: OPERATION_ID,
        offerId: OFFER_ID,
        quantity: { type: 'integer', minimum: 1, maximum: 1000000, description: '计划采购数量，默认 1' },
        targetPriceCents: { type: 'integer', minimum: 1, maximum: 100000000, description: '目标单价（分），用于后续议价参考' },
        note: { type: 'string', maxLength: 200, description: '备注，例如「对比 3 家后选它，要求 48h 发货」' },
      },
    },
    async invoke({ args, ctx }) {
      const a = clean(args);
      return ctx.adapters.saveDraft({
        shopKey: ctx.shopKey,
        operationId: a.operationId,
        offerId: a.offerId,
        quantity: a.quantity,
        targetPriceCents: a.targetPriceCents,
        note: a.note,
      });
    },
  },
  {
    name: 'publish_sourcing_order',
    tier: 'semantic',
    risk: RISK.IRREVERSIBLE,
    description:
      '向 1688 供应商提交正式采购订单（产生真实资金支出）。注意：该操作不可逆，MAF 会强制挂起等待人工审批（HITL）；必须显式传 confirm=true，且必须携带 X-Shop-Credential。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['operationId', 'offerId', 'quantity', 'priceCents', 'confirm'],
      properties: {
        operationId: OPERATION_ID,
        offerId: OFFER_ID,
        quantity: { type: 'integer', minimum: 1, maximum: 1000000, description: '采购数量' },
        priceCents: { type: 'integer', minimum: 1, maximum: 100000000, description: '成交单价（分），防止与服务端当前报价不一致' },
        confirm: { type: 'boolean', description: '人工审批通过后置 true；false 或缺失将被拒绝（43010）' },
        note: { type: 'string', maxLength: 200, description: '采购备注/审批单号' },
      },
    },
    async invoke({ args, ctx }) {
      const a = clean(args);
      return ctx.adapters.submitOrder({
        shopKey: ctx.shopKey,
        operationId: a.operationId,
        offerId: a.offerId,
        quantity: a.quantity,
        priceCents: a.priceCents,
        confirm: a.confirm === true,
      });
    },
  },

  /* ============================ 元工具（3） ============================ */
  {
    name: 'meta.health',
    tier: 'meta',
    risk: RISK.READ,
    description: '服务探活：返回运行状态、Uptime、账本条目数、凭证缓存数与并发占用。只读、无副作用，可高频调用。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    async invoke({ ctx }) {
      return healthSnapshot(ctx);
    },
  },
  {
    name: 'meta.describe',
    tier: 'meta',
    risk: RISK.READ,
    description:
      '平台注册的唯一元数据源：返回协议版本、工具版本、并发限额，以及语义/通用/元工具完整目录（含 x-risk 与 JSON Schema），供 MAF 决策是否动态挂载底层接口。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    async invoke({ ctx }) {
      const semantic = TOOLS.filter((t) => t.tier === 'semantic');
      const generic = TOOLS.filter((t) => t.tier === 'generic');
      return {
        server: SERVER_INFO,
        protocolVersions: [ctx.protocolVersion, ...(ctx.legacyProtocolVersions || [])],
        toolVersion: SERVER_INFO.toolVersion,
        limits: {
          maxConcurrency: ctx.stats?.maxConcurrency ?? null,
          toolTimeoutMs: ctx.stats?.toolTimeoutMs ?? null,
          ledgerRetentionDays: ctx.stats?.retentionDays ?? 30,
          toolsListMax: 10,
        },
        tiers: {
          semantic: semantic.map((t) => t.name),
          meta: TOOLS.filter((t) => t.tier === 'meta').map((t) => t.name),
          generic: generic.map((t) => t.name),
        },
        filtering: {
          tool: 'filter_suppliers',
          presets: Object.keys(PRESETS),
          filterGroups: {
            shipping: ['当天发货', '24小时发货', '48小时发货'],
            collection: ['24小时揽收率≥95%', '24小时揽收率≥99%', '48小时揽收率≥95%', '48小时揽收率≥99%', '24小时揽收率<95%', '48小时揽收率<95%'],
            refund: ['品质退款率≤0.005%', '品质退款率≤0.15%', '品质退款率≤0.30%', '品质退款率>0.3%', '总退款率≤1%', '总退款率≤3%', '总退款率≤5%'],
            guarantees: Object.keys(GUARANTEE_LABELS),
            experience: ['综合体验分 5星', '综合体验分 4.5-5.0星', '综合体验分 4-4.5星', '综合体验分 4星以下'],
            valueAdded: Object.keys(VALUE_ADDED_LABELS),
          },
        },
        catalog: TOOLS.map(catalogEntry),
      };
    },
  },
  {
    name: 'meta.list_operations',
    tier: 'meta',
    risk: RISK.READ,
    description:
      '孤儿对账：按 operationIds 或 since 查询本租户（X-Shop-Credential 决定 shopKey）在幂等账本中的操作记录与最终状态，供平台在超时/断网后确认最终一致性。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operationIds: {
          type: 'array',
          maxItems: 100,
          items: { type: 'string', minLength: 8, maxLength: 128 },
          description: '要反查的操作流水号列表；缺省则按 since 时间范围查询',
        },
        since: {
          type: ['integer', 'string'],
          description: '起始时间：毫秒时间戳，或 ISO-8601 字符串（如 2026-11-13T00:00:00Z）',
        },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: '最多返回条数，默认 50' },
      },
    },
    async invoke({ args, ctx }) {
      const a = clean(args);
      let since = null;
      if (a.since != null) {
        since = typeof a.since === 'number' ? a.since : Date.parse(a.since);
        if (!Number.isFinite(since)) throw new ContractError(ERROR_CODES.INVALID_PARAMS, 'since 必须是毫秒时间戳或 ISO-8601 字符串');
      }
      const records = ctx.ledger.list({
        shopKey: ctx.shopKey,
        operationIds: a.operationIds,
        since,
        limit: a.limit ?? 50,
      });
      return {
        shopKey: ctx.shopKey,
        total: records.length,
        operations: records.map((r) => ({
          operationId: r.operationId,
          tool: r.tool,
          status: r.status,
          traceId: r.traceId,
          createdAt: new Date(r.createdAt).toISOString(),
          updatedAt: new Date(r.updatedAt).toISOString(),
          result: r.result,
          error: r.error,
        })),
      };
    },
  },

  /* ======================== 通用原子工具（默认隐身） ======================== */
  {
    name: '1688.offer.search',
    tier: 'generic',
    risk: RISK.READ,
    description: '原子接口：1688 关键词搜索原始结果（对齐 s.1688.com 搜索页 mtop 响应），供底层调度或 JIT 挂载使用。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 120, description: '关键词' },
        max: { type: 'integer', minimum: 1, maximum: 60, description: '返回条数，默认 20' },
        sort: { type: 'string', enum: SUM_SORTS, description: '排序方式' },
      },
    },
    async invoke({ args, ctx }) {
      const a = clean(args);
      return ctx.adapters.searchOffers({ query: a.query, max: a.max ?? 20, sort: a.sort ?? 'relevance' });
    },
  },
  {
    name: '1688.offer.detail',
    tier: 'generic',
    risk: RISK.READ,
    description: '原子接口：商品详情原始结构（含 SKU 模型），供底层调度使用。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['offerId'],
      properties: { offerId: OFFER_ID },
    },
    async invoke({ args, ctx }) {
      return ctx.adapters.getOffer({ offerId: clean(args).offerId });
    },
  },
  {
    name: '1688.offer.sku_model',
    tier: 'generic',
    risk: RISK.READ,
    description: '原子接口：商品 SKU 规格模型（颜色/尺码/价格刻度），对齐 mtop wosc.queryofferskuselectormodel。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['offerId'],
      properties: { offerId: OFFER_ID },
    },
    async invoke({ args, ctx }) {
      return ctx.adapters.getSkuModel({ offerId: clean(args).offerId });
    },
  },
  {
    name: '1688.offer.image_search',
    tier: 'generic',
    risk: RISK.READ,
    description: '原子接口：以图搜款原始结果，供底层调度使用。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['image'],
      properties: {
        image: { type: 'string', minLength: 4, description: '本地图片绝对路径或 http(s) URL' },
        max: { type: 'integer', minimum: 1, maximum: 60 },
      },
    },
    async invoke({ args, ctx }) {
      const a = clean(args);
      return ctx.adapters.searchByImage({ image: a.image, max: a.max ?? 20 });
    },
  },
  {
    name: '1688.shop.profile',
    tier: 'generic',
    risk: RISK.READ,
    description: '原子接口：按商品反查供应商档案（公司名、认证、产地、标签）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['offerId'],
      properties: { offerId: OFFER_ID },
    },
    async invoke({ args, ctx }) {
      return ctx.adapters.getSupplierProfile({ offerId: clean(args).offerId });
    },
  },
  {
    name: '1688.session.login',
    tier: 'generic',
    risk: RISK.WRITE,
    description: '运维接口：打开有头 Chrome 完成 1688 扫码登录/滑块验证（写操作，受幂等账本保护；仅运维人员使用）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['operationId'],
      properties: {
        operationId: OPERATION_ID,
        timeoutSec: { type: 'integer', minimum: 30, maximum: 900, description: '等待扫码秒数，默认 300' },
      },
    },
    async invoke({ args, ctx }) {
      const a = clean(args);
      return ctx.adapters.login({ timeoutSec: a.timeoutSec ?? 300 });
    },
  },
  {
    name: '1688.order.submit',
    tier: 'generic',
    risk: RISK.IRREVERSIBLE,
    description: '原子接口：直接提交 1688 采购订单（不可逆，强制 HITL；必须携带 X-Shop-Credential 且 confirm=true）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['operationId', 'offerId', 'quantity', 'priceCents', 'confirm'],
      properties: {
        operationId: OPERATION_ID,
        offerId: OFFER_ID,
        quantity: { type: 'integer', minimum: 1, maximum: 1000000 },
        priceCents: { type: 'integer', minimum: 1, maximum: 100000000 },
        confirm: { type: 'boolean' },
      },
    },
    async invoke({ args, ctx }) {
      const a = clean(args);
      return ctx.adapters.submitOrder({
        shopKey: ctx.shopKey,
        operationId: a.operationId,
        offerId: a.offerId,
        quantity: a.quantity,
        priceCents: a.priceCents,
        confirm: a.confirm === true,
      });
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

export function findTool(name) {
  return TOOL_MAP.get(String(name)) || null;
}

/** LLM 可见工具：语义 + 元工具；includeGeneric 时追加原子工具（JIT 动态挂载场景） */
export function visibleTools({ includeGeneric = false } = {}) {
  return TOOLS.filter((t) => t.tier !== 'generic' || includeGeneric);
}

/** 转成 MCP tools/list 条目：x-risk 同时放顶层、inputSchema 内与 _meta，兼容不同读取方式 */
export function toMcpTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { ...tool.inputSchema, 'x-risk': tool.risk },
    'x-risk': tool.risk,
    annotations: {
      readOnlyHint: tool.risk === RISK.READ,
      destructiveHint: tool.risk === RISK.IRREVERSIBLE,
      idempotentHint: tool.risk !== RISK.READ,
      openWorldHint: true,
    },
    _meta: { 'x-risk': tool.risk, tier: tool.tier, mutating: tool.risk !== RISK.READ },
  };
}

/** operationId 规则校验（schema 之外再守一层，避免非平台下发的流水号） */
export function assertOperationId(value, toolName) {
  if (typeof value !== 'string' || !/^op-[A-Za-z0-9._:-]{4,124}$/.test(value)) {
    throw new ContractError(
      ERROR_CODES.INVALID_PARAMS,
      `工具 ${toolName} 是写操作，必须提供 MAF 平台下发的 operationId（格式 op-{taskId}-{stepCode}-{contentHash16}）`,
    );
  }
}
