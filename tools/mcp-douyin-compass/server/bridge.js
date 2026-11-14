#!/usr/bin/env node
/**
 * WebSocket 桥接网关（零依赖，手写 RFC6455 帧编解码）
 *
 * 职责：MCP 服务 ←→ 浏览器 MV3 探针。服务本身不持有罗盘 Cookie，
 * 所有站内请求由探针在「已登录页面会话」里发起，只回传响应体。
 *
 * 安全加固（原版观星树插件没有，本实现新增）：
 *   1. 动态 channelToken 握手：WS 建连后服务端立刻下发一次性 CHALLENGE，
 *      探针 5s 内回 HELLO 且 token 一致才算会话建立；token 每次连接轮换。
 *   2. 代际号 generation：断线重连后旧任务的所有等待器立即作废，
 *      并丢弃旧代际的回包，防止过期数据污染新任务。
 *   3. 来源锁死：仅接受 127.0.0.1/::1，Origin 只允许 chrome-extension:// 或空。
 *   4. 出站指令白名单：CMD 里的 URL 必须是 compass.jinritemai.com（PAGE_FETCH 域名白名单）。
 *
 * 消息协议（与 extension-mv3/ 对齐）：
 *   服务 → 探针：CHALLENGE / CMD / PING / ABORT / HELLO_ACK
 *   探针 → 服务：HELLO / RESULT / ERROR / PONG / EVENT / CAPTURE
 *
 * 生命周期：attach() 返回 { state, send, handleUpgrade, close }；
 * index.js 通过 optionalRequire 自动接线，骨架无需改动。
 */
'use strict';

const crypto = require('crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PROBE_TIMEOUT_MS = 20000;      // 单次指令等待上限
const HELLO_TIMEOUT_MS = 5000;       // CHALLENGE → HELLO 上限
const HEARTBEAT_INTERVAL_MS = 15000; // PING 周期（对抗 MV3 SW 空闲挂起）
const IDLE_TIMEOUT_MS = 40000;       // 无任何帧则判定断连
const ALLOWED_HOSTS = new Set(['compass.jinritemai.com']);
const MAX_FRAME_BYTES = 8 * 1024 * 1024; // 单条消息上限，防内存打爆

// ---------------------------------------------------------------- 帧编解码

/** 服务端发送的帧（不 mask，RFC6455 §5.1）。 */
function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f); // FIN=1
  return Buffer.concat([header, body]);
}

function encodeText(obj) {
  return encodeFrame(0x1, JSON.stringify(obj));
}

/**
 * 增量帧解码器：处理粘包 / 半包 / 分片（continuation）。
 * 客户端帧必须 masked；服务端按掩码还原 payload。
 */
class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const messages = [];
    for (;;) {
      const frame = this.readOne();
      if (!frame) break;
      const result = this.consume(frame);
      if (result) messages.push(result);
    }
    return messages;
  }

  readOne() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MAX_FRAME_BYTES)) throw new Error('WS 帧超过大小上限');
      len = Number(big);
      offset += 8;
    }
    if (len > MAX_FRAME_BYTES) throw new Error('WS 帧超过大小上限');

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;

    let payload = Buffer.from(buf.subarray(offset, offset + len));
    if (masked) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload, masked };
  }

  consume(frame) {
    const { opcode, fin, payload } = frame;

    if (opcode === 0x8) return { control: 'close', payload };
    if (opcode === 0x9) return { control: 'ping', payload };
    if (opcode === 0xa) return { control: 'pong', payload };

    if (opcode === 0x0) {
      this.fragments.push(payload);
      if (!fin) return null;
      const full = Buffer.concat(this.fragments);
      this.fragments = [];
      return this.decodeMessage(this.fragmentOpcode, full);
    }

    if (opcode === 0x1 || opcode === 0x2) {
      if (!fin) {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        return null;
      }
      return this.decodeMessage(opcode, payload);
    }
    return null;
  }

  decodeMessage(opcode, payload) {
    if (opcode !== 0x1) return { binary: payload };
    const text = payload.toString('utf8');
    try {
      return { json: JSON.parse(text) };
    } catch (_) {
      return { text };
    }
  }
}

// ---------------------------------------------------------------- 桥接

