/**
 * inject.js —— MAIN world 探针（document_start 注入）
 *
 * 职责：
 *   1. 劫持页面自身 XHR / fetch，按规则改写 query（必要时 body），并捕获响应体。
 *   2. 类目接口单独走 CATEGORY_DATA（不写错 storage 键）。
 *   3. PAGE_FETCH：用页面会话（credentials:'include'）代发站内 GET，只回响应体。
 *
 * 四项安全加固（原版观星树插件的缺陷，逐条对应）：
 *   A. 按 type 严格分流：只有白名单 type 才处理，杜绝「任意消息都被当作类目数据」的跨协议污染。
 *   B. 动态 channelToken 握手：SW 从 WS 的 CHALLENGE 拿到一次性 token 后经 content 下发，
 *      本脚本只接受带正确 token 的指令；token 每次连接轮换，未握手不下发任何采集动作。
 *   C. Request body 改写：fetch 入参为 Request 对象时，clone().text() 读取自身 body 并重建 Request，
 *      修复原版「只改 init.body、不改 Request.body」导致 POST 场景静默失效的问题。
 *   D. PAGE_FETCH 域名白名单锁死：仅允许 compass.jinritemai.com，杜绝任意页面脚本借会话访问外部域名。
 *
 * 凭证红线：绝不读取 / 回传 document.cookie、Authorization、Set-Cookie。
 * Cookie 仅由浏览器在 fetch 时自动携带，脚本不接触。
 */
