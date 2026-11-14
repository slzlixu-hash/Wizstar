'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRESETS,
  normalizeFilters,
  resolveFilters,
  evaluateCandidate,
  applyFilters,
} from '../../src/domain/supplier-filters.js';
import { createMockAdapter } from '../../src/adapters/mock.js';

/** MAF 筛选面板「默认策略」当前选中项（来自设计稿截图） */
const PANEL_DEFAULT = {
  发货时效: '48小时发货',
  揽收率: '24小时揽收率≥95%',
  退款率: '总退款率≤3%',
  服务保障: [],
  履约质量: null,
  增值服务: ['支持一件代发', '支持抖音密文打单'],
};

test('中文筛选面板条件 → canonical 结构', () => {
  assert.deepEqual(normalizeFilters(PANEL_DEFAULT), {
    shipping: { maxHours: 48 },
    collection: { windowHours: 24, minRate: 0.95 },
    refund: { kind: 'total', maxRate: 0.03 },
    guarantees: [],
    valueAdded: ['dropship', 'label_douyin'],
  });
});

test('各过滤组的文字条件都能解析', () => {
  assert.deepEqual(normalizeFilters({ 发货时效: '当天发货' }), { shipping: { maxHours: 12 } });
  assert.deepEqual(normalizeFilters({ 揽收率: '24小时揽收率≥99%' }), { collection: { windowHours: 24, minRate: 0.99 } });
  assert.deepEqual(normalizeFilters({ 揽收率: '48小时揽收率<95%' }), { collection: { windowHours: 48, maxRate: 0.95 } });
  assert.deepEqual(normalizeFilters({ 退款率: '品质退款率≤0.005%' }), { refund: { kind: 'quality', maxRate: 0.00005 } });
  assert.deepEqual(normalizeFilters({ 退款率: '品质退款率≤0.15%' }), { refund: { kind: 'quality', maxRate: 0.0015 } });
  assert.deepEqual(normalizeFilters({ 退款率: '品质退款率>0.3%' }), { refund: { kind: 'quality', minRate: 0.003 } });
  assert.deepEqual(normalizeFilters({ 服务保障: '实力商家' }), { guarantees: ['strength_merchant'] });
  assert.deepEqual(normalizeFilters({ 履约质量: '综合体验分 5星' }), { experience: { min: 5 } });
  assert.deepEqual(normalizeFilters({ 履约质量: '综合体验分 4星以下' }), { experience: { max: 4, maxExclusive: true } });
  assert.deepEqual(normalizeFilters({ 履约质量: '综合体验分 4-4.5星' }), { experience: { min: 4, max: 4.5, maxExclusive: true } });
  assert.deepEqual(normalizeFilters({ 增值服务: ['免费赊账', '一件代发包邮'] }), {
    valueAdded: ['free_credit', 'dropship_free_shipping'],
  });
});

test('未知/非法条件必须拒绝（不能静默忽略过滤）', () => {
  const cases = [
    { 发货时效: '72小时发货' },
    { 揽收率: '揽收率≥95%' },
    { 退款率: '退款率≤3%' },
    { 服务保障: ['纯实力商家'] },
    { 履约质量: '综合体验分 4.2星' },
    { 增值服务: ['支持某平台密文下单'] },
    { collection: { windowHours: 12, minRate: 0.9 } },
    { refund: { kind: 'quality' } },
  ];
  for (const filters of cases) {
    assert.throws(
      () => normalizeFilters(filters),
      (e) => e.code === 40001 && e.category === 'invalid_params',
      `应拒绝：${JSON.stringify(filters)}`,
    );
  }
});

test('canonical 结构与 preset 合并：显式条件覆盖同组预设', () => {
  const merged = resolveFilters({
    preset: 'default_price',
    filters: { 发货时效: '24小时发货', 增值服务: [] },
  });
  assert.deepEqual(merged.shipping, { maxHours: 24 });
  assert.deepEqual(merged.collection, PRESETS.default_price.collection);
  assert.deepEqual(merged.refund, PRESETS.default_price.refund);
  assert.deepEqual(merged.valueAdded, [], '显式空数组应覆盖预设的增值服务');
});

