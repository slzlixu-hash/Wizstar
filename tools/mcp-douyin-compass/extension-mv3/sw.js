/**
 * sw.js —— MV3 Service Worker（WS 客户端 / 指令路由）
 *
 * 与 server/bridge.js 的消息协议对齐：
 *   服务 → 探针：CHALLENGE / HELLO_ACK / CMD / PING / ABORT
 *   探针 → 服务：HELLO / RESULT / ERROR / PONG / EVENT
 *
 * 生命周期要点：
 *   - MV3 SW 空闲约 30s 会被挂起。WS 断线后按指数退避重连；服务端 generation 会递增，
 *     旧任务自动作废，重连后由平台侧决定是否重跑（服务绝不伪造在线）。
 *   - 每次连接使用服务端下发的一次性 channelToken，经 content 下发给 MAIN world 探针。
 *   - 指令只转发给「罗盘域名」的标签页，且只回传响应体，绝不回传 Cookie / 凭证。
 *
 * 权限最小化：manifest 仅申请 storage + 罗盘域名 + 127.0.0.1:5206。
 */
'use strict';

const DEFAULT_WS = 'ws://127.0.0.1:5206/ws';
const DEFAULT_SELECTORS_URL = 'http://127.0.0.1:5206/selectors.json';
const COMPASS_MATCH = 'https://compass.jinritemai.com/*';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

let ws = null;
let channelToken = null;
let generation = 0;
let selectors = null;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer = null;
let helloed = false;
let stopped = false;

// ------------------------------------------------------------- 配置

async function getConfig() {
  const stored = await chrome.storage.local.get(['wsUrl', 'selectorsUrl']);
  return {
    wsUrl: stored.wsUrl || DEFAULT_WS,
    selectorsUrl: stored.selectorsUrl || DEFAULT_SELECTORS_URL
  };
}

async function loadSelectors(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    selectors = json;
    await chrome.storage.local.set({ selectors, selectorsUpdatedAt: Date.now() });
    return selectors;
  } catch (e) {
    // 服务未启动时退回上次缓存，保证扩展可装可用
    const cached = await chrome.storage.local.get(['selectors']);
    selectors = cached.selectors || null;
    return selectors;
  }
}

// ------------------------------------------------------------- 标签页定位

async function findCompassTab() {
  const tabs = await chrome.tabs.query({ url: COMPASS_MATCH });
  if (!tabs.length) return null;
  return tabs.find((t) => t.active) || tabs[0];
}

async function execOnPage(action, params = {}, timeoutMs = 25000) {
  const tab = await findCompassTab();
  if (!tab) throw new Error('未找到已打开的抖店罗盘标签页');
  const commandId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await Promise.race([
    chrome.tabs.sendMessage(tab.id, {
      type: 'PROBE_EXEC', commandId, action, params, channelToken
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('标签页响应超时')), timeoutMs))
  ]);
  if (!response) throw new Error('标签页无响应（content script 可能未注入）');
  if (!response.ok) throw new Error(response.error || '探针指令失败');
  return response.payload;
}

/** HELLO 专用：把 token 与 selectors 首次下发给 content。 */
async function helloOnPage(payload) {
  const tab = await findCompassTab();
  if (!tab) return { ok: false, loggedIn: false, note: '未找到罗盘标签页' };
  try {
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: 'PROBE_EXEC', commandId: 'hello', action: 'HELLO',
      params: payload, channelToken
    });
    return res && res.ok ? res.payload : { ok: false, loggedIn: false };
  } catch (_) {
    return { ok: false, loggedIn: false, note: 'content script 尚未就绪' };
  }
}

// ------------------------------------------------------------- 指令分发

async function handleCommand(cmd) {
  const action = String(cmd.action || '');
  const params = cmd.params || {};
  switch (action) {
    case 'PAGE_FETCH':
      return await execOnPage('PAGE_FETCH', params, params.timeoutMs || 30000);
    case 'SET_RULES':
      return await execOnPage('SET_RULES', params);
    case 'SWITCH_TAB':
      return await execOnPage('SWITCH_TAB', params);
    case 'NEXT_PAGE':
      return await execOnPage('NEXT_PAGE', params);
    case 'PAGINATION':
      return await execOnPage('PAGINATION', params);
    case 'WAIT_CAPTURE':
      return await execOnPage('WAIT_CAPTURE', params, params.timeoutMs || 20000);
    case 'GET_CATEGORY':
      return await execOnPage('GET_CATEGORY', params, params.timeoutMs || 15000);
    case 'READ_PRICES':
      return await execOnPage('READ_PRICES', params);
    case 'PING':
      return await execOnPage('PING', params);
    default:
      throw new Error(`未知探针指令：${action}`);
  }
}

function reply(cmd, payload, error) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: error ? 'ERROR' : 'RESULT',
    commandId: cmd.commandId,
    generation,
    ...(error ? { error } : { payload })
  }));
}

// ------------------------------------------------------------- WS 连接

async function connect() {
  if (stopped) return;
  const cfg = await getConfig();
  let socket;
  try {
    socket = new WebSocket(cfg.wsUrl);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws = socket;
  helloed = false;
  channelToken = null;

  socket.onopen = async () => {
    reconnectDelay = RECONNECT_BASE_MS; // 连上即重置退避
    await loadSelectors(cfg.selectorsUrl);
  };

  socket.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }
    const type = String(msg.type || '');

    if (type === 'CHALLENGE') {
      channelToken = msg.channelToken;
      generation = msg.generation;
      const page = await helloOnPage({ token: channelToken, selectors });
      socket.send(JSON.stringify({
        type: 'HELLO',
        channelToken,
        tab: 'compass',
        url: page && page.url ? page.url : COMPASS_MATCH,
        loggedIn: Boolean(page && page.loggedIn),
        version: chrome.runtime.getManifest().version
      }));
      return;
    }

    if (type === 'HELLO_ACK') {
      helloed = true;
      return;
    }

    if (type === 'PING') {
      socket.send(JSON.stringify({ type: 'PONG', generation, ts: msg.ts }));
      return;
    }

    if (type === 'CMD') {
      // 代际号校验：重连前的指令直接丢弃
      if (Number(msg.generation) !== generation) return;
      try {
        const payload = await handleCommand(msg);
        reply(msg, payload);
      } catch (e) {
        reply(msg, null, String(e && e.message || e));
      }
      return;
    }

    if (type === 'ABORT') {
      // 服务端主动中断：无需回包，等待器已在服务端作废
      return;
    }
  };

  socket.onerror = () => { /* 等 onclose 统一处理重连 */ };

  socket.onclose = () => {
    ws = null;
    helloed = false;
    channelToken = null;
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

// ------------------------------------------------------------- 事件与启动

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'PROBE_EVENT') return;
  // 事件只上报状态，不携带任何凭证
  if (message.event === 'login' && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'EVENT', event: 'login', generation, loggedIn: Boolean(message.loggedIn) }));
  }
  if (message.event === 'ready' || message.event === 'channel') {
    sendResponse({ ok: true, connected: Boolean(ws && helloed), generation });
  }
});

chrome.runtime.onInstalled.addListener(() => { connect(); });
chrome.runtime.onStartup.addListener(() => { connect(); });

// SW 每次被唤醒都确保连接存在（MV3 挂起后由服务端 PING/消息唤醒）
if (!ws) connect();
