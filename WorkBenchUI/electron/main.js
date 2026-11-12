'use strict';

/**
 * AgentWorkBench 桌面端主进程（纯界面演示）。
 *
 * 两个窗口：
 *  - 登录窗口：renderer/login.html，无系统边框，自绘标题栏。
 *  - 主窗口：renderer/index.html，无系统边框，自绘标题栏 + 侧边导航。
 *
 * 本阶段只实现界面，不接任何业务接口：窗口控制、登录/退出窗口切换走 IPC，
 * 其余交互全部在渲染进程内用演示数据完成。
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const APP_ICON = path.join(RENDERER_DIR, 'assets', 'app-icon.png');

/** @type {BrowserWindow | null} */
let loginWindow = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;

const BASE_WINDOW_OPTIONS = {
  frame: false,
  backgroundColor: '#060a13',
  show: false,
  autoHideMenuBar: true,
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
  },
};

function createLoginWindow() {
  if (loginWindow) {
    loginWindow.show();
    loginWindow.focus();
    return loginWindow;
  }

  loginWindow = new BrowserWindow({
    ...BASE_WINDOW_OPTIONS,
    width: 1180,
    height: 720,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#05080f',
    title: 'AgentWorkBench · 登录',
    ...(app.isPackaged ? { icon: APP_ICON } : {}),
  });

  loginWindow.loadFile(path.join(RENDERER_DIR, 'login.html'));

  loginWindow.once('ready-to-show', () => {
    if (loginWindow) loginWindow.show();
  });

  loginWindow.on('closed', () => {
    loginWindow = null;
  });

  return loginWindow;
}

function createMainWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    ...BASE_WINDOW_OPTIONS,
    width: 1440,
    height: 920,
    minWidth: 1200,
    minHeight: 760,
    title: 'AgentWorkBench · 运营指挥工作台',
    ...(app.isPackaged ? { icon: APP_ICON } : {}),
  });

  mainWindow.loadFile(path.join(RENDERER_DIR, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (mainWindow) mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外链一律交给系统浏览器，不在应用内打开。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

function windowFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

/* ------------------------------------------------------------------ */
/* 窗口控制 IPC                                                        */
/* ------------------------------------------------------------------ */

ipcMain.on('win:minimize', (event) => windowFromEvent(event)?.minimize());

ipcMain.on('win:toggle-maximize', (event) => {
  const win = windowFromEvent(event);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

ipcMain.on('win:close', (event) => windowFromEvent(event)?.close());

/** 登录 → 打开主窗口并关闭登录窗口（演示：不校验账号密码）。 */
ipcMain.on('auth:login', () => {
  createMainWindow();
  if (loginWindow) {
    const win = loginWindow;
    loginWindow = null;
    win.close();
  }
});

/** 退出登录 → 回到登录窗口。 */
ipcMain.on('auth:logout', () => {
  createLoginWindow();
  if (mainWindow) {
    const win = mainWindow;
    mainWindow = null;
    win.close();
  }
});

/* ------------------------------------------------------------------ */
/* 应用生命周期                                                        */
/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
  createLoginWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createLoginWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 仅允许本地渲染进程；禁止导航到外部页面。
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
});
