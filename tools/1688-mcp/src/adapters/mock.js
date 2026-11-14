'use strict';

/**
 * 离线 mock 适配器：用于协议/幂等/错误归一化自测，不启动 Chrome、不访问网络。
 *
 * 设计：
 * - 数据固定（同一 query 返回同一批 offer），便于断言；
 * - 记录每个方法的调用次数，用来验证「幂等回放不得触发上游二次调用」；
 * - 通过 query / note 里的关键字注入失败（超时/限流/配额/权限/业务拒绝），
 *   用于验证统一错误码映射；也支持 `failNext()` 精确注入下一次调用。
 */
import crypto from 'node:crypto';

const FIXTURES = {
  '674199987929': {
    offerId: '674199987929',
    title: '艾草防臭鞋垫 春夏薄款透气吸汗 男女软底舒适',
    price: { text: '¥2.80', min: 2.8, max: 3.2 },
    supplier: { name: '义乌市康足日用品厂', shopUrl: 'https://shop.1688.com/xxxx', years: 7 },
    location: { province: '浙江', city: '金华' },
    bizType: '生产厂家',
    verified: { factory: true, business: true, superFactory: false },
    tags: ['源头工厂', '48小时发货', '7天包换'],
    serviceTags: ['一件代发'],
    demand: { orderCountText: '30天成交 1.2万件', orderCount: 12000, repurchaseRateText: '复购率 18%', repurchaseRate: 18 },
    /** 供应商服务指标：供 filter_suppliers 使用（真实上游由店铺/服务数据派生） */
    supplierMetrics: {
      shipHours: 12,
      collectionRate24h: 0.992,
      collectionRate48h: 0.998,
      qualityRefundRate: 0.0008,
      totalRefundRate: 0.012,
      experienceScore: 4.6,
      guarantees: ['7day_return', 'strength_merchant'],
      valueAdded: ['dropship', 'label_douyin'],
    },
    isAd: false,
    url: 'https://detail.1688.com/offer/674199987929.html',
    image: 'https://cbu01.alicdn.com/img/ibank/mock-1.jpg',
    moq: 2,
    sku: {
      price: { begin: 280, end: 320, unit: '分' },
      multiPrice: null,
      props: [{ name: '颜色', values: ['米白', '灰色', '黑色'] }],
      skuCount: 6,
      skus: ['米白>35-36', '米白>37-38', '灰色>35-36', '灰色>37-38', '黑色>35-36', '黑色>37-38'],
    },
  },
  '674199987930': {
    offerId: '674199987930',
    title: '夏季透气艾草鞋垫 吸汗防臭软底 可裁剪',
    price: { text: '¥3.15', min: 3.15, max: 3.6 },
    supplier: { name: '温州足康鞋材有限公司', shopUrl: 'https://shop.1688.com/yyyy', years: 11 },
    location: { province: '浙江', city: '温州' },
    bizType: '生产加工',
    verified: { factory: true, business: false, superFactory: true },
    tags: ['实力工厂', '支持定制'],
    serviceTags: ['7天包换'],
    demand: { orderCountText: '30天成交 8600件', orderCount: 8600, repurchaseRateText: '复购率 22%', repurchaseRate: 22 },
    supplierMetrics: {
      shipHours: 48,
      collectionRate24h: 0.996,
      collectionRate48h: 1,
      qualityRefundRate: 0.0003,
      totalRefundRate: 0.008,
      experienceScore: 4.9,
      guarantees: ['7day_return', 'certified_factory'],
      valueAdded: ['dropship', 'label_douyin', 'label_kuaishou'],
    },
    isAd: true,
    url: 'https://detail.1688.com/offer/674199987930.html',
    image: 'https://cbu01.alicdn.com/img/ibank/mock-2.jpg',
    moq: 10,
    sku: {
      price: { begin: 315, end: 360, unit: '分' },
      multiPrice: null,
      props: [{ name: '尺码', values: ['35-36', '37-38', '39-40'] }],
      skuCount: 3,
      skus: ['35-36', '37-38', '39-40'],
    },
  },
  '674199987931': {
    offerId: '674199987931',
    title: '艾草除臭鞋垫 四季通用 透气减震运动款',
    price: { text: '¥2.45', min: 2.45, max: 2.9 },
    supplier: { name: '台州市黄岩康步塑料厂', shopUrl: 'https://shop.1688.com/zzzz', years: 4 },
    location: { province: '浙江', city: '台州' },
    bizType: '生产厂家',
    verified: { factory: false, business: true, superFactory: false },
    tags: ['24小时发货'],
    serviceTags: [],
    demand: { orderCountText: '30天成交 3200件', orderCount: 3200, repurchaseRateText: '复购率 9%', repurchaseRate: 9 },
    supplierMetrics: {
      shipHours: 24,
      collectionRate24h: 0.93,
      collectionRate48h: 0.96,
      qualityRefundRate: 0.0035,
      totalRefundRate: 0.045,
      experienceScore: 3.8,
      guarantees: [],
      valueAdded: [],
    },
    isAd: false,
    url: 'https://detail.1688.com/offer/674199987931.html',
    image: 'https://cbu01.alicdn.com/img/ibank/mock-3.jpg',
    moq: 5,
    sku: { price: { begin: 245, end: 290, unit: '分' }, multiPrice: null, props: [], skuCount: 1, skus: ['默认'] },
  },
};

