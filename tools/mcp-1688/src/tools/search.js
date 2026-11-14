import iconv from 'iconv-lite';
import { withPage, pageState, stateError, sleep } from '../browser.js';
import { createOfferCapture } from '../capture.js';
import { T } from '../config.js';

/**
 * s.1688.com 的 keywords 参数是 GBK 编码的，UTF-8 百分号编码会被当成乱码。
 * 这是 1688-cli 里踩过的坑，这里照搬同样的处理。
 */
function gbkPercent(str) {
  const buf = iconv.encode(str, 'gbk');
  let out = '';
  for (const b of buf) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  return out;
}

const SORT_TYPE = {
  relevance: '',
  'best-selling': 'va_rmdarkgmv30',
  'price-asc': 'va_price_asc',
  'price-desc': 'va_price_desc',
};

export function buildSearchUrl(query, sort = 'relevance') {
  const st = SORT_TYPE[sort] ?? '';
  return `https://s.1688.com/selloffer/offer_search.htm?keywords=${gbkPercent(query)}${
    st ? `&sortType=${encodeURIComponent(st)}` : ''
  }`;
}

export async function searchProducts({ query, max = 20, sort = 'relevance' }) {
  if (!query || !query.trim()) throw new Error('query 不能为空');

  return withPage(async (page) => {
    const cap = createOfferCapture(page);
    try {
      await page.goto(buildSearchUrl(query, sort), {
        waitUntil: 'domcontentloaded',
        timeout: T.nav,
      });
      const bad = stateError(pageState(page));
      if (bad) throw bad;

      let offers = await cap.wait(T.capture);

      // 首屏没抓到就再等一轮（首屏有时先渲染骨架，mtop 后到）
      if (!offers.length) {
        await sleep(2500);
        offers = await cap.wait(5000);
      }

      return {
        query,
        sort,
        url: page.url(),
        total: offers.length,
        offers: offers.slice(0, max),
      };
    } finally {
      cap.dispose();
    }
  });
}
