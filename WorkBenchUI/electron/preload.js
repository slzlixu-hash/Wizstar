'use strict';

/**
 * 预加载脚本：只暴露窗口控制与窗口切换能力。
 * 本阶段没有业务接口，所以这里没有任何网络 / 数据通道。
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
});