test('evaluateCandidate 逐条判定并给出原因', () => {
  const metrics = {
    shipHours: 24,
    collectionRate24h: 0.97,
    qualityRefundRate: 0.0002,
    totalRefundRate: 0.01,
    experienceScore: 4.8,
    guarantees: ['7day_return'],
    valueAdded: ['dropship'],
  };
  assert.equal(evaluateCandidate(metrics, {}).pass, true);

  const slow = evaluateCandidate({ ...metrics, shipHours: 48 }, { shipping: { maxHours: 24 } });
  assert.equal(slow.pass, false);
  assert.equal(slow.reasons[0].code, 'shipping_too_slow');

  const lowCollection = evaluateCandidate(metrics, { collection: { windowHours: 24, minRate: 0.99 } });
  assert.equal(lowCollection.reasons[0].code, 'collection_rate_low');

  const highRefund = evaluateCandidate(metrics, { refund: { kind: 'total', maxRate: 0.005 } });
  assert.equal(highRefund.reasons[0].code, 'refund_rate_high');

  const missingGuarantee = evaluateCandidate(metrics, { guarantees: ['certified_factory'] });
  assert.equal(missingGuarantee.reasons[0].code, 'guarantee_missing');

  const lowExperience = evaluateCandidate(metrics, { experience: { min: 5 } });
  assert.equal(lowExperience.reasons[0].code, 'experience_score_low');

  const noDropship = evaluateCandidate({ ...metrics, valueAdded: [] }, { valueAdded: ['dropship'] });
  assert.equal(noDropship.reasons[0].code, 'value_added_missing');
});

test('指标缺失：默认淘汰，allowUnknownMetrics 才放行', () => {
  const noMetrics = { shipHours: null, collectionRate24h: null };
  const strict = evaluateCandidate(noMetrics, { shipping: { maxHours: 24 }, collection: { windowHours: 24, minRate: 0.95 } });
  assert.equal(strict.pass, false);
  assert.deepEqual(strict.unknownMetrics.sort(), ['collectionRate24h', 'shipHours']);
  assert.ok(strict.reasons.every((r) => r.code === 'metric_unavailable'));

  const relaxed = evaluateCandidate(
    noMetrics,
    { shipping: { maxHours: 24 }, collection: { windowHours: 24, minRate: 0.95 } },
    { allowUnknownMetrics: true },
  );
  assert.equal(relaxed.pass, true);
  assert.equal(relaxed.unknownMetrics.length, 2);
});

test('mock 候选池上应用默认策略 / 优先策略', async () => {
  const adapter = createMockAdapter();
  const candidates = await adapter.listSupplierCandidates({ limit: 20 });
  assert.equal(candidates.length, 3);
  assert.equal(adapter.calls.listSupplierCandidates, 1);

  const relaxed = applyFilters(candidates, resolveFilters({ preset: 'default_price' }), { limit: 10 });
  assert.deepEqual(relaxed.stats, { candidates: 3, matched: 2, rejected: 1 });
  assert.deepEqual(relaxed.matched.map((m) => m.offerId), ['674199987929', '674199987930']);
  assert.equal(relaxed.rejected[0].offerId, '674199987931');
  assert.ok(relaxed.rejected[0].reasons.some((r) => r.code === 'collection_rate_low'));

  const strict = applyFilters(candidates, resolveFilters({ preset: 'priority_quality' }), { limit: 10 });
  assert.deepEqual(strict.stats, { candidates: 3, matched: 1, rejected: 2 });
  assert.equal(strict.matched[0].offerId, '674199987929');
  assert.ok(strict.rejected.some((r) => r.offerId === '674199987930' && r.reasons[0].code === 'shipping_too_slow'));

  const limited = applyFilters(candidates, resolveFilters({ preset: 'default_price' }), { limit: 1 });
  assert.equal(limited.matched.length, 1);
  assert.equal(limited.stats.matched, 2);
});
