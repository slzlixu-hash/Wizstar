#!/usr/bin/env node
/**
 * 响应归一化（平移观星树 main.full.pretty.js:35422-35482、36489-36556）
 *
 * 核心：
 *   $$  榜单 API 响应 → 统一商品结构（9 榜各自响应数组路径 + 指标 _min/_max）
 *   V0  词下商品指标区间（index_values.extra_value.lower/upper）
 *   V1  搜索词榜单归一化（cell_info.query.value.value_str）
 *   V2  类目树（data.cate_list）
 *
 * 价格修正（原版 Bug）：
 *   - 原版 Q$ 无论区间文本还是候选取值都取 min，把「¥100-200」记成 100、
 *     且实时榜兜底硬编码 0.01（元/分语义未闭合）。
 *   - 本实现统一输出「分」单位的三个字段：priceMinCents / priceSuggestedCents / priceMaxCents；
 *     区间价保留 min 与 max，建议价取 DOM 或 seller 建议价，绝不硬编码。
 *   - pricesFromDom() 用 content.js 的 DOM 读数覆盖/校正（区间价拆 min/suggested）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SELECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, 'selectors.json'), 'utf8'));
const RULE_BY_RANK = new Map(SELECTORS.rankRules.map((r) => [r.rankType, r]));
const RULE_BY_ID = new Map(SELECTORS.rankRules.map((r) => [r.id, r]));

const SUPPORTED_RANKS = SELECTORS.rankRules.map((r) => r.rankType);

// ------------------------------------------------------------- 通用取值工具

function getPath(obj, dotted) {
  if (!obj || !dotted) return undefined;
  return String(dotted).split('.').reduce((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    if (Array.isArray(acc) && /^\d+$/.test(key)) return acc[Number(key)];
    return acc[key];
  }, obj);
}

function firstDefined(...values) {
  for (const v of values) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

function firstArray(...values) {
  for (const v of values) if (Array.isArray(v)) return v;
  return [];
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (_) { return {}; }
  }
  return typeof value === 'object' ? value : {};
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 从 index_values.extra_value 或 value_range 抽区间（原版 r 工具）。 */
function extractRange(node) {
  if (!node || typeof node !== 'object') return { min: null, max: null };
  const indexValues = node.index_values || node.indexValues || {};
  const extra = indexValues.extra_value || indexValues.extraValue || {};
  if (extra.unauthorized === true || extra.unauthorized === 'true') return { min: null, max: null };

  const lower = extra.lower !== undefined ? extra.lower : (extra.min !== undefined ? extra.min : null);
  const upper = extra.upper !== undefined ? extra.upper : (extra.max !== undefined ? extra.max : null);
  let min = toNumber(lower && typeof lower === 'object' ? firstDefined(lower.value, lower.val) : lower);
  let max = toNumber(upper && typeof upper === 'object' ? firstDefined(upper.value, upper.val) : upper);

  if (min === null && max === null && Array.isArray(node.value_range)) {
    min = toNumber(node.value_range[0]);
    max = toNumber(node.value_range[1]);
  }
  // upper=-1 表示无上界
  if (max !== null && max < 0) max = null;
  return { min, max };
}

/** V0：词下商品 / 搜索词列表的指标区间。 */
function V0(cellInfo, metric) {
  const node = getPath(cellInfo, metric) || getPath(cellInfo, `cell_info.${metric}`);
  return extractRange(node);
}

// ------------------------------------------------------------- 价格候选路径
// 原版 s（35451）约 30 条候选；这里保留覆盖面最广的路径组。
const PRICE_PATHS = [
  'price', 'price_min', 'avg_price_min', 'product_price', 'sell_price',
  'min_price', 'sale_price', 'product.price', 'product.price_min',
  'product_info.price', 'product_info.price_min',
  'cell_info.product.product.price', 'cell_info.product.product.price_min',
  'cell_info.product.product.price_bin',
  'price_info.price', 'price_info.min_price', 'sku_info.min_price'
];

// 区间价候选：罗盘把价格嵌在 product_info / cell_info.product.product 等位置，
// 只看顶层会把「¥129-259」压成单值 129（原版 Q$ 取最小值的同类缺陷）。
const PRICE_MIN_PATHS = [
  'price_min', 'avg_price_min', 'min_price',
  'product_info.price_min', 'product.price_min', 'product_info.min_price',
  'cell_info.product.product.price_min', 'price_info.min_price', 'sku_info.min_price'
];
const PRICE_MAX_PATHS = [
  'price_max', 'avg_price_max', 'max_price',
  'product_info.price_max', 'product.price_max', 'product_info.max_price',
  'cell_info.product.product.price_max', 'price_info.max_price', 'sku_info.max_price'
];

