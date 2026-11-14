'use strict';

/**
 * 供应商筛选条件（MAF 过滤条件）解析与评估。
 *
 * MAF 端会把「发货时效 / 揽收率 / 退款率 / 服务保障 / 履约质量 / 增值服务」这类
 * 中文过滤条件下发给 MCP 服务。这里把可读的中文条件（或无歧义的英文 canonical 形式）
 * 规范化成统一结构，再对候选供应商的指标逐条判定，返回命中/淘汰原因。
 *
 * 设计要点：
 * - 只做纯函数：不碰适配器、不产生副作用，便于单测与幂等（筛选是只读操作）；
 * - 中文标签严格白名单：出现未知标签直接 40001，避免「悄悄忽略过滤条件」导致选错供应商；
 * - 指标缺失（上游未返回某指标）默认按「不通过」处理，可通过 allowUnknownMetrics 放宽，
 *   避免 MAF 误以为条件已生效。
 */
import { ContractError, ERROR_CODES } from '../core/errors.js';

/** 发货时效：当天发货按 12 小时计（比 24 小时更严格，保证「当天」语义） */
export const SHIPPING_LABELS = Object.freeze({
  当天发货: 12,
  '24小时发货': 24,
  '48小时发货': 48,
});

export const GUARANTEE_LABELS = Object.freeze({
  '7天无理由退换货': '7day_return',
  实力商家: 'strength_merchant',
  认证工厂: 'certified_factory',
});

export const VALUE_ADDED_LABELS = Object.freeze({
  免费赊账: 'free_credit',
  支持一件代发: 'dropship',
  一件代发包邮: 'dropship_free_shipping',
  支持抖音密文打单: 'label_douyin',
  支持快手密文打单: 'label_kuaishou',
  支持微信小店密文下单: 'label_wechat_shop',
  支持淘宝密文下单: 'label_taobao',
  支持拼多多密文下单: 'label_pinduoduo',
  支持小红书密文下单: 'label_xiaohongshu',
  支持京东密文下单: 'label_jd',
});

export const GUARANTEES = Object.freeze(Object.values(GUARANTEE_LABELS));
export const VALUE_ADDED = Object.freeze(Object.values(VALUE_ADDED_LABELS));

/** 预设策略：对应 MAF 筛选面板顶部两个 tab */
export const PRESETS = Object.freeze({
  /** 优先策略：严格筛选，优先高质量货源 */
  priority_quality: Object.freeze({
    shipping: { maxHours: 24 },
    collection: { windowHours: 24, minRate: 0.99 },
    refund: { kind: 'quality', maxRate: 0.0015 },
    guarantees: ['7day_return', 'strength_merchant'],
    experience: { min: 4.5 },
    valueAdded: ['dropship'],
  }),
  /** 默认策略：宽松筛选，优先低价货源（对应设计稿的默认选中项） */
  default_price: Object.freeze({
    shipping: { maxHours: 48 },
    collection: { windowHours: 24, minRate: 0.95 },
    refund: { kind: 'total', maxRate: 0.03 },
    experience: { min: 4 },
    valueAdded: ['dropship', 'label_douyin'],
  }),
});

const RATE_OPS = { '≤': 'max-inclusive', '<=': 'max-inclusive', '<': 'max-exclusive', '≥': 'min-inclusive', '>=': 'min-inclusive', '>': 'min-exclusive' };

function bad(message, data) {
  return new ContractError(ERROR_CODES.INVALID_PARAMS, message, { data });
}

