#!/usr/bin/env node
/**
 * 二级筛选 DSL（平移观星树 main.full.pretty.js:35549-35697，并修正其已知缺陷）
 *
 * 原版符号对照：
 *   e1 → ALIASES         指标别名表
 *   t1 → MAGNITUDES      量级倍数 [1, 2.5, 5, 7.5]
 *   n1 → RATIO_BOUNDS    百分比分桶
 *   r1 → magnitudeSeries 生成 10^e…10^t × 倍数 的扁平数列
 *   i1 → toBins          数列 → 相邻区间 [{lo,hi}]（末桶 hi=Infinity）
 *   o1 → makeBins        按 type/exp 生成分桶
 *   c1 → FIELD_DICT      9 榜单 + 搜索词分析的二级筛选字段字典
 *   d1 → binsForOption   选项 → 分桶
 *   _1 → metricRange     从商品对象取指标区间
 *   b1 → applySecondFilter 二级筛选执行器
 *   y1 → EPS             边界容差 1e-9
 *
 * 相对原版的三点修正（避免照搬 Bug）：
 *   1. b1 原版只用区间 min 判断（35696），系统性偏严；本实现同时检查 min/max 与桶是否相交，
 *      并可通过 overlapMode='min' 复现原版口径做对账。
 *   2. ratio 归一：明确区分「已是 0-1 小数」与「0-100 百分数」，不再一律 /100。
 *   3. 价格不再无脑取最小值 / 硬编码 0.01：价格字段统一由 parser 拆成
 *      priceMinCents / priceSuggestedCents / priceMaxCents，筛选按用户选择的口径取用。
 */
'use strict';

const EPS = 1e-9;
const MAGNITUDES = [1, 2.5, 5, 7.5];
const RATIO_BOUNDS = [0, 1, 2.5, 5, 7.5, 10, 15, 20, 30, 40, 50, 75, 100];
const DEFAULT_EXP = { price: [6, 10], number: [1, 7], ratio: null };

/** e1：指标别名（响应字段名不统一时的兼容映射）。 */
const ALIASES = Object.freeze({
  pay_amt: ['new_pay_amt', 'pay_amount'],
  new_pay_amt: ['pay_amt'],
  click_pay_rate: ['product_click_pay_cnt_ratio', 'click_pay_ratio'],
  product_click_pay_cnt_ratio: ['click_pay_rate'],
  loss_ucnt: ['lost_ucnt', 'loss_user_cnt', 'loss_cnt'],
  refund_amt_rate: ['refund_rate', 'refund_amt_ratio']
});

function magnitudeSeries(exp) {
  const [from, to] = Array.isArray(exp) && exp.length === 2 ? exp : DEFAULT_EXP.number;
  const out = [];
  for (let e = from; e <= to; e++) {
    const base = Math.pow(10, e);
    for (const m of MAGNITUDES) out.push(base * m);
  }
  return out;
}

function toBins(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const bins = [];
  for (let i = 0; i < sorted.length; i++) {
    bins.push({ lo: sorted[i], hi: i + 1 < sorted.length ? sorted[i + 1] : Infinity, index: i });
  }
  return bins;
}

/** o1：ratio 用百分比分桶（归一到 0-1），price/number 用量级分桶。 */
function makeBins(option) {
  if (Array.isArray(option.bounds) && option.bounds.length) return toBins(option.bounds);
  if (option.type === 'ratio') return toBins(RATIO_BOUNDS.map((n) => n / 100));
  return toBins(magnitudeSeries(option.exp || DEFAULT_EXP[option.type] || DEFAULT_EXP.number));
}

