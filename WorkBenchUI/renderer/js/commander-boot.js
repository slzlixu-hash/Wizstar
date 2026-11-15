'use strict';

/**
 * 指挥官管理界面的独立页引导（commander.html）。
 *
 * 该页面在独立 Electron 窗口中铺满整个界面，不套主壳的侧边栏/页头；
 * 依赖 WB.commanderPage（pages/commander.js）渲染，数据仍走主进程 API 桥。
 */
(function () {
  const WB = window.WB;
  const bridge = window.workbench || null;
  const root = document.getElementById('commander-root');
  if (!root || !WB || !WB.commanderPage || !WB.ui) return;

  // 独立窗口导航钩子：返回=关闭窗口（主窗口会被主进程重新显示）
  WB.commanderBack = function () {
    if (bridge && typeof bridge.close === 'function') bridge.close();
  };

  const ctx = { data: WB.data, toast: WB.ui.toast };
  try {
    root.innerHTML = WB.commanderPage.render(ctx);
    WB.commanderPage.mount(root, ctx);
    document.title = 'AgentWorkBench · 指挥官管理界面';
  } catch (error) {
    root.innerHTML = `<div class="empty"><div class="empty-icon">${WB.ui.icon('alert', 26)}</div>
      <div class="empty-title">指挥官界面渲染失败</div>
      <div class="empty-desc">${WB.ui.esc(error && error.message ? error.message : '未知错误')}</div></div>`;
  }
})();
