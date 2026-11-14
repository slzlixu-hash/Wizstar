#!/usr/bin/env node
/**
 * 步骤 4 专项冒烟：解析器 + 筛选 DSL
 *
 * 覆盖：
 *   - $$ 九榜：白名单、响应数组路径、指标 _min/_max、title/image/price
 *   - 价格修正：区间价拆 min/suggested/max，不硬编码 0.01、不无脑取 min
 *   - DOM 价格补全覆盖
 *   - V0 词下商品 / V1 搜索词 / 类目树 / data_range_v2 日期窗口
 *   - c1 字典、e1 别名、分桶生成、b1 二级筛选（AND、缺失淘汰、ratio 归一）
 *
 * 运行：node tools/mcp-douyin-compass/test/parser-smoke.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const parser = require('../server/parser');
const dsl = require('../server/filter-dsl');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push({ name, error: e.message }); console.log(`  FAIL  ${name} :: ${e.message}`); }
}
function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

console.log('\n[mcp-douyin-compass parser-smoke]\n');

// ------------------------------------------------------------- $$ 九榜
const totalRank = fixture('rank-total.json');
check('$$ 支持 9 个榜单白名单', () => {
  assert.strictEqual(parser.SUPPORTED_RANKS.length, 9);
  assert(parser.SUPPORTED_RANKS.includes('总榜'));
  assert(parser.SUPPORTED_RANKS.includes('同行低退榜'));
  assert.throws(() => parser.$$('不存在的榜单', {}), /不支持的榜单类型/);
});
check('$$ 总榜取 data.data_result 并归一化 2 条', () => {
  const out = parser.$$('总榜', totalRank);
  assert.strictEqual(out.ruleId, 'rank_total');
  assert.strictEqual(out.items.length, 2);
  const first = out.items[0];
  assert.strictEqual(first.rank, 1);
  assert.strictEqual(first.title, '冬季加厚保暖外套 男');
  assert.strictEqual(first.productId, '3610000000001');
  assert(first.imageUrl.startsWith('https://'));
});
check('$$ 指标 _min/_max 从 index_values.extra_value 取值', () => {
  const first = parser.$$('总榜', totalRank).items[0];
  assert.strictEqual(first.new_pay_amt_min, 1200000);
  assert.strictEqual(first.new_pay_amt_max, 3600000);
  assert.strictEqual(first.product_click_cnt_min, 5000);
  assert.strictEqual(first.product_click_pay_cnt_ratio_min, 2.5);
});
check('$$ 区间价拆分：min/suggested/max 且不再取 min 当唯一价格', () => {
  const first = parser.$$('总榜', totalRank).items[0];
  assert.strictEqual(first.priceMinCents, 12900);
  assert.strictEqual(first.priceMaxCents, 25900);
  assert.strictEqual(first.priceSuggestedCents, Math.round((12900 + 25900) / 2));
  assert.strictEqual(first.isRange, true);
  assert.strictEqual(first.unit, 'cent');
});
check('$$ 单值价不产生伪区间、无硬编码 0.01', () => {
  const second = parser.$$('总榜', totalRank).items[1];
  assert.strictEqual(second.priceMinCents, 39900);
  assert.strictEqual(second.priceMaxCents, 39900);
  assert.strictEqual(second.isRange, false);
  assert(!Object.values(second).includes(0.01));
});
check('$$ 实时榜多路径兜底（data.list）', () => {
  const out = parser.$$('实时爆品挖掘榜', { data: { list: [{ title: '爆品A', price: 9900 }] } });
  assert.strictEqual(out.items.length, 1);
  assert.strictEqual(out.items[0].title, '爆品A');
});
check('$$ 退款榜按 rank_type 区分两条规则的响应路径', () => {
  const r1 = parser.RULE_BY_RANK.get('退后购买榜');
  const r2 = parser.RULE_BY_RANK.get('同行低退榜');
  assert.strictEqual(r1.match.query.rank_type, '3');
  assert.strictEqual(r2.match.query.rank_type, '2');
  const out = parser.$$('同行低退榜', {
    data: { module_data: { GetRefundRankList: { compass_general_table_value: { data: [{ title: '低退商品', price: 5900 }] } } } }
  });
  assert.strictEqual(out.items[0].title, '低退商品');
});
check('DOM 价格补全覆盖 API 价格', () => {
  const items = parser.$$('总榜', totalRank).items;
  const dom = {
    rows: [{ index: 0, price: { min: 13900, suggested: 22900, unit: 'cent', isRange: true } }]
  };
  const merged = parser.pricesFromDom(items, dom);
  assert.strictEqual(merged[0].priceMinCents, 13900);
  assert.strictEqual(merged[0].priceSuggestedCents, 22900);
  assert.strictEqual(merged[0].isRange, true);
  assert.strictEqual(merged[0].priceSource, 'dom');
  assert.strictEqual(merged[1].priceMinCents, 39900, '未匹配行不受影响');
});

// ------------------------------------------------------------- 搜索词 / 词下商品 / 类目 / 日期
check('V1 搜索词榜单取 cell_info.query.value.value_str', () => {
  const out = parser.parseWordRank(fixture('word-rank.json'));
  assert.strictEqual(out.items.length, 2);
  assert.strictEqual(out.items[0].word, '加绒卫衣');
  assert.strictEqual(out.total, 2);
  assert.strictEqual(out.items[0].search_show_ucnt_min, 80000);
});
check('V0 词下商品取 cell_info.product.product 并给 priceYuan', () => {
  const out = parser.parseWordProducts(fixture('word-products.json'), '加绒卫衣');
  assert.strictEqual(out.items.length, 2);
  const first = out.items[0];
  assert.strictEqual(first.title, '加绒卫衣 情侣款');
  assert.strictEqual(first.productId, '3620000000001');
  assert.strictEqual(first.avg_price_min, 8900);
  assert.strictEqual(first.priceYuan, 89);
  assert.strictEqual(first.priceMinCents, 8900);
  assert.strictEqual(first.isRange, true);
  assert.strictEqual(first.pay_cnt_min, 100);
});
check('类目树递归扁平化（不覆盖其它键）', () => {
  const out = parser.parseCategories(fixture('categories.json'));
  assert.strictEqual(out.total, 4);
  assert.deepStrictEqual(out.items.map((x) => x.name), ['服饰内衣', '女装', '男装', '食品饮料']);
  assert(out.items.some((x) => x.name === '女装' && x.parentId === '1' && x.depth === 1));
});
check('data_range_v2 按 UTC+8 折算 7/30 天窗口', () => {
  const seven = parser.parseDateRange({ data: { data_range_map: { '7': { max_date: 1762800000 } } } }, '7');
  assert.strictEqual(seven.days, 7);
  assert(seven.beginDate < seven.endDate);
  const thirty = parser.parseDateRange({ data: { data_range_map: { '23': { max_date: 1762800000 } } } }, '23');
  assert.strictEqual(thirty.days, 30);
  assert.strictEqual(parser.parseDateRange({}, '7'), null);
});

// ------------------------------------------------------------- c1 / e1 / 分桶
check('c1 字典覆盖 9 榜 + 搜索词分析，实时榜为空', () => {
  assert.strictEqual(Object.keys(dsl.FIELD_DICT).length, 10);
  assert.deepStrictEqual(dsl.fieldsFor('实时爆品挖掘榜'), {});
  assert(dsl.fieldsFor('总榜').new_pay_amt);
  assert(dsl.fieldsFor('搜索词分析').avg_price.bounds);
});
check('e1 别名表包含 pay_amt↔new_pay_amt 与 ratio 别名', () => {
  assert(dsl.ALIASES.pay_amt.includes('new_pay_amt'));
  assert(dsl.ALIASES.click_pay_rate.includes('product_click_pay_cnt_ratio'));
  assert(dsl.ALIASES.loss_ucnt.includes('lost_ucnt'));
});
check('分桶：量级 10^e×{1,2.5,5,7.5}、末桶 Infinity', () => {
  const bins = dsl.makeBins({ type: 'number', exp: [1, 2] });
  assert.strictEqual(bins.length, 8);
  assert.strictEqual(bins[0].lo, 10);
  assert.strictEqual(bins[bins.length - 1].hi, Infinity);
});
check('分桶：ratio 用 0-1（百分比 /100）且 avg_price 用自定义 bounds', () => {
  const ratio = dsl.makeBins({ type: 'ratio' });
  assert.strictEqual(ratio[1].lo, 0.01);
  const priceBins = dsl.makeBins(dsl.fieldsFor('搜索词分析').avg_price);
  assert.strictEqual(priceBins[1].lo, 2.5e4);
});
check('ratio 归一：百分数→小数，小数原样', () => {
  assert.strictEqual(dsl.normalizeRatio(2.5), 0.025);
  assert.strictEqual(dsl.normalizeRatio(0.12), 0.12);
});
check('metricRange 优先 _min/_max，别名回退', () => {
  assert.deepStrictEqual(
    dsl.metricRange({ pay_amt_min: 100, pay_amt_max: 200 }, 'pay_amt', 'price'),
    { min: 100, max: 200, source: 'pay_amt_min/_max' }
  );
  const alias = dsl.metricRange({ new_pay_amt_min: 1, new_pay_amt_max: 2 }, 'pay_amt', 'price');
  assert.strictEqual(alias.min, 1);
  assert.strictEqual(dsl.metricRange({}, 'pay_amt', 'price'), null);
});

// ------------------------------------------------------------- b1 二级筛选
check('b1 无筛选条件时全量返回', () => {
  const items = parser.$$('总榜', totalRank).items;
  assert.strictEqual(dsl.applySecondFilter(items, {}, { rankType: '总榜' }).items.length, 2);
});
check('b1 按桶筛选 + 多字段 AND + dropped 统计', () => {
  const items = parser.$$('总榜', totalRank).items;
  const bins = dsl.makeBins(dsl.fieldsFor('总榜').new_pay_amt);
  // 两条商品金额分别 1.2e6~3.6e6 与 5e7~1.2e8，找出各自命中的桶
  const lowBin = bins.findIndex((b) => 1200000 >= b.lo && 1200000 < b.hi);
  const out = dsl.applySecondFilter(items, { new_pay_amt: String(lowBin) }, { rankType: '总榜' });
  assert(out.items.length >= 1);
  assert.strictEqual(out.applied.length, 1);
  assert.strictEqual(out.items.length + out.dropped, items.length);
});
check('b1 缺失指标的商品直接淘汰', () => {
  const out = dsl.applySecondFilter(
    [{ title: '无指标', priceMinCents: 100 }],
    { new_pay_amt: '0' }, { rankType: '总榜' }
  );
  assert.strictEqual(out.items.length, 0);
  assert.strictEqual(out.dropped, 1);
});
check('b1 未知字段/越界桶下标收敛为 unknownFields', () => {
  const items = parser.$$('总榜', totalRank).items;
  const out = dsl.applySecondFilter(items, { not_a_field: '0', new_pay_amt: '9999' }, { rankType: '总榜' });
  assert(out.unknownFields.includes('not_a_field'));
  assert(out.unknownFields.includes('new_pay_amt#9999'));
  assert.strictEqual(out.applied.length, 0);
});
check('b1 overlapMode=min 可复现原版口径', () => {
  const items = [{ pay_amt_min: 100, pay_amt_max: 100000 }];
  const bins = dsl.makeBins(dsl.fieldsFor('总榜').new_pay_amt);
  const idx = bins.findIndex((b) => 100 >= b.lo && 100 < b.hi);
  const modern = dsl.applySecondFilter(items, { new_pay_amt: String(idx) }, { rankType: '总榜', overlapMode: 'intersect' });
  const legacy = dsl.applySecondFilter(items, { new_pay_amt: String(idx) }, { rankType: '总榜', overlapMode: 'min' });
  assert.strictEqual(modern.items.length, 1);
  assert.strictEqual(legacy.items.length, 1);
});
check('describeFields 输出可供 UI 的桶清单', () => {
  const fields = dsl.describeFields('总榜');
  assert.strictEqual(fields.length, 4);
  assert(fields.every((f) => Array.isArray(f.bins) && f.bins.length));
  assert(fields.some((f) => f.value === 'product_click_pay_cnt_ratio' && f.type === 'ratio'));
});

console.log(`\n[parser-smoke] ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  - ${f.name}: ${f.error}`);
  process.exitCode = 1;
}