const OFFER_IDS = Object.keys(FIXTURES);

function fixtureOffer(offerId) {
  return FIXTURES[String(offerId)] ?? null;
}

function throwInjected(text) {
  const t = String(text || '');
  if (/超时|timeout/i.test(t)) {
    const e = new Error('page.goto: Timeout 30000ms exceeded.');
    e.name = 'TimeoutError';
    throw e;
  }
  if (/限流|rate|429/i.test(t)) throw new Error('HTTP 429 Too Many Requests（上游限流）');
  if (/配额|quota/i.test(t)) throw new Error('quota exceeded：今日调用配额已用完');
  if (/权限|forbidden/i.test(t)) throw new Error('403 forbidden：缺少类目权限');
  if (/业务拒绝|下架|资质/i.test(t)) throw new Error('业务错误 40031：类目资质不符');
}

export function createMockAdapter() {
  const calls = {
    searchOffers: 0,
    searchByImage: 0,
    getOffer: 0,
    getSkuModel: 0,
    getSupplierProfile: 0,
    listSupplierCandidates: 0,
    saveDraft: 0,
    submitOrder: 0,
    login: 0,
  };
  /** @type {Array<{method:string, error:Error}>} */
  const queuedFailures = [];

  function note(method) {
    calls[method] += 1;
    const idx = queuedFailures.findIndex((f) => f.method === method || f.method === '*');
    if (idx >= 0) {
      const [f] = queuedFailures.splice(idx, 1);
      throw f.error;
    }
  }

  function normalize({ query, max = 20, sort = 'relevance' }) {
    const offers = OFFER_IDS.map((id) => fixtureOffer(id));
    if (sort === 'price-asc') offers.sort((a, b) => a.price.min - b.price.min);
    if (sort === 'price-desc') offers.sort((a, b) => b.price.min - a.price.min);
    return offers.slice(0, Math.min(max, offers.length));
  }

  return {
    mode: 'mock',
    calls,
    stats: () => ({ ...calls }),
    failNext(method, error) {
      queuedFailures.push({ method: method || '*', error: error instanceof Error ? error : new Error(String(error)) });
    },
    reset() {
      for (const k of Object.keys(calls)) calls[k] = 0;
      queuedFailures.length = 0;
    },

    async searchOffers({ query, max, sort }) {
      note('searchOffers');
      throwInjected(query);
      const offers = normalize({ query, max, sort });
      return { query, sort: sort || 'relevance', url: `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(query)}`, total: offers.length, offers };
    },

    async searchByImage({ image, max }) {
      note('searchByImage');
      throwInjected(image);
      const offers = normalize({ max });
      return { image, imageId: '900001', resultUrl: 'https://s.1688.com/selloffer/offer_search.htm?imageId=900001', total: offers.length, offers };
    },

    async getOffer({ offerId }) {
      note('getOffer');
      if (/\D/.test(String(offerId))) throw new Error('offerId 必须是数字');
      const offer = fixtureOffer(offerId);
      if (!offer) throw new Error(`业务错误 404：offer ${offerId} 不存在或已下架`);
      return offer;
    },

    async getSkuModel({ offerId }) {
      note('getSkuModel');
      const offer = fixtureOffer(offerId);
      if (!offer) throw new Error(`业务错误 404：offer ${offerId} 不存在`);
      return { offerId: String(offerId), price: offer.sku.price, multiPrice: offer.sku.multiPrice, props: offer.sku.props, skuCount: offer.sku.skuCount, skus: offer.sku.skus };
    },

    async getSupplierProfile({ offerId }) {
      note('getSupplierProfile');
      const offer = fixtureOffer(offerId);
      if (!offer) throw new Error(`业务错误 404：offer ${offerId} 不存在`);
      return { offerId: String(offerId), supplier: offer.supplier, location: offer.location, bizType: offer.bizType, verified: offer.verified, tags: offer.tags, serviceTags: offer.serviceTags, demand: offer.demand, metrics: offer.supplierMetrics };
    },

    /** 筛选候选池：按 offerIds 或关键词返回带服务指标的供应商候选 */
    async listSupplierCandidates({ keywords, offerIds, limit } = {}) {
      note('listSupplierCandidates');
      throwInjected(keywords);
      let offers = OFFER_IDS.map((id) => fixtureOffer(id));
      if (Array.isArray(offerIds) && offerIds.length) {
        offers = offerIds.map((id) => fixtureOffer(id)).filter(Boolean);
      } else if (keywords) {
        const q = String(keywords);
        const hit = offers.filter((o) => o.title.includes(q) || o.supplier.name.includes(q));
        if (hit.length) offers = hit;
      }
      return offers.slice(0, Math.min(limit ?? 20, offers.length)).map((o) => ({
        offerId: o.offerId,
        title: o.title,
        price: o.price,
        moq: o.moq,
        supplier: o.supplier,
        location: o.location,
        metrics: o.supplierMetrics,
      }));
    },

    async saveDraft({ shopKey, operationId, offerId, quantity, targetPriceCents, note: memo }) {
      note('saveDraft');
      throwInjected(memo);
      const draftId = `draft-${crypto.createHash('sha256').update(`${shopKey}|${operationId}`).digest('hex').slice(0, 12)}`;
      return {
        draftId,
        shopKey,
        offerId: String(offerId),
        quantity: quantity ?? 1,
        targetPriceCents: targetPriceCents ?? null,
        note: memo ?? null,
        status: 'DRAFT',
        savedAt: new Date().toISOString(),
      };
    },

    async submitOrder({ shopKey, operationId, offerId, quantity, priceCents, confirm }) {
      note('submitOrder');
      if (confirm !== true) throw new Error('未确认提交（confirm=true 才可下单）');
      if (!fixtureOffer(offerId)) throw new Error(`业务错误 404：offer ${offerId} 不存在`);
      const orderId = `PO-${crypto.createHash('sha256').update(`${shopKey}|${operationId}`).digest('hex').slice(0, 16).toUpperCase()}`;
      return {
        orderId,
        shopKey,
        offerId: String(offerId),
        quantity: quantity ?? 1,
        amountCents: (priceCents ?? 0) * (quantity ?? 1) || null,
        status: 'SUBMITTED',
        channel: 'mock-gateway',
        submittedAt: new Date().toISOString(),
      };
    },

    async login({ timeoutSec }) {
      note('login');
      return { ok: true, loggedIn: true, imageSearchReady: true, timeoutSec: timeoutSec ?? 300, hint: 'mock 模式：无需登录' };
    },
  };
}