function pct(text) {
  return Math.round(Number.parseFloat(text) * 100000) / 100000 / 100; // 百分数 → 0..1
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 把中文/英文混写的条件对象规范化为 canonical 过滤条件（未知标签 → 40001） */
export function normalizeFilters(input = {}) {
  if (input == null) return {};
  if (!isPlainObject(input)) throw bad('filters 必须是对象');
  const out = {};

  const shipping = input.shipping ?? input['发货时效'];
  if (shipping != null) {
    let hours;
    if (isPlainObject(shipping)) hours = Number(shipping.maxHours);
    else if (typeof shipping === 'number') hours = shipping;
    else hours = SHIPPING_LABELS[String(shipping).trim()];
    if (![12, 24, 48].includes(hours)) throw bad(`不支持的发货时效：${JSON.stringify(shipping)}`, { field: 'shipping' });
    out.shipping = { maxHours: hours };
  }

  const collection = input.collection ?? input['揽收率'];
  if (collection != null) {
    out.collection = normalizeCollection(collection);
  }

  const refund = input.refund ?? input['退款率'];
  if (refund != null) {
    out.refund = normalizeRefund(refund);
  }

  const guarantees = input.guarantees ?? input['服务保障'];
  if (guarantees != null) {
    out.guarantees = [...new Set(toArray(guarantees).map((g) => resolveEnum(g, GUARANTEE_LABELS, GUARANTEES, '服务保障')))];
  }

  const experience = input.experience ?? input['履约质量'];
  if (experience != null) {
    out.experience = normalizeExperience(experience);
  }

  const valueAdded = input.valueAdded ?? input['增值服务'];
  if (valueAdded != null) {
    out.valueAdded = [...new Set(toArray(valueAdded).map((v) => resolveEnum(v, VALUE_ADDED_LABELS, VALUE_ADDED, '增值服务')))];
  }

  return out;
}

function resolveEnum(value, labels, allowed, field) {
  const raw = String(value).trim();
  const canonical = labels[raw] ?? (allowed.includes(raw) ? raw : null);
  if (!canonical) throw bad(`不支持的${field}选项：${raw}`, { field, allowed: Object.keys(labels) });
  return canonical;
}

function normalizeCollection(value) {
  if (isPlainObject(value)) {
    const windowHours = Number(value.windowHours ?? 24);
    if (![24, 48].includes(windowHours)) throw bad('collection.windowHours 只能是 24 或 48', { field: 'collection' });
    const minRate = value.minRate != null ? Number(value.minRate) : null;
    const maxRate = value.maxRate != null ? Number(value.maxRate) : null;
    if ([minRate, maxRate].every((v) => v == null) || (minRate != null && maxRate != null)) {
      throw bad('collection 需要且只能指定 minRate 或 maxRate 之一', { field: 'collection' });
    }
    if (minRate != null && !(minRate > 0 && minRate <= 1)) throw bad('collection.minRate 必须在 (0,1] 内', { field: 'collection' });
    if (maxRate != null && !(maxRate > 0 && maxRate < 1)) throw bad('collection.maxRate 必须在 (0,1) 内', { field: 'collection' });
    return { windowHours, ...(minRate != null ? { minRate } : {}), ...(maxRate != null ? { maxRate } : {}) };
  }
  const text = String(value).trim();
  const m = text.match(/^(24|48)小时揽收率\s*(≤|<=|<|≥|>=|>)\s*(\d+(?:\.\d+)?)\s*%$/);
  if (!m) throw bad(`不支持的揽收率条件：${text}`, { field: 'collection', example: '24小时揽收率≥95%' });
  const windowHours = Number(m[1]);
  const op = RATE_OPS[m[2]];
  const rate = pct(m[3]);
  return op === 'min-inclusive' ? { windowHours, minRate: rate } : { windowHours, maxRate: rate };
}

function normalizeRefund(value) {
  if (isPlainObject(value)) {
    const kind = value.kind;
    if (!['quality', 'total'].includes(kind)) throw bad('refund.kind 只能是 quality 或 total', { field: 'refund' });
    const maxRate = value.maxRate != null ? Number(value.maxRate) : null;
    const minRate = value.minRate != null ? Number(value.minRate) : null;
    if ((maxRate == null) === (minRate == null)) throw bad('refund 需要且只能指定 maxRate 或 minRate 之一', { field: 'refund' });
    const r = maxRate ?? minRate;
    if (!(r >= 0 && r < 1)) throw bad('refund 比率必须在 [0,1) 内', { field: 'refund' });
    return { kind, ...(maxRate != null ? { maxRate } : { minRate }) };
  }
  const text = String(value).trim();
  const m = text.match(/^(品质退款率|总退款率)\s*(≤|<=|<|≥|>=|>)\s*(\d+(?:\.\d+)?)\s*%$/);
  if (!m) throw bad(`不支持的退款率条件：${text}`, { field: 'refund', example: '总退款率≤3%' });
  const kind = m[1] === '品质退款率' ? 'quality' : 'total';
  const op = RATE_OPS[m[2]];
  const rate = pct(m[3]);
  if (op === 'max-inclusive') return { kind, maxRate: rate };
  if (op === 'max-exclusive') throw bad('退款率不支持「<」写法，请使用 ≤ 或 >', { field: 'refund' });
  return { kind, minRate: rate };
}

/** 1688 筛选面板只提供这几档履约质量，其它档位一律拒绝（避免 MAF 条件悄悄失效） */
const EXPERIENCE_BUCKETS = Object.freeze([5, 4.5, 4]);

function normalizeExperience(value) {
  if (isPlainObject(value)) {
    const min = value.min != null ? Number(value.min) : null;
    const max = value.max != null ? Number(value.max) : null;
    const maxExclusive = value.maxExclusive !== false; // 缺省区间右开
    if ((min == null) === (max == null)) throw bad('experience 需要且只能指定 min 或 max 之一', { field: 'experience' });
    const score = min ?? max;
    if (!(score >= 0 && score <= 5)) throw bad('综合体验分必须在 0~5 之间', { field: 'experience' });
    return { ...(min != null ? { min } : { max, maxExclusive }) };
  }
  const text = String(value).trim().replace(/\s+/g, ' ');
  const exact = text.match(/^综合体验分\s*(\d+(?:\.\d+)?)\s*星$/);
  if (exact) {
    const score = Number(exact[1]);
    if (!EXPERIENCE_BUCKETS.includes(score)) {
      throw bad(`不支持的履约质量档位：${text}`, { field: 'experience', allowed: ['综合体验分 5星', '综合体验分 4.5-5.0星', '综合体验分 4-4.5星', '综合体验分 4星以下'] });
    }
    return { min: score };
  }
  const below = text.match(/^综合体验分\s*(\d+(?:\.\d+)?)\s*星以下$/);
  if (below) {
    const score = Number(below[1]);
    if (score !== 4) throw bad(`不支持的履约质量档位：${text}`, { field: 'experience' });
    return { max: 4, maxExclusive: true };
  }
  const range = text.match(/^综合体验分\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*星$/);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    const allowed = (lo === 4.5 && hi === 5) || (lo === 4 && hi === 4.5);
    if (!allowed) throw bad(`不支持的履约质量档位：${text}`, { field: 'experience' });
    return { min: lo, max: hi, maxExclusive: true };
  }
  throw bad(`不支持的履约质量条件：${text}`, { field: 'experience', example: '综合体验分 4.5-5.0星' });
}

