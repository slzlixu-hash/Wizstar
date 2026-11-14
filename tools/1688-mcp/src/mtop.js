/** mtop JSONP 解析 + 搜索结果条目映射（原理与 1688-cli 一致） */

export function parseMtop(text) {
  const trimmed = String(text).trim();
  const m = trimmed.match(/^mtopjsonp\w*\(([\s\S]*)\)$/);
  return JSON.parse(m ? m[1] : trimmed);
}

function bool(s) {
  return s === 'true';
}

function parseCountText(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  if (!text) return null;
  const compact = String(text).replace(/,/g, '').replace(/\s+/g, '');
  const m = compact.match(/(\d+(?:\.\d+)?)(亿|万|w|W|千|k|K)?/);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = m[2] || '';
  const mul = unit === '亿' ? 1e8 : /万|w|W/.test(unit) ? 1e4 : /千|k|K/.test(unit) ? 1e3 : 1;
  return Math.round(v * mul);
}

function parsePercent(text) {
  const m = String(text || '').match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) : null;
}

const texts = (arr) => (arr || []).map((t) => t?.text?.trim() ?? '').filter(Boolean);

export function mapOffer(item) {
  const d = item?.data;
  if (!d?.offerId) return null;
  const priceRaw = d.priceInfo?.price;
  const price = priceRaw ? Number.parseFloat(priceRaw) : null;
  const orderCountText = d.orderCountText ?? d.orderCount ?? d.bookedCount ?? null;
  const repurchaseRateText = d.repurchaseRateText ?? d.repurchaseRate ?? null;
  return {
    offerId: String(d.offerId),
    title: String(d.title ?? '').replace(/<\/?font[^>]*>/g, '').trim(),
    price: { text: priceRaw ? `¥${priceRaw}` : '', min: price, max: price },
    supplier: {
      name: d.shop?.text ?? null,
      shopUrl: d.shopAddition?.shopLinkUrl ?? d.winPortUrl ?? null,
      years: d.shop?.tpYear ? Number.parseInt(d.shop.tpYear, 10) : null,
    },
    location: { province: d.province ?? null, city: d.city ?? null },
    bizType: d.bizType ?? null,
    verified: {
      factory: bool(d.factoryInspection),
      business: bool(d.businessInspection),
      superFactory: bool(d.superFactory),
    },
    tags: texts(d.tags),
    serviceTags: texts(d.serviceTags),
    demand: {
      orderCountText,
      orderCount: typeof d.orderCount === 'number' ? d.orderCount : parseCountText(orderCountText),
      repurchaseRateText,
      repurchaseRate: parsePercent(repurchaseRateText),
    },
    isAd: bool(d.isP4P),
    url: `https://detail.1688.com/offer/${d.offerId}.html`,
    image: d.offerPicUrl ?? null,
  };
}

/** 从 mtop 搜索响应文本里取 OFFER.items 并映射 */
export function offersFromMtopText(text) {
  const json = parseMtop(text);
  const items = json?.data?.data?.OFFER?.items ?? [];
  return items.map(mapOffer).filter(Boolean);
}
