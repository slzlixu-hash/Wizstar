import { withPage, pageState, stateError, sleep } from '../browser.js';
import { parseMtop } from '../mtop.js';
import { T } from '../config.js';

const SKU_API = /wosc\.queryofferskuselectormodel/i;

function findSkuModel(raws) {
  for (const raw of raws) {
    try {
      const json = parseMtop(raw);
      const m = json?.data?.skuSelectorBizModel;
      if (m) return m;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function slimSku(m) {
  if (!m) return null;
  const props = (m.skuProps || []).map((p) => ({
    name: p.prop,
    values: (p.value || []).map((v) => v.name).slice(0, 30),
  }));
  return {
    price: m.skuPriceScale ?? null,
    multiPrice: m.skuMultiPriceScale ?? null,
    props,
    skuCount: Object.keys(m.skuInfoMap || {}).length,
    skus: Object.keys(m.skuInfoMap || {}).slice(0, 40).map((k) => k.replace(/&gt;/g, '>')),
  };
}

/**
 * 商品详情。
 * 页面数据不只在 XHR 里：标题/公司名在服务端渲染的 DOM 中，
 * 价格与 SKU 在 mtop.1688.wosc.queryofferskuselectormodel 的 skuSelectorBizModel 里。
 */
export async function getOffer({ offerId }) {
  if (!/^\d+$/.test(String(offerId))) throw new Error('offerId 必须是数字');

  return withPage(async (page) => {
    const raws = [];
    const onResponse = async (resp) => {
      if (!SKU_API.test(resp.url())) return;
      try {
        raws.push(await resp.text());
      } catch {
        /* ignore */
      }
    };
    page.on('response', onResponse);

    try {
      const url = `https://detail.1688.com/offer/${offerId}.html`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: T.nav });
      const bad = stateError(pageState(page));
      if (bad) throw bad;

      // SKU 接口可能晚于首屏，最多等 15s
      const start = Date.now();
      while (Date.now() - start < 15000 && !raws.length) await sleep(400);
      await sleep(800);

      const dom = await page.evaluate(() => {
        const txt = (sels) => {
          for (const s of sels) {
            const el = document.querySelector(s);
            if (el && el.innerText && el.innerText.trim()) return el.innerText.trim();
          }
          return null;
        };
        return {
          documentTitle: document.title,
          company: txt(['h1', '[class*="company-name"]', '[class*="shop-name"]', '.company-name']),
          priceText: txt(['[class*="price-text"]', '[class*="price"] .value', '.price-text']),
        };
      });

      const sku = slimSku(findSkuModel(raws));
      const title = String(dom.documentTitle || '').replace(/\s*-\s*阿里巴巴\s*$/, '').trim();

      return {
        offerId: String(offerId),
        url,
        title,
        price: sku?.multiPrice || sku?.price || null,
        supplier: dom.company,
        sku,
      };
    } finally {
      page.off('response', onResponse);
    }
  });
}
