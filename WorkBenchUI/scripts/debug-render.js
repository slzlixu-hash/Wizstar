'use strict';

/** 临时诊断脚本：加载 index.html 并打印全局状态与脚本错误。 */

const { app, BrowserWindow } = require('electron');
const os = require('node:os');
const path = require('node:path');

app.setPath('userData', path.join(os.tmpdir(), `workbench-debug-${process.pid}`));

const ROOT = path.resolve(__dirname, '..');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { preload: path.join(ROOT, 'electron', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.on('console-message', (e) => {
    console.log('[console]', JSON.stringify({ level: e.level, message: e.message, source: e.sourceId, line: e.lineNumber }));
  });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'), { hash: '#/products' });
  await new Promise((r) => setTimeout(r, 600));
  const info = await win.webContents.executeJavaScript(`(() => {
    const WB = window.WB || {};
    return {
      wbKeys: Object.keys(WB),
      uiKeys: WB.ui ? Object.keys(WB.ui).slice(0, 40) : null,
      brandLogo: typeof WB.brandLogo,
      searchBox: WB.ui ? typeof WB.ui.searchBox : 'no-ui',
      appKeys: WB.app ? Object.keys(WB.app) : null,
      pages: WB.pages ? Object.keys(WB.pages) : null,
      navHtmlLen: (document.getElementById('nav') || {}).innerHTML?.length ?? -1,
      bodyHtmlLen: (document.getElementById('page-body') || {}).innerHTML?.length ?? -1,
      headerHtmlLen: (document.getElementById('page-header') || {}).innerHTML?.length ?? -1,
      scripts: Array.from(document.scripts).map((s) => s.src.split('/').pop()),
    };
  })()`);
  console.log(JSON.stringify(info, null, 2));
  app.exit(0);
});
