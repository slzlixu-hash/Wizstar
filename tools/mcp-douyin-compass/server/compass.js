#!/usr/bin/env node
/**
 * 4 个 compass 语义工具的真实实现（步骤 5）
 *
 * 链路：bridge.send(CMD) → MV3 SW → content → inject（页面会话 fetch）
 *      → 响应体回传 → parser 归一化 → filter-dsl 二级筛选 → 结构化清单
 *
 * 设计口径：
 *   - 主动采集用 PAGE_FETCH（在页面上下文带会话发站内 GET，可控、可分页、可传参）；
 *     SET_RULES / SWITCH_TAB 用于让页面处于正确榜单上下文并捕获首屏响应作为兜底。
 *   - 只回传响应体，绝不接触 Cookie / 凭证；不实现 a_bogus 签名、不绕风控。
 *   - 不写平台业务库（规范 §1.1）；只返回结构化清单，落库由 Wizstar.Api / Agent 决定。
 *   - 所有上游错误归一化成契约码：网络/超时 50001、上游业务拒绝 43010、入参 40001。
 *
 * index.js 通过 optionalRequire 自动接线：构造 ctx 后调用 bind(ctx)。
 */
'use strict';

const parser = require('./parser');
const dsl = require('./filter-dsl');
const { ToolError } = require('./tools');
const { ErrorCodes } = require('./envelope');

const S = parser.SELECTORS;
let CTX = null;
let categoryCache = null;

function bind(ctx) {
  CTX = ctx;
}

function bridge() {
  if (!CTX || !CTX.bridge) {
    throw new ToolError(ErrorCodes.NetworkError, 'WS 桥接未就绪（步骤 2 未接线）');
  }
  return CTX.bridge;
}

/** 探针主动上报的捕获事件：只做首屏兜底缓存，不触发任何业务写入。 */
const captureCache = new Map(); // ruleId -> { data, meta, at }
function onFrames(message) {
  if (!message || message.type !== 'EVENT' && message.type !== 'CAPTURE') return;
  if (message.event === 'login') return;
  const ruleId = message.ruleId || (message.meta && message.meta.ruleId);
  const data = message.data !== undefined ? message.data : (message.payload && message.payload.data);
  if (!ruleId || data === undefined) return;
  captureCache.set(ruleId, { data, meta: message.meta || null, at: Date.now() });
}

// ------------------------------------------------------------- 基础工具

/** selectors.json 里既有绝对 URL（榜单 match.url），也有以 / 开头的相对路径；统一归一化。 */
function absoluteUrl(raw) {
  const value = String(raw || '');
  if (/^https?:\/\//i.test(value)) return value;
  return S.site + (value.startsWith('/') ? value : '/' + value);
}

function buildUrl(base, query) {
  const u = new URL(absoluteUrl(base));
  for (const [key, value] of Object.entries(query || {})) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      u.searchParams.delete(key);
      for (const v of value) u.searchParams.append(key, String(v));
    } else {
      u.searchParams.set(key, String(value));
    }
  }
  return u.toString();
}

/** 发起一次站内 GET 并解析 JSON；把上游错误归一化成契约码。 */
async function fetchJson(url, label) {
  let result;
  try {
    result = await bridge().send('PAGE_FETCH', { url, init: { method: 'GET' } });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/超时|未连接|MV3|断开|代际/.test(msg)) {
      throw new ToolError(ErrorCodes.NetworkError, `${label}：${msg}`);
    }
    throw new ToolError(ErrorCodes.NetworkError, `${label} 请求失败：${msg}`);
  }
  if (!result || !result.ok) {
    const status = result && result.status ? result.status : 0;
    if (status === 429) throw new ToolError(ErrorCodes.RateLimited, `${label} 触发罗盘限频，请稍后重试`);
    if (status === 401 || status === 403) {
      throw new ToolError(ErrorCodes.PermissionDenied, `${label}：罗盘登录态失效或无权限（HTTP ${status}）`);
    }
    throw new ToolError(ErrorCodes.NetworkError, `${label} 返回 HTTP ${status}：${(result && result.error) || '无响应体'}`);
  }
  let json;
  try { json = JSON.parse(result.body); } catch (_) {
    throw new ToolError(ErrorCodes.BusinessRejected, `${label} 响应不是合法 JSON`);
  }
  const code = Number(parser.firstDefined(json.code, json.status_code, json.err_no));
  if (Number.isFinite(code) && code !== 0 && code !== 200) {
    throw new ToolError(ErrorCodes.BusinessRejected, `${label}：${json.message || json.msg || '上游业务返回 ' + code}`);
  }
  return json;
}