/** 预设 + 显式条件合并（显式条件按分组覆盖预设） */
export function resolveFilters({ preset, filters } = {}) {
  const base = preset ? { ...PRESETS[preset] } : {};
  if (!preset) return normalizeFilters(filters || {});
  if (!PRESETS[preset]) throw bad(`未知的筛选策略预设：${preset}`, { field: 'preset', allowed: Object.keys(PRESETS) });
  const explicit = normalizeFilters(filters || {});
  const merged = { ...(normalizeFilters(base) || {}), ...explicit };
  return merged;
}

const RATE_METRIC = {
  24: 'collectionRate24h',
  48: 'collectionRate48h',
};

function numOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 判定单个候选供应商是否满足过滤条件。
 * @returns {{pass:boolean, reasons:Array, unknownMetrics:string[]}}
 */
export function evaluateCandidate(metrics = {}, filters = {}, { allowUnknownMetrics = false } = {}) {
  const reasons = [];
  const unknown = [];
  const m = metrics || {};

  const reject = (filter, expected, actual, code) => reasons.push({ filter, expected, actual, code });
  const unknownMetric = (filter, name, expected) => {
    unknown.push(name);
    if (!allowUnknownMetrics) reject(filter, expected, null, 'metric_unavailable');
  };

  if (filters.shipping?.maxHours != null) {
    const actual = numOrNull(m.shipHours);
    if (actual == null) unknownMetric('shipping.maxHours', 'shipHours', `≤${filters.shipping.maxHours}h`);
    else if (actual > filters.shipping.maxHours) reject('shipping.maxHours', `≤${filters.shipping.maxHours}h`, `${actual}h`, 'shipping_too_slow');
  }

  if (filters.collection) {
    const { windowHours, minRate, maxRate } = filters.collection;
    const metricName = RATE_METRIC[windowHours];
    const actual = numOrNull(m[metricName]);
    if (actual == null) {
      unknownMetric('collection', metricName, `${windowHours}h 揽收率`);
    } else if (minRate != null && actual < minRate) {
      reject('collection.minRate', `≥${pctText(minRate)}`, pctText(actual), 'collection_rate_low');
    } else if (maxRate != null && actual >= maxRate) {
      reject('collection.maxRate', `<${pctText(maxRate)}`, pctText(actual), 'collection_rate_not_below_threshold');
    }
  }

  if (filters.refund) {
    const { kind, maxRate, minRate } = filters.refund;
    const metricName = kind === 'quality' ? 'qualityRefundRate' : 'totalRefundRate';
    const actual = numOrNull(m[metricName]);
    if (actual == null) {
      unknownMetric('refund', metricName, kind === 'quality' ? '品质退款率' : '总退款率');
    } else if (maxRate != null && actual > maxRate) {
      reject('refund.maxRate', `≤${pctText(maxRate)}`, pctText(actual), 'refund_rate_high');
    } else if (minRate != null && actual <= minRate) {
      reject('refund.minRate', `>${pctText(minRate)}`, pctText(actual), 'refund_rate_not_above_threshold');
    }
  }

  if (filters.guarantees?.length) {
    const have = new Set(toArray(m.guarantees));
    const hit = filters.guarantees.some((g) => have.has(g));
    if (!hit) reject('guarantees', filters.guarantees, [...have], 'guarantee_missing');
  }

  if (filters.experience) {
    const { min, max, maxExclusive } = filters.experience;
    const actual = numOrNull(m.experienceScore);
    if (actual == null) {
      unknownMetric('experience', 'experienceScore', '综合体验分');
    } else if (min != null && actual < min) {
      reject('experience.min', `≥${min}`, actual, 'experience_score_low');
    } else if (max != null && (maxExclusive ? actual >= max : actual > max)) {
      reject('experience.max', `${maxExclusive ? '<' : '≤'}${max}`, actual, 'experience_score_high');
    }
  }

  if (filters.valueAdded?.length) {
    const have = new Set(toArray(m.valueAdded));
    const hit = filters.valueAdded.some((v) => have.has(v));
    if (!hit) reject('valueAdded', filters.valueAdded, [...have], 'value_added_missing');
  }

  return { pass: reasons.length === 0, reasons, unknownMetrics: [...new Set(unknown)] };
}

