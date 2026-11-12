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

  // 登录 / 退出
  login: () => ipcRenderer.send('auth:login'),
  logout: () => ipcRenderer.send('auth:logout'),

  // A1 只读代理：resolve 为 { ok, status, body, error? }，永不 reject
  apiGet: (apiPath) => ipcRenderer.invoke('api:get', apiPath),

  // A2 读写代理：method ∈ GET/POST/PUT/DELETE，body 为可序列化对象或 null
  apiRequest: (method, apiPath, body) =>
    ipcRenderer.invoke('api:request', { method, path: apiPath, body: body === undefined ? null : body }),
});