function normalizeRankType(input) {
  if (!input || typeof input !== 'string') {
    throw new ToolError(ErrorCodes.ValidationError, 'rankType 必须是 9 个榜单名或规则 id 之一');
  }
  if (parser.RULE_BY_RANK.has(input)) return input;
  if (parser.RULE_BY_ID.has(input)) return parser.RULE_BY_ID.get(input).rankType;
  throw new ToolError(
    ErrorCodes.ValidationError,
    `不支持的榜单类型：${input}；可用：${parser.SUPPORTED_RANKS.join(' / ')}`
  );
}

function validateFilters(filters, rankType) {
  if (filters === undefined || filters === null) return {};
  if (typeof filters !== 'object' || Array.isArray(filters)) {
    throw new ToolError(ErrorCodes.ValidationError, 'filters 必须是对象，形如 { 指标字段: 桶下标 }');
  }
  const dict = dsl.fieldsFor(rankType);
  for (const key of Object.keys(filters)) {
    if (!dict[key]) {
      throw new ToolError(
        ErrorCodes.ValidationError,
        `榜单「${rankType}」不支持筛选字段 ${key}；可用：${Object.keys(dict).join(', ') || '（该榜单无二级筛选）'}`
      );
    }
  }
  return filters;
}

/** 汇总立项摘要：给 Agent 一个可直接决策的精简视图。 */
function summarize(items, extra = {}) {
  const withPrice = items.filter((x) => Number.isFinite(x.priceMinCents));
  const prices = withPrice.map((x) => x.priceMinCents).sort((a, b) => a - b);
  return {
    total: items.length,
    priceBandCents: prices.length
      ? { min: prices[0], median: prices[Math.floor(prices.length / 2)], max: prices[prices.length - 1] }
      : null,
    top: items.slice(0, 20),
    ...extra
  };
}

// ------------------------------------------------------------- 1. 类目同步

const CATEGORY_URL = absoluteUrl(S.category.urlContains);

async function syncCategories(args = {}) {
  const force = Boolean(args.forceRefresh);
  if (!force && categoryCache && Date.now() - categoryCache.at < 10 * 60 * 1000) {
    return { ...categoryCache.data, cached: true, cachedAt: new Date(categoryCache.at).toISOString() };
  }

  let raw = null;
  let source = 'api';
  try {
    raw = await fetchJson(CATEGORY_URL, '类目树');
  } catch (e) {
    // 页面自身请求捕获的类目数据作为兜底（只认 CATEGORY_DATA，不会被 API_RESPONSE 污染）
    const cached = captureCache.get('category');
    if (cached) { raw = cached.data; source = 'capture'; }
    else throw e;
  }

  const parsed = parser.parseCategories(raw);
  if (!parsed.total) {
    throw new ToolError(ErrorCodes.BusinessRejected, '类目树为空：请确认罗盘页面已登录且有类目权限');
  }
  const data = {
    items: parsed.items,
    total: parsed.total,
    source,
    note: '仅服务内部缓存，不写平台业务库；修原版 storage.category 被覆盖的 Bug'
  };
  categoryCache = { data, at: Date.now() };
  return { ...data, cached: false };
}

// ------------------------------------------------------------- 2. 商品榜单

