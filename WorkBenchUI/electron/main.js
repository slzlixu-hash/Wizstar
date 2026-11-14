'use strict';

/**
 * AgentWorkBench 桌面端主进程（A1 联调阶段）。
 *
 * 两个窗口：
 *  - 登录窗口：renderer/login.html，无系统边框，自绘标题栏。
 *  - 主窗口：renderer/index.html，无系统边框，自绘标题栏 + 侧边导航。
 *
 * 窗口控制、登录/退出窗口切换走 IPC；业务数据通过下面的 IPC 代理只读拉取
 * 本地 Wizstar.Api（渲染进程 sandbox:true，不直接发起网络请求）。
 * API 不可用时渲染层进入离线重试页（无演示回退），不影响界面启动。
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const { registerApiProxy, callApi, setAuthToken, clearAuthToken } = require('./api-proxy');
const { save: saveCredentials, load: loadCredentials, clear: clearCredentials } = require('./credentials');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const APP_ICON = path.join(RENDERER_DIR, 'assets', 'app-icon.png');

/** @type {BrowserWindow | null} */
let loginWindow = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** 当前登录用户（由 /api/auth/login 返回；令牌只在主进程内存里） */
let currentUser = null;

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

/* ------------------------------------------------------------------ */
/* 本地 API 只读代理（A1 联调）                                        */
/* ------------------------------------------------------------------ */

// 与 scripts/capture.js 共用的实现见 electron/api-proxy.js：
// 127.0.0.1 白名单 + /api/ 前缀校验 + 2.5s 超时，失败只返回结果、不抛异常。
// 令牌过期（401）时自动回到登录窗口，避免主界面停留在「接口全失败」的假离线态。
registerApiProxy(ipcMain, {
  onUnauthorized: () => {
    if (!mainWindow) return; // 登录页自身 401 不算会话过期
    showLogin('登录已过期，请重新登录');
  },
});

/** 切回登录窗口：清空令牌与用户，关闭主窗口后可带一条提示。 */
function showLogin(message) {
  clearAuthToken();
  currentUser = null;

  const win = createLoginWindow();
  if (message && win && !win.isDestroyed()) {
    const notify = () => {
      if (!win.isDestroyed()) win.webContents.send('auth:notice', message);
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', notify);
    else notify();
  }

  if (mainWindow) {
    const closing = mainWindow;
    mainWindow = null;
    closing.close();
  }
}

/** 账号密码换令牌：成功后才开主窗口；失败把服务端文案原样回给登录页。 */
ipcMain.handle('auth:login', async (_event, payload) => {
  const username = String(payload && payload.username ? payload.username : '').trim();
  const password = String(payload && payload.password ? payload.password : '');
  if (!username || !password) {
    return { ok: false, error: '请输入账号和密码' };
  }

  const res = await callApi('POST', '/api/auth/login', { username, password });
  const body = res && res.body;
  if (!res || !res.ok || !body || body.success !== true) {
    const message =
      (body && body.error && body.error.message) ||
      (res && res.error) ||
      (res && res.status === 401 ? '账号或密码错误' : '登录失败，请检查本地服务是否已启动');
    return { ok: false, error: message };
  }

  const data = body.data || {};
  setAuthToken(data.token);
  currentUser = data.user || null;

  // 「记住账号和密码」：勾选则加密落盘，取消勾选则清掉历史凭据
  const remember = !!(payload && payload.remember);
  if (remember) {
    saveCredentials(username, password);
  } else {
    clearCredentials();
  }

  // 先让登录页收到响应，再切换窗口，避免 invoke 被销毁中断
  setImmediate(() => {
    createMainWindow();
    if (loginWindow) {
      const win = loginWindow;
      loginWindow = null;
      win.close();
    }
  });

  return { ok: true, user: currentUser, remembered: remember };
});

/** 读取已记住的账号密码（登录页打开时预填）。 */
ipcMain.handle('auth:remember-get', () => {
  const cred = loadCredentials();
  return cred
    ? { ok: true, username: cred.username, password: cred.password, savedAt: cred.savedAt }
    : { ok: false };
});

/** 清除已记住的账号密码。 */
ipcMain.handle('auth:remember-clear', () => {
  clearCredentials();
  return { ok: true };
});

/** 退出登录 → 回到登录窗口。 */
ipcMain.handle('auth:logout', async () => {
  try {
    await callApi('POST', '/api/auth/logout', {});
  } catch (_) {
    /* 令牌无状态：服务端不可达也允许本地退出 */
  }
  showLogin(null);
  return { ok: true };
});

/** 当前登录用户（渲染层用于页脚展示，不含令牌）。 */
ipcMain.handle('auth:me', () => ({ ok: !!currentUser, user: currentUser }));

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