function firstAtPaths(item, paths) {
  for (const p of paths) {
    const value = getPath(item, p);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/** 罗盘价格单位统一为「分」；若候选值明显是「元」（<1000 且带小数）则换算。 */
function normalizePriceCents(raw) {
  const n = toNumber(raw);
  if (n === null || n < 0) return null;
  // 罗盘榜单 price 一般为分；avg_price_min 亦为分。0 < n < 100 且含小数时按元处理。
  const looksYuan = n > 0 && n < 100 && !Number.isInteger(n);
  return looksYuan ? Math.round(n * 100) : Math.round(n);
}

/**
 * 从商品对象抽价格三元组（分）。区间价保留 min/max，suggested 优先取 DOM 建议价或中间价。
 * 绝不硬编码 0.01，也不再无脑把区间记成 min。
 */
function extractPrice(item) {
  const candidates = [];
  for (const p of PRICE_PATHS) {
    const value = getPath(item, p);
    if (value !== undefined && value !== null && value !== '') candidates.push({ path: p, value });
  }

  const minRaw = firstAtPaths(item, PRICE_MIN_PATHS);
  const maxRaw = firstAtPaths(item, PRICE_MAX_PATHS);
  const singleRaw = firstDefined(...candidates.map((c) => c.value));

  let min = normalizePriceCents(minRaw);
  let max = normalizePriceCents(maxRaw);
  const single = normalizePriceCents(singleRaw);

  if (min === null) min = single;
  if (max === null) max = single;
  if (min === null && max === null) {
    return { priceMinCents: null, priceSuggestedCents: null, priceMaxCents: null, currency: 'CNY', unit: 'cent', isRange: false, priceSource: null };
  }
  if (min === null) min = max;
  if (max === null) max = min;
  if (min > max) [min, max] = [max, min];

  const isRange = max > min;
  return {
    priceMinCents: min,
    priceSuggestedCents: isRange ? Math.round((min + max) / 2) : min,
    priceMaxCents: max,
    currency: 'CNY',
    unit: 'cent',
    isRange,
    priceSource: candidates.length ? candidates[0].path : 'min/max'
  };
}

/** DOM 价格补全：用 content.js 的读数量覆盖 suggested，保留区间 min/max。 */
function pricesFromDom(items, domResult) {
  if (!domResult || !Array.isArray(domResult.rows)) return items;
  const byIndex = new Map();
  for (const row of domResult.rows) {
    if (row && Number.isInteger(row.index) && row.price) byIndex.set(row.index, row.price);
  }
  return items.map((item, index) => {
    const dom = byIndex.get(index);
    if (!dom) return item;
    const merged = { ...item };
    if (dom.min !== null && dom.min !== undefined) {
      merged.priceMinCents = dom.min;
      merged.priceMaxCents = dom.isRange ? (dom.suggested ?? dom.min) : Math.max(dom.min, item.priceMaxCents ?? dom.min);
      merged.priceSuggestedCents = dom.suggested ?? dom.min;
      merged.isRange = Boolean(dom.isRange);
      merged.priceSource = 'dom';
    }
    return merged;
  });
}

// ------------------------------------------------------------- title / image_url

function extractTitle(row) {
  const product = firstDefined(
    getPath(row, 'product_info'), getPath(row, 'product'),
    getPath(row, 'cell_info.product.product'), getPath(row, 'cell_info.product')
  );
  const candidates = [
    getPath(row, 'title'), getPath(row, 'product_name'), getPath(row, 'name'),
    product && product.title, product && product.product_name, product && product.name,
    getPath(row, 'cell_info.query.value.value_str')
  ];
  return String(firstDefined(...candidates) || '').trim();
}

function extractImage(row) {
  const product = firstDefined(
    getPath(row, 'product_info'), getPath(row, 'product'),
    getPath(row, 'cell_info.product.product')
  );
  const candidates = [
    getPath(row, 'image_url'), getPath(row, 'image'), getPath(row, 'main_image'),
    product && product.image_url, product && product.image, product && product.product_image,
    getPath(row, 'img_list'), getPath(row, 'url_list'), getPath(row, 'images')
  ];
  const raw = firstDefined(...candidates);
  if (Array.isArray(raw)) {
    const first = raw.find((x) => x && (typeof x === 'string' || x.url));
    return typeof first === 'string' ? first : (first && first.url) || null;
  }
  if (raw && typeof raw === 'object') return raw.url || raw.src || null;
  return typeof raw === 'string' && raw ? raw : null;
}

function extractProductId(row) {
  const product = firstDefined(getPath(row, 'product'), getPath(row, 'product_info'), getPath(row, 'cell_info.product.product'));
  return String(firstDefined(
    getPath(row, 'product_id'), getPath(row, 'id'), getPath(row, 'promotion_id'),
    product && product.product_id, product && product.id
  ) || '');
}

// ------------------------------------------------------------- $$ 九榜归一化

function rowsForRule(rule, response) {
  const root = asObject(response);
  const paths = rule.responsePaths || (rule.responsePath ? [rule.responsePath] : []);
  for (const p of paths) {
    const value = getPath(root, p);
    if (Array.isArray(value)) return value;
  }
  // 兜底：常见列表字段
  return firstArray(root.data_result, root.list, root.card_list, root.data);
}

/**
 * $$：榜单响应 → 统一商品结构。
 * @param {string} rankType 9 个中文榜单名之一
 * @param {object|string} response 原始响应
 * @returns {{ rankType, ruleId, items, total, unsupported, note }}
 */
function $$(rankType, response) {
  if (!SUPPORTED_RANKS.includes(rankType)) {
    throw new Error(`不支持的榜单类型：${rankType}`);
  }
  const rule = RULE_BY_RANK.get(rankType);
  const rows = rowsForRule(rule, response);
  const metrics = rule.metrics || [];

  const items = rows.map((row, index) => {
    const item = {
      rank: index + 1,
      rankType,
      ruleId: rule.id,
      productId: extractProductId(row),
      title: extractTitle(row),
      imageUrl: extractImage(row),
      ...extractPrice(row)
    };
    // 指标区间：兼容 <metric>_min/_max 与 cell_info.<metric>.value 的 index_values
    for (const metric of metrics) {
      const directMin = toNumber(firstDefined(getPath(row, `${metric}_min`), getPath(row, `cell_info.${metric}.value.index_values.extra_value.lower.value`)));
      const directMax = toNumber(firstDefined(getPath(row, `${metric}_max`), getPath(row, `cell_info.${metric}.value.index_values.extra_value.upper.value`)));
      const range = (directMin === null && directMax === null)
        ? V0(getPath(row, 'cell_info') || row, metric)
        : { min: directMin, max: directMax };
      item[`${metric}_min`] = range.min;
      item[`${metric}_max`] = range.max;
    }
    return item;
  });

  return {
    rankType,
    ruleId: rule.id,
    items,
    total: items.length,
    note: metrics.length ? null : '该榜单无二级筛选字段，仅解析 price/title/imageUrl'
  };
}

// ------------------------------------------------------------- 搜索词 / 词下商品

/** V1：搜索词榜单 → 词 + 指标区间。 */
function parseWordRank(response) {
  const cfg = SELECTORS.searchAnalysis.wordRank;
  const root = asObject(response);
  const rows = firstArray(getPath(root, cfg.responsePath));
  const metrics = [
    'search_show_ucnt', 'search_ucnt', 'pay_amt', 'product_show_ucnt',
    'prod_show_click_ratio', 'prod_click_pay_ratio', 'related_product_cnt', 'compete_index'
  ];
  const items = rows.map((row, index) => {
    const word = String(getPath(row, cfg.wordPath) || getPath(row, 'word') || '').trim();
    const item = { rank: index + 1, word, ...extractPrice(row) };
    for (const m of metrics) {
      const range = V0(getPath(row, 'cell_info') || row, m);
      item[`${m}_min`] = range.min;
      item[`${m}_max`] = range.max;
    }
    return item;
  }).filter((x) => x.word);
  return {
    items,
    total: toNumber(getPath(root, cfg.totalPath)) ?? items.length,
    pageSize: cfg.pageSize
  };
}

/** V0 链路：词下商品 → 统一商品结构（含 avg_price_min/100 的价格口径）。 */
function parseWordProducts(response, word) {
  const cfg = SELECTORS.searchAnalysis.wordProducts;
  const root = asObject(response);
  const rows = firstArray(getPath(root, cfg.responsePath));
  const metrics = [
    'avg_price', 'pay_amt', 'pay_cnt', 'pay_ucnt', 'pay_per_usr_price', 'product_show_ucnt'
  ];
  const items = rows.map((row, index) => {
    const cell = getPath(row, 'cell_info') || row;
    const product = getPath(cell, 'product.product') || getPath(row, cfg.productPath) || {};
    const item = {
      rank: index + 1,
      word,
      productId: String(firstDefined(product.product_id, product.id, row.product_id) || ''),
      title: String(firstDefined(product.product_name, product.title, extractTitle(row)) || '').trim(),
      imageUrl: extractImage(product) || extractImage(row),
      detailUrl: firstDefined(product.detail_h5_url, product.detail_url, row.detail_url) || null,
      ...extractPrice(product)
    };
    for (const m of metrics) {
      const range = V0(cell, m);
      item[`${m}_min`] = range.min;
      item[`${m}_max`] = range.max;
    }
    // 原版 q0：price = avg_price_min / 100（罗盘返回分为单位，展示为元）
    // 本实现统一「分」：若 avg_price_min 有值，直接作为 priceMinCents，另给 yuan 换算字段便于展示
    if (item.avg_price_min !== null && item.avg_price_min !== undefined) {
      item.priceMinCents = Number(item.avg_price_min);
      item.priceMaxCents = item.avg_price_max === null || item.avg_price_max === undefined
        ? item.priceMinCents : Number(item.avg_price_max);
      item.priceSuggestedCents = item.priceMinCents;
      item.priceYuan = Number((item.priceMinCents / 100).toFixed(2));
      item.isRange = item.priceMaxCents > item.priceMinCents;
    }
    return item;
  }).filter((x) => x.title);
  return { items, total: toNumber(getPath(root, cfg.totalPath)) ?? items.length, pageSize: cfg.pageSize };
}

/** 类目树归一化（修原版 storage.category 被覆盖的 Bug：只认 CATEGORY_DATA 的数据）。 */
function parseCategories(response) {
  const root = asObject(response);
  const list = firstArray(getPath(root, SELECTORS.category.responsePath), root.cate_list, root.data);
  const flat = [];
  function walk(nodes, parentId, depth) {
    for (const node of nodes || []) {
      const id = String(firstDefined(node.cate_id, node.id, node.value) || '');
      const name = String(firstDefined(node.cate_name, node.name, node.label) || '');
      if (id || name) flat.push({ id, name, parentId, depth });
      const children = node.children || node.sub_cate_list || node.cate_list;
      if (Array.isArray(children) && children.length) walk(children, id || null, depth + 1);
    }
  }
  walk(list, null, 0);
  return { items: flat, total: flat.length, responsePath: SELECTORS.category.responsePath };
}

/** 数据日期：取 data_range_map[dateType].max_date（Unix 秒），按 UTC+8 折算窗口。 */
function parseDateRange(response, dateType) {
  const root = asObject(response);
  const map = getPath(root, SELECTORS.searchAnalysis.dateRange.responsePath) || {};
  const entry = map[String(dateType)] || map[dateType] || Object.values(map)[0] || {};
  const maxDateRaw = toNumber(firstDefined(entry.max_date, entry.maxDate));
  if (maxDateRaw === null) return null;
  const maxSeconds = maxDateRaw > 1e11 ? Math.floor(maxDateRaw / 1000) : maxDateRaw;
  const days = String(dateType) === '23' ? 30 : 7;
  const beginSeconds = maxSeconds - (days - 1) * 86400;
  const fmt = (sec) => {
    // UTC+8
    const d = new Date((sec + 8 * 3600) * 1000);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  };
  return {
    maxDate: fmt(maxSeconds),
    beginDate: fmt(beginSeconds),
    endDate: fmt(maxSeconds),
    days,
    dateType: String(dateType),
    maxDateUnixSeconds: maxSeconds
  };
}

module.exports = {
  SUPPORTED_RANKS,
  SELECTORS,
  RULE_BY_RANK,
  RULE_BY_ID,
  getPath,
  firstDefined,
  firstArray,
  asObject,
  extractRange,
  V0,
  extractPrice,
  pricesFromDom,
  extractTitle,
  extractImage,
  $$,
  parseWordRank,
  parseWordProducts,
  parseCategories,
  parseDateRange
};