async function fetchProductRank(args = {}) {
  const rankType = normalizeRankType(args.rankType);
  const rule = parser.RULE_BY_RANK.get(rankType);
  const filters = validateFilters(args.filters, rankType);
  const pages = Math.max(1, Math.min(Number(args.pages) || 1, 10));

  // 1) 下发拦截规则（让页面自身请求也被捕获，作为首屏兜底）
  const query = {};
  if (args.categoryId) { query.industry_id = args.categoryId; query.category_id = args.categoryId; }
  if (args.dateRange) query.date_type = args.dateRange;
  try {
    await bridge().send('SET_RULES', {
      rules: [{ id: rule.id, match: rule.match, request: { query, body: {} }, captureResponse: true }]
    });
  } catch (_) { /* 规则下发失败不阻断主动采集 */ }

  // 2) 切到目标榜单页签（失败不致命：主动 PAGE_FETCH 仍可用）
  let tab = null;
  try { tab = await bridge().send('SWITCH_TAB', { label: rankType }); } catch (_) { tab = { ok: false }; }

  // endpoint 由 selectors.json 单一声明（含 urlRegex 型与 rank_type 区分型规则）
  const endpoint = absoluteUrl(rule.endpoint || (rule.match && rule.match.url));
  const endpointQuery = rule.endpointQuery || (rule.match && rule.match.query) || {};

  const all = [];
  const pageNotes = [];
  for (let page = 1; page <= pages; page++) {
    let raw = null;
    if (endpoint) {
      // 有显式接口：上游错误必须如实归一化上报，绝不用缓存/页面捕获把它伪装成成功
      // （否则限频 429 会被当作采集成功，Agent 会继续加压）
      raw = await fetchJson(
        buildUrl(endpoint, { ...endpointQuery, ...query, page_no: page, page_size: 20 }),
        `${rankType} 第 ${page} 页`
      );
    } else {
      // 无显式接口（仅由页面自身请求触发）：等待捕获，再退回缓存
      try {
        const captured = await bridge().send('WAIT_CAPTURE', { ruleId: rule.id, timeoutMs: 20000 });
        if (captured && captured.data) raw = captured.data;
      } catch (_) { /* 落到下面的空数据分支 */ }
      if (!raw) {
        const cached = captureCache.get(rule.id);
        if (cached) raw = cached.data;
      }
    }
    if (!raw) {
      if (page === 1) {
        throw new ToolError(
          ErrorCodes.NetworkError,
          `${rankType} 未拿到任何响应：请确认罗盘页面已登录并打开对应榜单`
        );
      }
      pageNotes.push(`第 ${page} 页无响应，提前结束`);
      break;
    }

    const parsed = parser.$$(rankType, raw);
    let items = parsed.items;
    // DOM 补全真实价格（区间价拆 min/suggested）
    try {
      const dom = await bridge().send('READ_PRICES', {});
      items = parser.pricesFromDom(items, dom);
    } catch (_) { /* DOM 不可用时保留 API 价格 */ }
    all.push(...items);

    if (parsed.total === 0) { pageNotes.push(`第 ${page} 页为空，提前结束`); break; }
  }

  const filtered = dsl.applySecondFilter(all, filters, { rankType });
  return summarize(filtered.items, {
    rankType,
    ruleId: rule.id,
    pagesRequested: pages,
    capturedRows: all.length,
    droppedByFilter: filtered.dropped,
    appliedFilters: filtered.applied,
    tab,
    notes: pageNotes,
    dataSource: 'borrowed-page-session',
    note: '仅返回结构化清单；未写入任何业务库（规范 §1.1）'
  });
}

// ------------------------------------------------------------- 3. 搜索词分析

const DATE_RANGE_URL = absoluteUrl(S.searchAnalysis.dateRange.url);
const WORD_RANK_URL = absoluteUrl(S.searchAnalysis.wordRank.url);

