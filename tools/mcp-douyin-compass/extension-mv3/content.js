/**
 * content.js —— ISOLATED world 桥接层（document_idle 注入）
 *
 * 职责：SW（WS 客户端）↔ inject（MAIN world 探针）之间的唯一中转。
 *   - 从 SW 拿 channelToken 与 selectors.json，下发给 inject（B. 动态握手 + 热更新）。
 *   - 按 type 严格分流 inject 消息（A. 修原版「所有 inject 消息都写 storage.category」的 Bug）。
 *   - DOM 补全真实价格：区间价拆 min/suggested，不再无脑取最小值、不再硬编码 0.01。
 *   - 页签切换 / 翻页读数，供服务端采集任务编排。
 *
 * 凭证红线：本层不读取 document.cookie，不接收也不转发任何 Cookie / Authorization 字段。
 */
(function () {
  'use strict';

  const SRC_TO_INJECT = 'wizstar_content';
  const SRC_FROM_INJECT = 'wizstar_inject';

  // inject → content 的合法 type（其余一律丢弃，杜绝跨协议污染）
  const INJECT_TYPES = new Set([
    'INJECT_READY',
    'CHANNEL_READY',
    'RULES_APPLIED',
    'CATEGORY_DATA',
    'API_RESPONSE',
    'PAGE_FETCH_RESULT'
  ]);

  let channelToken = null;
  let selectors = null;
  let ready = false;
  const pendingFetches = new Map();   // requestId -> { resolve, timer }
  const captureWaiters = new Map();   // ruleId -> [{ resolve, timer, predicate }]
  const categoryWaiters = [];
  let fetchSeq = 0;
  let lastCategory = null;

  function dom() { return selectors && selectors.dom ? selectors.dom : {}; }

  function toInject(type, payload) {
    window.postMessage({ source: SRC_TO_INJECT, type, channelToken, ...payload }, '*');
  }

  // ------------------------------------------------------------- 登录态（启发式，不伪造）
  function detectLogin() {
    const href = location.href;
    if (/\/(login|passport|welcome)(\/|\?|$)/i.test(href)) return false;
    const title = document.title || '';
    if (/登录/.test(title)) return false;
    // 罗盘工作台页通常存在主体容器；找不到时不武断判定为已登录
    const shell = document.querySelector('#root, #app, [class*="layout"], [class*="container"]');
    return Boolean(shell);
  }

  // ------------------------------------------------------------- DOM：真实价格补全
  /**
   * 从 DOM 读商品价格文本并拆分：
   *   "¥100-200" / "100~200" → { min:10000, suggested:20000, unit:'cent', isRange:true }
   *   "¥99.9"                → { min:9990, suggested:9990, unit:'cent', isRange:false }
   * 返回分为单位（避免原版「元/分混淆」与「硬编码 0.01」）。
   */
  function parsePriceText(text) {
    if (!text) return null;
    const cleaned = String(text).replace(/[¥￥,\s]/g, '');
    const numbers = cleaned.match(/\d+(?:\.\d+)?/g);
    if (!numbers || !numbers.length) return null;
    const yuan = numbers.map(Number).filter((n) => Number.isFinite(n));
    if (!yuan.length) return null;
    const isRange = yuan.length >= 2 && /[-~—－至]/.test(cleaned);
    return {
      min: Math.round(yuan[0] * 100),
      suggested: Math.round((isRange ? yuan[1] : yuan[0]) * 100),
      currency: 'CNY',
      unit: 'cent',
      isRange,
      rawText: String(text).trim()
    };
  }

  function readPrices() {
    const cfg = dom();
    const exclude = (cfg.excludeContainers || []).join(',');
    const rows = [];
    const candidates = document.querySelectorAll(cfg.tableRow || 'tbody tr, [class*="product-card"]');
    candidates.forEach((row, index) => {
      if (exclude && row.closest(exclude)) return;
      const priceEl = row.querySelector(cfg.priceText || '[class*="price"]');
      const nameEl = row.querySelector(cfg.productName || '[class*="product-name"]');
      const price = parsePriceText(priceEl && priceEl.textContent);
      if (!price && !(nameEl && nameEl.textContent)) return;
      rows.push({
        index,
        title: nameEl ? nameEl.textContent.trim() : null,
        price
      });
    });
    return {
      rows,
      total: rows.length,
      url: location.href,
      source: 'dom',
      note: '仅用于补全/校正价格；主体指标一律来自 API 响应体'
    };
  }

  // ------------------------------------------------------------- DOM：页签 / 翻页
  function switchTab(label) {
    const cfg = dom();
    const buttons = Array.from(document.querySelectorAll(cfg.tabButtons || '[role=tab], .aurora-tabs-tab-btn'));
    const target = buttons.find((b) => (b.innerText || b.textContent || '').indexOf(label) >= 0);
    if (!target) return { ok: false, error: `未找到榜单击签：${label}` };
    const activeSel = cfg.tabActive || '[aria-selected="true"]';
    const isActive = target.matches(activeSel) || target.getAttribute('aria-selected') === 'true';
    if (isActive) {
      // 原版经验：重复点击同一页签不会触发请求，先点另一个再回来
      const other = buttons.find((b) => b !== target);
      if (other) other.click();
    }
    target.click();
    return { ok: true, label, reclicked: isActive };
  }

  function paginationState() {
    const cfg = dom();
    const totalEl = document.querySelector(cfg.paginationTotal || '.aurora-pagination-total-text');
    const activeEl = document.querySelector(cfg.paginationActive || '.aurora-pagination-item-active');
    const next = document.querySelector(cfg.paginationNext || 'button.aurora-pagination-item-link');
    return {
      totalText: totalEl ? totalEl.textContent.trim() : null,
      current: activeEl ? Number(activeEl.textContent.trim()) || null : null,
      hasNext: Boolean(next) && !next.disabled && !(next.className || '').includes('disabled'),
      url: location.href
    };
  }

  function nextPage() {
    const cfg = dom();
    const links = Array.from(document.querySelectorAll(cfg.paginationNext || 'button.aurora-pagination-item-link'));
    const candidates = links.filter((b) => !b.disabled && !(b.className || '').includes('disabled'));
    if (!candidates.length) return { ok: false, error: '没有可用的翻页按钮' };
    // 原版用下标 0/1 或 2/3 定位「下一页」，这里取最后一个可用的（通常是 next）
    candidates[candidates.length - 1].click();
    return { ok: true, ...paginationState() };
  }

  // ------------------------------------------------------------- 注入层消息（严格 type 分流）
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== SRC_FROM_INJECT) return;
    if (!INJECT_TYPES.has(msg.type)) return;                       // A. 非白名单 type 直接丢弃
    if (msg.type !== 'INJECT_READY' && msg.channelToken !== channelToken) return; // B. token 校验

    switch (msg.type) {
      case 'INJECT_READY':
        if (channelToken) toInject('SET_CHANNEL_TOKEN', { channelToken, selectors });
        break;

      case 'CHANNEL_READY':
        ready = Boolean(msg.ready);
        chrome.runtime.sendMessage({ type: 'PROBE_EVENT', event: 'channel', ready });
        if (ready && selectors) {
          toInject('SET_INTERCEPT_RULES', { rules: buildRules() });
        }
        break;

      case 'CATEGORY_DATA':
        // 只走 CATEGORY_DATA，单独缓存，绝不写进其它键
        lastCategory = msg.data;
        for (const w of categoryWaiters.splice(0)) {
          clearTimeout(w.timer);
          w.resolve({ data: msg.data, meta: msg.meta || null });
        }
        chrome.runtime.sendMessage({ type: 'PROBE_EVENT', event: 'category', ok: true });
        break;

      case 'API_RESPONSE': {
        const ruleId = msg.meta && msg.meta.ruleId;
        const waiters = captureWaiters.get(ruleId) || [];
        const rest = [];
        for (const w of waiters) {
          if (w.predicate && !w.predicate(msg)) { rest.push(w); continue; }
          clearTimeout(w.timer);
          w.resolve({ data: msg.data, meta: msg.meta || null });
        }
        captureWaiters.set(ruleId, rest);
        // 无等待器的自发响应也上报，供服务端做缓存（不带凭证）
        if (!waiters.length) {
          chrome.runtime.sendMessage({
            type: 'PROBE_EVENT', event: 'capture', ruleId,
            data: msg.data, meta: msg.meta || null
          });
        }
        break;
      }

      case 'PAGE_FETCH_RESULT': {
        const item = pendingFetches.get(msg.requestId);
        if (!item) return;
        clearTimeout(item.timer);
        pendingFetches.delete(msg.requestId);
        item.resolve({
          ok: Boolean(msg.ok), status: msg.status || 0,
          body: msg.body === undefined ? null : msg.body,
          error: msg.error || null
        });
        break;
      }
    }
  });

  /** 把 selectors.json 的 rankRules 转成注入规则（query 由服务端任务参数填充）。 */
  function buildRules() {
    if (!selectors || !Array.isArray(selectors.rankRules)) return [];
    return selectors.rankRules.map((r) => ({
      id: r.id,
      match: r.match,
      request: { query: {}, body: {} },
      captureResponse: true
    }));
  }

  function setRules(rules) {
    toInject('SET_INTERCEPT_RULES', { rules: Array.isArray(rules) ? rules : [] });
    return { ok: true, count: Array.isArray(rules) ? rules.length : 0 };
  }

  function pageFetch(url, init, timeoutMs = 30000) {
    const requestId = `page-fetch-${Date.now()}-${++fetchSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingFetches.delete(requestId);
        resolve({ ok: false, status: 0, body: null, error: '罗盘接口请求超时（页面桥接）' });
      }, timeoutMs);
      pendingFetches.set(requestId, { resolve, timer });
      toInject('PAGE_FETCH', { requestId, url, init: init || { method: 'GET' } });
    });
  }

  function waitCapture(ruleId, predicate, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = captureWaiters.get(ruleId) || [];
        captureWaiters.set(ruleId, list.filter((w) => w !== waiter));
        resolve(null);
      }, timeoutMs);
      const waiter = { resolve, timer, predicate: predicate || null };
      const list = captureWaiters.get(ruleId) || [];
      list.push(waiter);
      captureWaiters.set(ruleId, list);
    });
  }

  function waitCategory(timeoutMs = 15000) {
    if (lastCategory) return Promise.resolve({ data: lastCategory, meta: null, cached: true });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = categoryWaiters.indexOf(waiter);
        if (i >= 0) categoryWaiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      const waiter = { resolve, timer };
      categoryWaiters.push(waiter);
    });
  }

  // ------------------------------------------------------------- SW 指令入口
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'PROBE_EXEC') return;

    const { commandId, action, params = {} } = message;
    (async () => {
      switch (action) {
        case 'HELLO':
          // 首次握手：把 SW 拿到的 channelToken + selectors 下发给 inject
          channelToken = message.channelToken || channelToken;
          selectors = message.selectors || selectors;
          if (channelToken) toInject('SET_CHANNEL_TOKEN', { channelToken, selectors });
          return { ok: true, url: location.href, loggedIn: detectLogin(), title: document.title };

        case 'SET_RULES':
          return setRules(params.rules);

        case 'PAGE_FETCH':
          return await pageFetch(params.url, params.init, params.timeoutMs || 30000);

        case 'WAIT_CAPTURE':
          return await waitCapture(params.ruleId, null, params.timeoutMs || 20000) || { ok: false, error: '等待榜单响应超时' };

        case 'GET_CATEGORY':
          return (await waitCategory(params.timeoutMs || 15000)) || { ok: false, error: '等待类目数据超时' };

        case 'SWITCH_TAB':
          return switchTab(String(params.label || ''));

        case 'NEXT_PAGE':
          return nextPage();

        case 'PAGINATION':
          return paginationState();

        case 'READ_PRICES':
          return readPrices();

        case 'PING':
          return { ok: true, url: location.href, loggedIn: detectLogin() };

        default:
          return { ok: false, error: `未知探针指令：${action}` };
      }
    })()
      .then((payload) => sendResponse({ commandId, ok: true, payload }))
      .catch((e) => sendResponse({ commandId, ok: false, error: String(e && e.message || e) }));

    return true; // 异步 sendResponse
  });

  chrome.runtime.sendMessage({ type: 'PROBE_EVENT', event: 'ready', url: location.href, loggedIn: detectLogin() });
})();
