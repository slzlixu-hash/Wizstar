'use strict';

/**
 * 本地 API 只读代理（主进程侧，A1）。
 *
 * 同时被 electron/main.js（正常运行）与 scripts/capture.js（截图验收）注册，
 * 避免截图时因缺少 ipcMain handler 导致渲染层降级 / 主进程报错。
 *
 * 只放行 /api/ 下的相对路径；失败返回 { ok:false, error }，永不抛到渲染进程。
 */

const API_BASE = process.env.WIZSTAR_API_BASE || 'http://127.0.0.1:5301';
const API_TIMEOUT_MS = 2500;

function isAllowedApiPath(apiPath) {
  return (
    typeof apiPath === 'string' &&
    apiPath.startsWith('/api/') &&
    !apiPath.includes('..') &&
    !apiPath.includes('\\') &&
    !apiPath.includes('://')
  );
}

function registerApiProxy(ipcMain) {
  ipcMain.handle('api:get', async (_event, apiPath) => {
    if (!isAllowedApiPath(apiPath)) {
      return { ok: false, status: 0, error: '非法 API 路径' };
    }

    try {
      const response = await fetch(API_BASE + apiPath, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      const text = await response.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch (_) {
        /* 非 JSON 响应原样回传，由渲染层判失败 */
      }
      return { ok: response.ok, status: response.status, body };
    } catch (err) {
      return { ok: false, status: 0, error: err && err.message ? String(err.message) : 'API 未连接' };
    }
  });
}

module.exports = { registerApiProxy, API_BASE, API_TIMEOUT_MS };