function pctText(rate) {
  return `${Math.round(rate * 1000000) / 10000}%`;
}

/** 在候选列表上应用过滤条件，返回命中/淘汰与统计 */
export function applyFilters(candidates, filters, opts = {}) {
  const matched = [];
  const rejected = [];
  for (const candidate of candidates || []) {
    const verdict = evaluateCandidate(candidate.metrics || {}, filters, opts);
    if (verdict.pass) {
      matched.push({
        offerId: candidate.offerId,
        title: candidate.title,
        price: candidate.price,
        moq: candidate.moq ?? null,
        supplier: candidate.supplier,
        location: candidate.location,
        metrics: candidate.metrics,
        ...(verdict.unknownMetrics.length ? { unknownMetrics: verdict.unknownMetrics } : {}),
      });
    } else {
      rejected.push({ offerId: candidate.offerId, supplier: candidate.supplier, reasons: verdict.reasons });
    }
  }
  const limit = opts.limit ?? 10;
  return {
    filters,
    stats: { candidates: (candidates || []).length, matched: matched.length, rejected: rejected.length },
    matched: limit >= 0 ? matched.slice(0, limit) : matched,
    rejected,
  };
}

export default { normalizeFilters, resolveFilters, evaluateCandidate, applyFilters, PRESETS };