/** c1：9 榜单 + 搜索词分析的二级筛选字段字典（值 = { label, type, exp?, bounds? }）。 */
const FIELD_DICT = Object.freeze({
  '总榜': {
    new_pay_amt: { label: '用户支付金额', type: 'price', exp: [6, 10] },
    product_click_cnt: { label: '点击次数', type: 'number', exp: [3, 8] },
    pay_combo_cnt: { label: '成交件数', type: 'number', exp: [1, 7] },
    product_click_pay_cnt_ratio: { label: '点击成交转化率', type: 'ratio' }
  },
  '搜索榜': {
    search_show_ucnt: { label: '商品曝光人数', type: 'number', exp: [1, 7] },
    pay_amt: { label: '搜索用户支付金额', type: 'price', exp: [6, 10] }
  },
  '直播榜': {
    pay_amt: { label: '直播间用户支付金额', type: 'price', exp: [6, 10] },
    product_click_cnt: { label: '直播间点击次数', type: 'number', exp: [3, 8] },
    pay_combo_cnt: { label: '直播间成交件数', type: 'number', exp: [1, 7] },
    live_room_cnt: { label: '带货直播间数', type: 'number', exp: [0, 6] }
  },
  '商品卡榜': {
    pay_amt: { label: '用户支付金额', type: 'price', exp: [6, 10] },
    product_click_cnt: { label: '点击次数', type: 'number', exp: [3, 8] },
    click_pay_rate: { label: '点击成交转化率', type: 'ratio' },
    pay_combo_cnt: { label: '商品卡成交件数', type: 'number', exp: [1, 7] }
  },
  '达人带货榜': {
    pay_amt: { label: '用户支付金额', type: 'price', exp: [6, 10] },
    product_click_cnt: { label: '点击次数', type: 'number', exp: [3, 8] },
    pay_combo_cnt: { label: '达人成交件数', type: 'number', exp: [1, 7] },
    author_cnt: { label: '带货达人数', type: 'number', exp: [0, 6] }
  },
  '短视频榜': {
    pay_amt: { label: '短视频用户支付金额', type: 'price', exp: [6, 10] },
    product_click_cnt: { label: '点击次数', type: 'number', exp: [3, 8] },
    pay_combo_cnt: { label: '短视频成交件数', type: 'number', exp: [1, 7] },
    video_cnt: { label: '带货视频数', type: 'number', exp: [0, 6] }
  },
  '实时爆品挖掘榜': {}, // 原版明确「该榜单暂无可用的二级筛选字段」
  '退后购买榜': {
    loss_ucnt: { label: '流失人数', type: 'number', exp: [0, 6] },
    refund_amt_rate: { label: '退款率', type: 'ratio' },
    refund_amt: { label: '退款金额', type: 'price', exp: [4, 10] },
    pay_amt: { label: '用户支付金额', type: 'price', exp: [6, 10] }
  },
  '同行低退榜': {
    refund_amt_rate: { label: '退款率', type: 'ratio' },
    refund_amt: { label: '退款金额', type: 'price', exp: [4, 10] },
    pay_amt: { label: '用户支付金额', type: 'price', exp: [6, 10] }
  },
  '搜索词分析': {
    avg_price: {
      label: '商品均价', type: 'price',
      bounds: [0, 2.5e4, 5e4, 1e5, 2.5e5, 5e5, 1e6, 2.5e6, 5e6]
    },
    pay_amt: { label: '支付金额', type: 'price', exp: [6, 10] },
    pay_cnt: { label: '支付件数', type: 'number', exp: [1, 7] },
    pay_ucnt: { label: '支付人数', type: 'number', exp: [1, 7] },
    pay_per_usr_price: { label: '客单价', type: 'price', exp: [6, 10] },
    product_show_ucnt: { label: '商品曝光人数', type: 'number', exp: [1, 7] }
  }
});

/** u1：取某榜单可用筛选项；未知榜单返回空。 */
function fieldsFor(rankType) {
  return FIELD_DICT[rankType] || {};
}

function describeFields(rankType) {
  const dict = fieldsFor(rankType);
  return Object.entries(dict).map(([value, option]) => ({
    value,
    label: option.label,
    type: option.type,
    bins: makeBins(option).map((b) => ({ index: b.index, lo: b.lo, hi: b.hi === Infinity ? null : b.hi }))
  }));
}

