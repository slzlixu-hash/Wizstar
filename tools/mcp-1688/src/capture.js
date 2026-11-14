import { offersFromMtopText } from './mtop.js';
import { sleep } from './browser.js';

/**
 * 在页面上挂一个响应监听器，抓「商品列表」那条 mtop 响应。
 * 1688 的商品搜索结果来自：
 *   mtop.relationrecommend.wirelessrecommend.recommend
 * 响应体是 JSONP，真实数据在 data.data.OFFER.items。
 */
export function createOfferCapture(page) {
  let offers = [];
  let source = null;
  const errors = [];

  const onResponse = async (resp) => {
    const url = resp.url();
    if (!/mtop\.relationrecommend\.wirelessrecommend\.recommend/i.test(url)) return;
    try {
      const text = await resp.text();
      const list = offersFromMtopText(text);
      // 保留“最长”的一次（首页 + 后续分页补充）
      if (list.length >= offers.length) {
        offers = list;
        source = url;
      }
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  };

  page.on('response', onResponse);

  return {
    offers: () => offers,
    source: () => source,
    errors: () => errors,
    /** 轮询等待，直到拿到结果或超时；返回已抓到的列表 */
    async wait(timeoutMs) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (offers.length > 0) return offers;
        await sleep(300);
      }
      return offers;
    },
    dispose() {
      page.off('response', onResponse);
    },
  };
}
