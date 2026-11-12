'use strict';

/**
 * 无头截图脚本：逐页加载界面并导出 PNG，供视觉验收使用。
 *
 *   node scripts/start-electron.js --capture                 # 全部页面
 *   node scripts/start-electron.js --capture --only=mcp      # 单页
 *
 * 产物：WorkBenchUI/artifacts/<page>.png 与 capture-report.json
 * 任一页面出现渲染异常（未捕获脚本错误 / console.error）时退出码为 1。
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerApiProxy } = require('../electron/api-proxy');

const ROOT = path.resolve(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');
const OUT_DIR = path.join(ROOT, 'artifacts');

// 每个实例独立 userData，允许并行截图，避免单实例锁。
app.setPath('userData', path.join(os.tmpdir(), `workbench-capture-${process.pid}`));
app.commandLine.appendSwitch('force-device-scale-factor', '1');

// A1：截图脚本自身作为主进程，也需注册本地 API 代理，
// 否则渲染层 apiGet 会报 "No handler registered" 并降级成演示数据。
registerApiProxy(ipcMain);

const argv = process.argv.slice(2);
const onlyArg = argv.find((item) => item.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()) : null;

/** 主窗口页面（1440 × 900）。 */
const PAGES = [
  { id: 'dashboard', hash: '#/dashboard' },
  { id: 'products', hash: '#/products' },
  { id: 'orders', hash: '#/orders' },
  { id: 'shops', hash: '#/shops' },
  { id: 'agents', hash: '#/agents' },
  { id: 'mcp', hash: '#/mcp' },
  { id: 'settings', hash: '#/settings' },
];

const LOGIN = { id: 'login', width: 1180, height: 720 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createWindow(width, height) {
  return new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    backgroundColor: '#060a13',
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
}

async function settle(win, extraMs = 450) {
  await sleep(80);
  if (win.isDestroyed()) return;
  await win.webContents.executeJavaScript(
    `new Promise((resolve) => {
       const done = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
       if (document.fonts && document.fonts.ready) document.fonts.ready.then(done).catch(done);
       else done();
     })`
  );
  await sleep(extraMs);
}

async function capture(win, file) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(file, image.toPNG());
}

/** 收集渲染错误（console.error / 渲染进程崩溃 / preload 错误）。 */
function watchErrors(win) {
  const errors = [];
  win.webContents.on('console-message', (event) => {
    const level = typeof event === 'object' && 'level' in event ? event.level : 'error';
    const message = typeof event === 'object' && 'message' in event ? event.message : String(event);
    if (level === 'error') errors.push(String(message));
  });
  win.webContents.on('render-process-gone', (_e, details) => errors.push(`render-process-gone: ${details.reason}`));
  win.webContents.on('preload-error', (_e, preloadPath, error) =>
    errors.push(`preload-error ${preloadPath}: ${error.message}`)
  );
  return errors;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const report = { generatedAt: new Date().toISOString(), pages: [] };
  const wanted = (id) => !only || only.includes(id);
  const indexUrl = pathToFileURL(path.join(RENDERER, 'index.html')).href;

  // ---- 主窗口：复用同一个窗口，靠哈希路由切页（与真实操作路径一致） ----
  // 逐页新建窗口会偶发 ERR_FAILED (-2)：上一个窗口 destroy 后立刻 load 新窗口，渲染进程回收与
  // 导航竞争。复用单窗口 + hashchange 更稳，也更接近用户切页行为。
  const mainWindowPages = PAGES.filter((page) => wanted(page.id));
  if (mainWindowPages.length) {
    const win = createWindow(1440, 900);
    const errors = watchErrors(win);
    await win.loadURL(indexUrl);
    await settle(win, 500);

    for (const page of mainWindowPages) {
      errors.length = 0;
      const target = `#/${page.id}`;
      await win.webContents.executeJavaScript(
        `(function () {
           if (location.hash === '${target}') window.dispatchEvent(new HashChangeEvent('hashchange'));
           else location.hash = '${target}';
         })()`
      );
      await settle(win, 550);
      await capture(win, path.join(OUT_DIR, `${page.id}.png`));
      report.pages.push({ page: page.id, file: `${page.id}.png`, errors: [...errors] });
    }
    win.destroy();
    await sleep(250);
  }

  // ---- 登录窗口 ----
  if (wanted(LOGIN.id)) {
    const win = createWindow(LOGIN.width, LOGIN.height);
    const errors = watchErrors(win);
    await win.loadURL(pathToFileURL(path.join(RENDERER, 'login.html')).href);
    await settle(win);
    await capture(win, path.join(OUT_DIR, `${LOGIN.id}.png`));
    report.pages.push({ page: LOGIN.id, file: `${LOGIN.id}.png`, errors });
    win.destroy();
  }

  const reportName = only ? `capture-report-${only.join('-')}.json` : 'capture-report.json';
  const reportPath = path.join(OUT_DIR, reportName);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  const failed = report.pages.filter((page) => page.errors.length > 0);
  console.log(`\n[workbench:capture] 输出目录：${OUT_DIR}`);
  for (const page of report.pages) {
    console.log(`  - ${page.page}: ${page.errors.length ? `❌ ${page.errors.join(' | ')}` : '✅'}`);
  }
  console.log(`[workbench:capture] report → ${reportPath}`);

  return failed.length ? 1 : 0;
}

// 截图脚本会主动 destroy 窗口；默认「所有窗口关闭即退出」会让进程在写 report 前就结束，
// 导致 report 不更新但退出码仍是 0。这里拦截退出，由 main() 显式 app.exit()。
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    exitCode = await main();
  } catch (error) {
    console.error('[workbench:capture] 失败：', error);
    exitCode = 1;
  } finally {
    app.exit(exitCode);
  }
});