(function () {
  'use strict';

  const FLAG = '__WIZSTAR_COMPASS_INJECTED__';
  if (window[FLAG]) return;
  window[FLAG] = true;

  const SRC_IN = 'wizstar_content';
  const SRC_OUT = 'wizstar_inject';
  const ALLOWED_HOSTS = ['compass.jinritemai.com'];
  const CATEGORY_PATH = '/compass_api/config_center/category/cate_list';
  const MAX_BODY_CHARS = 8 * 1024 * 1024;

  const COMMAND_TYPES = new Set([
    'SET_CHANNEL_TOKEN',
    'CLEAR_CHANNEL_TOKEN',
    'SET_INTERCEPT_RULES',
    'CLEAR_INTERCEPT_RULES',
    'PAGE_FETCH'
  ]);

  let channelToken = null;
  let rules = [];
  let selectors = null;
  window.__wizstar_rules__ = rules;
  window.__cate_list__ = null;

  // ------------------------------------------------------------- 工具

  function toHref(value) {
    try { return new URL(String(value), location.href).href; } catch (_) { return String(value || ''); }
  }

  function post(type, payload, meta) {
    const message = { source: SRC_OUT, type, channelToken, ...payload };
    if (meta) message.meta = meta;
    window.postMessage(message, '*');
  }

  function safeMeta(kind, method, url, status, ruleId) {
    return {
      kind,
      method,
      url: toHref(url),
      status,
      ruleId: ruleId || null,
      timestamp: Date.now()
    };
  }

  function applyQuery(url, query) {
    if (!query || typeof query !== 'object') return url;
    try {
      const u = new URL(toHref(url));
      for (const [key, value] of Object.entries(query)) {
        if (value === null || value === undefined) {
          u.searchParams.delete(key);
        } else if (Array.isArray(value)) {
          u.searchParams.delete(key);
          for (const item of value) u.searchParams.append(key, String(item));
        } else {
          u.searchParams.set(key, String(value));
        }
      }
      return u.href;
    } catch (_) {
      return url;
    }
  }

  function queryMatches(href, expected) {
    if (!expected || typeof expected !== 'object') return true;
    try {
      const u = new URL(href);
      for (const [key, value] of Object.entries(expected)) {
        const actual = u.searchParams.get(key);
        if (Array.isArray(value)) {
          if (!value.map(String).includes(actual)) return false;
        } else if (String(actual) !== String(value)) {
          return false;
        }
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function findRule(href, method) {
    const url = toHref(href);
    for (const rule of rules) {
      const match = rule.match || {};
      let hit = false;
      if (match.url && url.indexOf(match.url) >= 0) hit = true;
      if (!hit && match.urlRegex) {
        try { hit = new RegExp(match.urlRegex).test(url); } catch (_) { hit = false; }
      }
      if (!hit) continue;
      if (!queryMatches(url, match.query)) continue;
      if (rule.method && String(rule.method).toUpperCase() !== String(method || 'GET').toUpperCase()) continue;
      return rule;
    }
    return null;
  }

  function isCategory(url) {
    return toHref(url).indexOf(CATEGORY_PATH) >= 0;
  }

  function hostAllowed(url) {
    try { return ALLOWED_HOSTS.includes(new URL(toHref(url)).hostname); } catch (_) { return false; }
  }

  function deepMerge(base, patch) {
    const out = (base && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : {};
    if (!patch || typeof patch !== 'object') return out;
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
        out[k] = deepMerge(out[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /** 按 bodyType 改写请求体：JSON 深合并 / urlencoded set / 字符串原样。 */
  function rewriteBody(body, rule) {
    const patch = rule && rule.request && rule.request.body;
    if (!patch || !Object.keys(patch).length) return body;
    const bodyType = (rule.request && rule.request.bodyType) || 'json';

    if (bodyType === 'urlencoded') {
      const params = new URLSearchParams(typeof body === 'string' ? body : '');
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined) params.delete(k);
        else params.set(k, String(v));
      }
      return params.toString();
    }
    if (body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer) return body;
    let base = {};
    if (typeof body === 'string' && body.trim()) {
      try { base = JSON.parse(body); } catch (_) { return body; }
    } else if (body && typeof body === 'object') {
      base = body;
    }
    return JSON.stringify(deepMerge(base, patch));
  }

  function parseText(text, contentType) {
    if (!contentType || contentType.indexOf('application/json') >= 0) {
      try { return JSON.parse(text); } catch (_) { return text; }
    }
    return text;
  }

  function truncate(text) {
    return typeof text === 'string' && text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text;
  }

  // ------------------------------------------------------------- XHR 劫持

  const NativeXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new NativeXHR();
    let method = 'GET';
    let href = '';
    let rule = null;

    const nativeOpen = xhr.open;
    xhr.open = function (m, u, ...rest) {
      method = String(m || 'GET').toUpperCase();
      href = toHref(u);
      if (!isCategory(href)) {
        rule = findRule(href, method);
        if (rule) href = applyQuery(href, rule.request && rule.request.query);
      }
      return nativeOpen.call(this, method, href, ...rest);
    };

    const nativeSend = xhr.send;
    xhr.send = function (body) {
      let payload = body;
      if (rule && rule.request && rule.request.body) payload = rewriteBody(body, rule);
      xhr.addEventListener('loadend', () => {
        try {
          const text = truncate(xhr.responseText || '');
          const data = parseText(text, xhr.getResponseHeader && xhr.getResponseHeader('content-type'));
          if (isCategory(href)) {
            window.__cate_list__ = data;
            post('CATEGORY_DATA', { data }, safeMeta('xhr', method, href, xhr.status));
          } else if (rule && (rule.captureResponse !== false)) {
            post('API_RESPONSE', { data }, safeMeta('xhr', method, href, xhr.status, rule.id));
          }
        } catch (_) { /* 捕获失败不影响页面自身请求 */ }
      });
      return nativeSend.call(this, payload);
    };
    return xhr;
  }
  PatchedXHR.prototype = NativeXHR.prototype;
  Object.defineProperty(PatchedXHR, 'UNSENT', { value: 0 });
  window.XMLHttpRequest = PatchedXHR;

  // ------------------------------------------------------------- fetch 劫持

  const nativeFetch = window.fetch.bind(window);

  /** 归一化 fetch 入参：Request 对象 → [rewrittenUrl, rewrittenInit]（含 Request 自身 body）。 */
  async function normalizeFetchInput(input, init, rule) {
    let url = typeof input === 'string' ? input : (input && input.url) || '';
    let options = init ? { ...init } : {};
    url = applyQuery(url, rule && rule.request && rule.request.query);

    if (typeof Request !== 'undefined' && input instanceof Request) {
      let body = options.body;
      if (body === undefined) {
        try { body = await input.clone().text(); } catch (_) { body = undefined; }
      }
      // 关键修复：Request 自身的 body 也参与改写，而非只改 init.body
      if (body !== undefined && body !== null && rule && rule.request && rule.request.body) {
        body = rewriteBody(body, rule);
      }
      options = {
        method: input.method,
        headers: input.headers,
        credentials: input.credentials,
        cache: input.cache,
        mode: input.mode,
        redirect: input.redirect,
        referrer: input.referrer,
        referrerPolicy: input.referrerPolicy,
        integrity: input.integrity,
        keepalive: input.keepalive,
        signal: input.signal,
        ...options,
        body
      };
      return [url, options];
    }

    if (options.body !== undefined && options.body !== null && rule && rule.request && rule.request.body) {
      options.body = rewriteBody(options.body, rule);
    }
    return [url, options];
  }

  window.fetch = async function (input, init) {
    const rawUrl = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init && init.method) || (input && input.method) || 'GET';
    const category = isCategory(rawUrl);
    const rule = category ? null : findRule(rawUrl, method);

    let args;
    try {
      args = await normalizeFetchInput(input, init, rule);
    } catch (_) {
      args = [input, init];
    }

    const response = await nativeFetch(...args);
    try {
      const finalUrl = toHref(args[0]);
      const clone = response.clone();
      const text = truncate(await clone.text());
      const data = parseText(text, response.headers && response.headers.get && response.headers.get('content-type'));
      if (category) {
        window.__cate_list__ = data;
        post('CATEGORY_DATA', { data }, safeMeta('fetch', method, finalUrl, response.status));
      } else if (rule && rule.captureResponse !== false) {
        post('API_RESPONSE', { data }, safeMeta('fetch', method, finalUrl, response.status, rule.id));
      }
    } catch (_) { /* 捕获失败不影响页面自身请求 */ }
    return response;
  };

  // ------------------------------------------------------------- 消息入口（严格 type 分流）

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== SRC_IN) return;
    if (!COMMAND_TYPES.has(msg.type)) return;                 // A. 类型白名单
    if (msg.type !== 'SET_CHANNEL_TOKEN' && !channelToken) return;
    if (msg.type !== 'SET_CHANNEL_TOKEN' && msg.channelToken !== channelToken) return; // B. token 校验

    switch (msg.type) {
      case 'SET_CHANNEL_TOKEN':
        channelToken = typeof msg.channelToken === 'string' && msg.channelToken ? msg.channelToken : null;
        selectors = msg.selectors || selectors;
        if (selectors && Array.isArray(selectors.allowedHosts)) {
          ALLOWED_HOSTS.splice(0, ALLOWED_HOSTS.length, ...selectors.allowedHosts);
        }
        post('CHANNEL_READY', { ready: Boolean(channelToken) });
        break;

      case 'CLEAR_CHANNEL_TOKEN':
        channelToken = null;
        rules = [];
        window.__wizstar_rules__ = rules;
        break;

      case 'SET_INTERCEPT_RULES':
        rules = Array.isArray(msg.rules) ? msg.rules : [];
        window.__wizstar_rules__ = rules;
        post('RULES_APPLIED', { count: rules.length });
        break;

      case 'CLEAR_INTERCEPT_RULES':
        rules = [];
        window.__wizstar_rules__ = rules;
        break;

      case 'PAGE_FETCH': {
        const requestId = msg.requestId;
        const url = toHref(msg.url || '');
        // D. 域名白名单锁死：拒绝一切非罗盘域名，且不回传任何凭证字段
        if (!hostAllowed(url)) {
          post('PAGE_FETCH_RESULT', {
            requestId, ok: false, status: 0,
            error: `域名白名单拒绝：${(function () { try { return new URL(url).hostname; } catch (_) { return url; } })()}`
          });
          return;
        }
        const init = { credentials: 'include', method: (msg.init && msg.init.method) || 'GET', ...(msg.init || {}) };
        try {
          const response = await nativeFetch(url, init);
          const body = truncate(await response.text());
          post('PAGE_FETCH_RESULT', { requestId, ok: response.ok, status: response.status, body });
        } catch (e) {
          post('PAGE_FETCH_RESULT', { requestId, ok: false, status: 0, error: String(e && e.message || e) });
        }
        break;
      }
    }
  });

  // 通知 content：注入脚本已就绪（不带 token，content 会等 SW 下发）
  window.postMessage({ source: SRC_OUT, type: 'INJECT_READY', channelToken: null }, '*');
})();
