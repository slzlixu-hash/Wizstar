'use strict';

/**
 * 预加载脚本：暴露窗口控制、窗口切换与本地 API 代理。
 * 渲染进程 sandbox:true，业务数据统一经主进程 ipcMain.handle('api:get' / 'api:request') 拉取。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workbench', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  // 窗口控制
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
  close: () => ipcRenderer.send('win:close'),

  // 登录 / 退出：login 走 IPC invoke，返回 { ok, user?, error? }
  // remember=true 时由主进程用 safeStorage 加密保存账号密码（渲染层拿不到已存凭据文件）
  login: (username, password, remember) =>
    ipcRenderer.invoke('auth:login', { username, password, remember: !!remember }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  me: () => ipcRenderer.invoke('auth:me'),
  // 「记住账号和密码」预填 / 清除
  getRemembered: () => ipcRenderer.invoke('auth:remember-get'),
  forgetRemembered: () => ipcRenderer.invoke('auth:remember-clear'),
  // 会话过期 / 退出提示（登录页监听）
  onAuthNotice: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('auth:notice', (_event, message) => callback(message));
  },

  // A1 只读代理：resolve 为 { ok, status, body, error? }，永不 reject
  apiGet: (apiPath) => ipcRenderer.invoke('api:get', apiPath),

  // A2 读写代理：method ∈ GET/POST/PUT/DELETE，body 为可序列化对象或 null
  apiRequest: (method, apiPath, body) =>
    ipcRenderer.invoke('api:request', { method, path: apiPath, body: body === undefined ? null : body }),
});
