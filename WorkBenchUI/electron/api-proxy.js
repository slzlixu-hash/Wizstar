'use strict';

/**
 * 本地 API 代理（主进程侧，A1 只读 → A2 读写）。
 *
 * 同时被 electron/main.js（正常运行）与 scripts/capture.js（截图验收）注册，
 * 避免截图时因缺少 ipcMain handler 导致渲染层降级 / 主进程报错。
 *
 * 只放行 /api/ 下的相对路径 + 四种方法；失败返回 { ok:false, error }，永不抛到渲染进程。
 * `api:get` 保留给 A1 的 bootstrap 探测使用，内部复用同一套请求逻辑。
 */

const API_BASE = process.env.WIZSTAR_API_BASE || 'http://127.0.0.1:5301';
const API_TIMEOUT_MS = 2500;
const API_WRITE_TIMEOUT_MS = 12000;
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

function isAllowedApiPath(apiPath) {
  return (
    typeof apiPath === 'string' &&
    apiPath.startsWith('/api/') &&
    !apiPath.includes('..') &&
    !apiPath.includes('\\') &&
    !apiPath.includes('://')
  );
}

async function callApi(method, apiPath, body) {
  const verb = String(method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.includes(verb)) {
    return { ok: false, status: 0, error: '非法请求方法' };
  }
  if (!isAllowedApiPath(apiPath)) {
    return { ok: false, status: 0, error: '非法 API 路径' };
  }

  const headers = { Accept: 'application/json' };
  const init = { method: verb, headers };
  if (verb !== 'GET' && body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const timeout = verb === 'GET' ? API_TIMEOUT_MS : API_WRITE_TIMEOUT_MS;
  try {
    const response = await fetch(API_BASE + apiPath, {
      ...init,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      /* 非 JSON 响应原样回传，由渲染层判失败 */
    }
    return { ok: response.ok, status: response.status, body: parsed };
  } catch (err) {
    return { ok: false, status: 0, error: err && err.message ? String(err.message) : 'API 未连接' };
  }
}

function registerApiProxy(ipcMain) {
  // A1 兼容通道
  ipcMain.handle('api:get', async (_event, apiPath) => callApi('GET', apiPath, null));

  // A2 通用读写通道（系统设置 → 模型与 API Key）
  ipcMain.handle('api:request', async (_event, payload) => {
    const p = payload || {};
    return callApi(p.method, p.path, p.body);
  });
}

module.exports = { registerApiProxy, API_BASE, API_TIMEOUT_MS, API_WRITE_TIMEOUT_MS };