/** 归一化比率：0-100 百分数 → 0-1；已是小数则原样。 */
function normalizeRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n > 1 + EPS ? n / 100 : n;
}

function firstFinite(...values) {
  for (const v of values) {
    const n = Number(v);
    if (v !== null && v !== undefined && v !== '' && Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * _1：从商品对象取指标区间。
 * 优先 <field>_min / <field>_max（含别名），再退回单值 <field>；
 * 别名表里的所有候选都尝试；ratio 类型统一归一。
 */
function metricRange(item, field, type) {
  const names = [field, ...(ALIASES[field] || [])];
  const conv = (v) => (type === 'ratio' ? normalizeRatio(v) : Number(v));
  const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(conv(v));

  for (const name of names) {
    const lo = item[`${name}_min`];
    const hi = item[`${name}_max`];
    if (finite(lo) || finite(hi)) {
      const min = finite(lo) ? conv(lo) : (finite(hi) ? conv(hi) : null);
      const max = finite(hi) ? conv(hi) : min;
      return { min, max, source: `${name}_min/_max` };
    }
  }
  for (const name of names) {
    const raw = item[name];
    if (finite(raw)) {
      const v = conv(raw);
      return { min: v, max: v, source: name };
    }
  }
  return null;
}

/** 桶与区间是否相交（含边界容差）。 */
function overlaps(range, bin) {
  if (!range) return false;
  const lo = Math.min(range.min, range.max);
  const hi = Math.max(range.min, range.max);
  return hi >= bin.lo - EPS && (bin.hi === Infinity || lo < bin.hi + EPS);
}

/**
 * b1：二级筛选执行器。
 * @param {Array}  items  归一化后的商品/词对象
 * @param {object} second { 字段: 桶下标字符串|数字 }，多字段 AND
 * @param {object} opts   { rankType, overlapMode:'intersect'|'min', fieldDict }
 *                        overlapMode='min' 复现原版「只用 min 判断」口径，便于对账。
 * @returns {{ items, dropped, applied, unknownFields }}
 */
function applySecondFilter(items, second, opts = {}) {
  const dict = opts.fieldDict || fieldsFor(opts.rankType || '');
  const mode = opts.overlapMode === 'min' ? 'min' : 'intersect';
  const entries = Object.entries(second || {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return { items: items.slice(), dropped: 0, applied: [], unknownFields: [] };

  const unknownFields = [];
  const applied = [];
  for (const [field, rawIndex] of entries) {
    const option = dict[field];
    if (!option) { unknownFields.push(field); continue; }
    const bins = makeBins(option);
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= bins.length) {
      unknownFields.push(`${field}#${rawIndex}`);
      continue;
    }
    applied.push({ field, index, label: option.label, bin: { lo: bins[index].lo, hi: bins[index].hi } });
  }

  const filtered = [];
  let dropped = 0;
  for (const item of items) {
    let keep = true;
    for (const { field, index } of applied) {
      const option = dict[field];
      const bins = makeBins(option);
      const bin = bins[index];
      const range = metricRange(item, field, option.type);
      // 原版口径：缺失指标的商品直接淘汰
      if (!range) { keep = false; break; }
      const hit = mode === 'min'
        ? (range.min >= bin.lo - EPS && (bin.hi === Infinity || range.min < bin.hi + EPS))
        : overlaps(range, bin);
      if (!hit) { keep = false; break; }
    }
    if (keep) filtered.push(item);
    else dropped++;
  }
  return { items: filtered, dropped, applied, unknownFields };
}

module.exports = {
  EPS,
  MAGNITUDES,
  RATIO_BOUNDS,
  ALIASES,
  FIELD_DICT,
  magnitudeSeries,
  toBins,
  makeBins,
  fieldsFor,
  describeFields,
  normalizeRatio,
  firstFinite,
  metricRange,
  overlaps,
  applySecondFilter
};