async function fetchSearchWords(args = {}) {
  const filters = validateFilters(args.filters, '搜索词分析');
  const pages = Math.max(1, Math.min(Number(args.pages) || 1, 10));
  const dateType = String(args.dateRange || '7');

  let range;
  try {
    const rawRange = await fetchJson(
      buildUrl(DATE_RANGE_URL, S.searchAnalysis.dateRange.query),
      '罗盘可用数据日期'
    );
    range = parser.parseDateRange(rawRange, dateType);
  } catch (e) {
    throw new ToolError(ErrorCodes.NetworkError, `搜索词分析依赖最新数据日期：${e.message}`);
  }
  if (!range) {
    throw new ToolError(ErrorCodes.BusinessRejected, '罗盘未返回可用数据日期（data_range_map 为空）');
  }

  const all = [];
  const pageNotes = [];
  for (let page = 1; page <= pages; page++) {
    const q = {
      ...S.searchAnalysis.wordRank.queryTemplate,
      date_type: range.dateType,
      begin_date: range.beginDate,
      end_date: range.endDate,
      page_no: page,
      page_size: S.searchAnalysis.wordRank.pageSize
    };
    if (args.categoryId) {
      q.industry_id = args.categoryId;
      q.cate_id = args.categoryId;
      q.category_id = args.categoryId;
      q.total_cate_id = args.categoryId;
    }
    let parsed;
    try {
      parsed = parser.parseWordRank(await fetchJson(buildUrl(WORD_RANK_URL, q), `搜索词榜第 ${page} 页`));
    } catch (e) {
      if (page === 1) throw e;
      pageNotes.push(`第 ${page} 页跳过：${e.message}`);
      break;
    }
    all.push(...parsed.items);
    if (!parsed.items.length) { pageNotes.push(`第 ${page} 页为空，提前结束`); break; }
  }

  const filtered = dsl.applySecondFilter(all, filters, { rankType: '搜索词分析' });
  return {
    ...summarize(filtered.items, { kind: 'search_words' }),
    dateRange: range,
    capturedRows: all.length,
    droppedByFilter: filtered.dropped,
    appliedFilters: filtered.applied,
    notes: pageNotes,
    note: '词列表可直接作为 get_compass_word_products 的 words 入参'
  };
}

// ------------------------------------------------------------- 4. 词下商品

const WORD_PRODUCTS_URL = absoluteUrl(S.searchAnalysis.wordProducts.url);

async function fetchWordProducts(args = {}) {
  const words = Array.isArray(args.words) ? args.words.filter((w) => typeof w === 'string' && w.trim()) : [];
  if (!words.length) throw new ToolError(ErrorCodes.ValidationError, 'words 不能为空');
  const filters = validateFilters(args.filters, '搜索词分析');
  const pages = Math.max(1, Math.min(Number(args.pages) || 1, 5));

  const all = [];
  const perWord = [];
  for (const word of words) {
    let wordTotal = 0;
    for (let page = 1; page <= pages; page++) {
      const q = {
        ...S.searchAnalysis.wordProducts.queryTemplate,
        query: word,
        page_no: page,
        page_size: S.searchAnalysis.wordProducts.pageSize
      };
      if (args.categoryId) q.cate_id_list = [args.categoryId];
      let parsed;
      try {
        parsed = parser.parseWordProducts(
          await fetchJson(buildUrl(WORD_PRODUCTS_URL, q), `「${word}」词下商品第 ${page} 页`),
          word
        );
      } catch (e) {
        if (page === 1) { perWord.push({ word, error: e.message, total: 0 }); }
        break;
      }
      all.push(...parsed.items);
      wordTotal += parsed.items.length;
      if (!parsed.items.length) break;
    }
    perWord.push({ word, total: wordTotal });
  }

  const filtered = dsl.applySecondFilter(all, filters, { rankType: '搜索词分析' });
  return {
    ...summarize(filtered.items, { kind: 'word_products' }),
    perWord,
    capturedRows: all.length,
    droppedByFilter: filtered.dropped,
    appliedFilters: filtered.applied,
    note: 'priceMinCents/priceMaxCents 单位为分；priceYuan 为展示用元值'
  };
}

module.exports = {
  bind,
  onFrames,
  syncCategories,
  fetchProductRank,
  fetchSearchWords,
  fetchWordProducts,
  captureCache
};
