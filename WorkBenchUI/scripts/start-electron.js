'use strict';

/**
 * 启动 Electron 的辅助脚本（不依赖 npx / 全局安装）。
 *
 * 用法：
 *   node scripts/start-electron.js                # 启动登录窗口
 *   node scripts/start-electron.js --capture      # 无头截图（artifacts/*.png）
 *   node scripts/start-electron.js --capture --only dashboard
 *
 * 查找顺序：
 *   1. 环境变量 ELECTRON_BINARY 指定的可执行文件
 *   2. 本仓库 node_modules/electron/dist/electron(.exe)
 *   3. 旧项目 D:\WorkCode\AgentWorkBench\frontend\node_modules\electron\dist（本机兜底）
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function candidateBinaries() {
  const names = process.platform === 'win32' ? ['electron.exe'] : ['Electron', 'electron'];
  const roots = [
    path.join(ROOT, 'node_modules', 'electron', 'dist'),
    'D:\\WorkCode\\AgentWorkBench\\frontend\\node_modules\\electron\\dist',
  ];
  const list = [];
  if (process.env.ELECTRON_BINARY) list.push(process.env.ELECTRON_BINARY);
  for (const root of roots) {
    for (const name of names) list.push(path.join(root, name));
  }
  return list;
}

function resolveElectron() {
  for (const candidate of candidateBinaries()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  console.error(
    '[workbench] 未找到 Electron 可执行文件。请先执行 npm install，或设置 ELECTRON_BINARY 环境变量。'
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
const capture = argv.includes('--capture');
const passthrough = argv.filter((arg) => arg !== '--capture');
const electron = resolveElectron();
const target = capture ? path.join(ROOT, 'scripts', 'capture.js') : ROOT;

const args = [target, ...passthrough];
console.log(`[workbench] ${capture ? 'capture' : 'start'} → ${electron} ${args.join(' ')}`);

// 注意：某些终端环境会导出 ELECTRON_RUN_AS_NODE=1，此时 electron.exe 退化成纯 Node，
// require('electron') 只返回 npm 包路径，app/BrowserWindow 全部为 undefined。
// GUI 与截图都必须以真实 Electron 运行，因此这里显式移除该变量。
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, args, {
  cwd: ROOT,
  stdio: 'inherit',
  env: childEnv,
});

child.on('error', (error) => {
  console.error('[workbench] 启动 Electron 失败：', error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) console.error(`[workbench] Electron 被信号终止：${signal}`);
  process.exit(code ?? 0);
});