function attach(options = {}) {
  const onEvent = typeof options.onFrames === 'function' ? options.onFrames : null;

  let socket = null;
  let decoder = new FrameDecoder();
  let generation = 0;
  let channelToken = null;
  let helloed = false;
  let helloTimer = null;
  let lastSeen = 0;
  let probeInfo = { tab: null, url: null, loggedIn: false, version: null };
  let heartbeat = null;
  let watchdog = null;
  let pending = new Map();  // commandId -> { resolve, reject, timer, generation }
  let queue = [];           // 串行指令队列（罗盘同刻只允许一个任务）
  let running = null;

  function state() {
    return {
      connected: Boolean(socket && helloed),
      reason: socket
        ? (helloed ? null : '等待探针 HELLO 握手')
        : '探针未连接（请在已登录罗盘的浏览器安装 MV3 扩展）',
      tabs: socket && helloed ? 1 : 0,
      loggedIn: Boolean(probeInfo.loggedIn),
      generation,
      pending: pending.size,
      queued: queue.length,
      running: running ? running.commandId : null,
      probe: helloed ? { tab: probeInfo.tab, url: probeInfo.url, version: probeInfo.version } : null
    };
  }

  function rawSend(frame) {
    if (!socket || socket.destroyed) return false;
    try { socket.write(frame); return true; } catch (_) { return false; }
  }

  function sendJson(obj) {
    return rawSend(encodeText(obj));
  }

  function rejectAll(reason) {
    for (const [commandId, item] of pending) {
      clearTimeout(item.timer);
      item.reject(new Error(reason));
      pending.delete(commandId);
    }
    for (const item of queue) item.reject(new Error(reason));
    queue = [];
    running = null;
  }

  function teardown(reason) {
    generation++;
    if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
    helloed = false;
    channelToken = null;
    probeInfo = { tab: null, url: null, loggedIn: false, version: null };
    decoder = new FrameDecoder();
    rejectAll(reason);
    if (socket && !socket.destroyed) {
      try { socket.end(); } catch (_) { /* ignore */ }
    }
    socket = null;
  }

  function onFrame(msg) {
    lastSeen = Date.now();
    if (msg.control === 'ping') { rawSend(encodeFrame(0xa, msg.payload)); return; }
    if (msg.control === 'pong') return;
    if (msg.control === 'close') {
      // RFC6455 §5.5.1：收到 close 必须回一个 close 帧，再关闭连接
      rawSend(encodeFrame(0x8, msg.payload && msg.payload.length ? msg.payload.subarray(0, 2) : Buffer.alloc(0)));
      teardown('探针主动关闭连接');
      return;
    }
    if (!msg.json) return;

    const m = msg.json;
    const type = String(m.type || '');

    if (!helloed) {
      if (type !== 'HELLO' || m.channelToken !== channelToken || !channelToken) {
        teardown('channelToken 握手失败');
        return;
      }
      helloed = true;
      if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
      probeInfo = {
        tab: m.tab || null,
        url: m.url || null,
        loggedIn: Boolean(m.loggedIn),
        version: m.version || null
      };
      sendJson({ type: 'HELLO_ACK', generation, heartbeatMs: HEARTBEAT_INTERVAL_MS });
      return;
    }

    // 代际号校验：重连前的回包一律丢弃，绝不污染新任务
    if (m.generation !== undefined && Number(m.generation) !== generation) return;

    if (type === 'PONG') return;

    if (type === 'RESULT' || type === 'ERROR' || type === 'CAPTURE') {
      const item = pending.get(m.commandId);
      if (!item) return; // 超时或已作废
      if (item.generation !== generation) return;
      clearTimeout(item.timer);
      pending.delete(m.commandId);
      if (type === 'ERROR') item.reject(new Error(String(m.error || '探针返回错误')));
      else item.resolve(m.payload !== undefined ? m.payload : m);
      running = null;
      drain();
      return;
    }

    if (type === 'EVENT') {
      if (m.event === 'login') probeInfo.loggedIn = Boolean(m.loggedIn);
      if (m.event === 'url') probeInfo.url = m.url || null;
      if (onEvent) {
        try { onEvent(m); } catch (e) { console.warn('[bridge] onEvent 异常:', e.message); }
      }
    }
  }

  /** 域名白名单：探针只能对罗盘域名发起站内请求。 */
  function assertAllowedUrl(params) {
    const url = params && (params.url || params.endpoint);
    if (!url || typeof url !== 'string') return;
    let host;
    try { host = new URL(url, 'https://compass.jinritemai.com').hostname; } catch (_) {
      throw new Error('非法 URL');
    }
    if (!ALLOWED_HOSTS.has(host)) {
      throw new Error(`PAGE_FETCH 域名白名单拒绝：${host}`);
    }
  }

  function drain() {
    if (running || !helloed || queue.length === 0) return;
    const item = queue.shift();
    running = { commandId: item.commandId };

    let timer;
    const rejectOnTimeout = () => {
      pending.delete(item.commandId);
      if (running && running.commandId === item.commandId) running = null;
      item.reject(new Error(`探针响应超时（${PROBE_TIMEOUT_MS}ms）`));
      drain();
    };
    timer = setTimeout(rejectOnTimeout, item.timeoutMs || PROBE_TIMEOUT_MS);
    pending.set(item.commandId, {
      resolve: item.resolve,
      reject: item.reject,
      timer,
      generation
    });

    const sent = sendJson({
      type: 'CMD',
      commandId: item.commandId,
      generation,
      action: item.action,
      params: item.params
    });
    if (!sent) {
      clearTimeout(timer);
      pending.delete(item.commandId);
      running = null;
      item.reject(new Error('探针连接已断开'));
      drain();
    }
  }

  /**
   * 下发一条指令并等待探针回包。串行执行，超时 20s。
   * @returns {Promise<*>} 探针回传的 payload
   */
  function send(action, params = {}, timeoutMs = PROBE_TIMEOUT_MS) {
    const st = state();
    if (!st.connected) return Promise.reject(new Error(st.reason || '探针未连接'));
    try { assertAllowedUrl(params); } catch (e) { return Promise.reject(e); }

    const commandId = 'cmd-' + crypto.randomBytes(10).toString('hex');
    return new Promise((resolve, reject) => {
      queue.push({ commandId, action, params, timeoutMs, resolve, reject });
      drain();
    });
  }

  /** 中断当前任务与所有排队任务（供任务取消/代际切换使用）。 */
  function abortAll(reason = '任务被中断') {
    const current = running && running.commandId;
    if (current) sendJson({ type: 'ABORT', commandId: current, generation, reason });
    rejectAll(reason);
  }

  function handleUpgrade(req, sock, head) {
    // 1) 来源锁死：只允许本机回环
    const remote = req.socket.remoteAddress || '';
    if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote)) {
      sock.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      sock.destroy();
      return;
    }
    // 2) Origin 白名单：浏览器扩展或同源页面，拒绝普通网页越权连入
    const origin = String(req.headers.origin || '');
    if (origin && !/^chrome-extension:\/\//.test(origin) && !/^https:\/\/compass\.jinritemai\.com$/.test(origin)) {
      sock.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      sock.destroy();
      return;
    }
    // 3) 标准升级头校验
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || version !== '13') {
      sock.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      sock.destroy();
      return;
    }

    // 已有连接：让旧代际作废，新连接接管
    if (socket) teardown('探针重连，旧代际作废');

    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    socket = sock;
    decoder = new FrameDecoder();
    helloed = false;
    generation++;
    channelToken = crypto.randomBytes(24).toString('base64url');
    lastSeen = Date.now();

    sock.on('data', (chunk) => {
      try {
        const messages = decoder.push(chunk);
        for (const m of messages) onFrame(m);
      } catch (e) {
        console.warn('[bridge] 帧解析异常:', e.message);
        teardown('帧解析异常：' + e.message);
      }
    });
    sock.on('error', () => teardown('探针连接异常'));
    sock.on('close', () => { if (socket === sock) teardown('探针连接关闭'); });

    // 动态握手：先发 CHALLENGE，5s 内等 HELLO
    sendJson({ type: 'CHALLENGE', channelToken, generation, helloTimeoutMs: HELLO_TIMEOUT_MS });
    helloTimer = setTimeout(() => {
      if (!helloed) teardown('HELLO 握手超时');
    }, HELLO_TIMEOUT_MS);

    heartbeat = setInterval(() => {
      if (!socket || socket.destroyed) return;
      sendJson({ type: 'PING', ts: Date.now(), generation });
    }, HEARTBEAT_INTERVAL_MS);

    watchdog = setInterval(() => {
      if (socket && Date.now() - lastSeen > IDLE_TIMEOUT_MS) {
        teardown('探针心跳超时（MV3 SW 可能被挂起）');
      }
    }, 5000);
  }

  function close() {
    teardown('服务关闭');
  }

  return { state, send, abortAll, handleUpgrade, close, get generation() { return generation; } };
}

module.exports = {
  attach,
  encodeFrame,
  encodeText,
  FrameDecoder,
  PROBE_TIMEOUT_MS,
  ALLOWED_HOSTS
};
