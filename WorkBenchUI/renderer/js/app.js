'use strict';

/**
 * 应用外壳：标题栏 / 侧边导航 / 哈希路由 / 页面挂载。
 *
 * 页面契约（详见 WorkBenchUI/CONTRACT.md）：
 *   WB.pages.<id> = {
 *     title: '页面标题',
 *     subtitle: '副标题（允许 HTML）',
 *     actions: '<页面右上角操作区 HTML>',
 *     render(ctx) -> HTML 字符串,
 *     mount(root, ctx) -> 可选，绑定交互
 *   }
 */
(function () {
  const WB = window.WB;
  const ui = WB.ui;
  const data = WB.data;

  WB.pages = WB.pages || {};

  const DEFAULT_PAGE = 'dashboard';
  const bodyEl = document.getElementById('page-body');
  const headerEl = document.getElementById('page-header');

  /* ------------------------------ 外壳静态部分 ------------------------------ */
  function renderChrome() {
    const logo = document.getElementById('titlebar-logo');
    if (logo) logo.innerHTML = WB.brandLogo(15);

    const brandLogo = document.getElementById('brand-logo');
    if (brandLogo) brandLogo.innerHTML = WB.brandLogo(19);

    const endpoint = document.getElementById('sidebar-endpoint');
    if (endpoint) endpoint.textContent = data.app.endpoint;

    const version = document.getElementById('sidebar-version');
    if (version) version.textContent = data.app.version;

    const controls = document.querySelectorAll('.window-controls [data-win]');
    const icons = { minimize: 'minus', maximize: 'maximize', close: 'close' };
    controls.forEach((b) => {
      b.innerHTML = WB.icon(icons[b.dataset.win], 14);
    });

    // 侧边导航
    const nav = document.getElementById('nav');
    if (nav) {
      nav.innerHTML = data.nav
        .map(
          (item) =>
            `<a class="nav-item" href="#/${item.id}" data-nav="${item.id}">${WB.icon(item.icon, 18)}<span>${item.label}</span>${
              item.badge ? `<span class="nav-badge">${item.badge}</span>` : ''
            }</a>`
        )
        .join('');
    }

    // 窗口控制
    const bridge = window.workbench;
    document.querySelectorAll('.window-controls [data-win]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.win;
        if (!bridge) return;
        if (action === 'minimize') bridge.minimize();
        if (action === 'toggle-maximize' || action === 'maximize') {
          bridge.toggleMaximize();
          btn.classList.toggle('is-max');
        }
        if (action === 'close') bridge.close();
      });
    });

    // 双击标题栏最大化（按钮本身不触发）
    const titlebar = document.getElementById('titlebar');
    if (titlebar && bridge) {
      titlebar.addEventListener('dblclick', (e) => {
        if (e.target.closest('.window-controls')) return;
        bridge.toggleMaximize();
      });
    }
  }

  /* ------------------------------ 路由 ------------------------------ */
  function currentId() {
    const raw = (location.hash || '').replace(/^#\/?/, '').trim();
    const id = raw.split('?')[0];
    return WB.pages[id] ? id : DEFAULT_PAGE;
  }

  function go(id) {
    if (!WB.pages[id]) return;
    if (currentId() === id && location.hash.endsWith(id)) {
      render();
      return;
    }
    location.hash = `#/${id}`;
  }
  WB.go = go;

  function render() {
    const id = currentId();
    const page = WB.pages[id] || WB.pages[DEFAULT_PAGE];
    if (!page) {
      bodyEl.innerHTML = `<div class="empty"><div class="empty-title">页面未注册</div></div>`;
      return;
    }

    // 导航高亮
    document.querySelectorAll('[data-nav]').forEach((el) => {
      el.classList.toggle('active', el.dataset.nav === id);
    });

    document.title = `AgentWorkBench · ${page.title || '运营控制台'}`;

    // 数据层只有三种状态：loading / live / offline。非 live 时不渲染业务数据，
    // 避免出现「接口没返回但界面像有数据」的假象（无演示兜底）。
    const source = (data.app && data.app.source) || 'loading';
    if (source === 'offline') {
      renderOffline(page);
      return;
    }
    if (source === 'loading') {
      renderLoading(page);
      return;
    }

    headerEl.innerHTML = `<div class="page-heading"><div><h1 class="page-title">${page.title || ''}</h1>${
      page.subtitle ? `<div class="page-subtitle">${page.subtitle}</div>` : ''
    }</div></div>${page.actions ? `<div class="page-actions">${page.actions}</div>` : ''}`;

    const ctx = {
      data,
      ui,
      id,
      go,
      toast: ui.toast,
      version: data.app.version,
    };

    try {
      bodyEl.innerHTML = page.render ? page.render(ctx) || '' : '';
    } catch (err) {
      console.error(`[app] 页面 ${id} 渲染失败`, err);
      bodyEl.innerHTML = `<div class="empty"><div class="empty-icon">${WB.icon('alert', 26)}</div><div class="empty-title">页面渲染失败</div><div class="empty-desc">${
        err && err.message ? ui.esc(err.message) : '未知错误'
      }</div></div>`;
      return;
    }

    bodyEl.scrollTop = 0;
    if (typeof page.mount === 'function') {
      try {
        page.mount(bodyEl, ctx);
      } catch (err) {
        console.error(`[app] 页面 ${id} 交互绑定失败`, err);
      }
    }

    // 页面切换后重放进入动画
    bodyEl.querySelectorAll(':scope > *').forEach((el, i) => {
      el.style.animationDelay = `${Math.min(i * 45, 260)}ms`;
    });
  }

  /* ------------------------------ 全局状态页 ------------------------------ */

  /** 后端不可用：整站显示明确错误 + 重试，不展示任何本地伪造数据。 */
  function renderOffline(page) {
    const reason = (data.app && data.app.error) || '后端服务未响应';
    const endpoint = (data.app && data.app.endpoint) || '127.0.0.1:5301';

    headerEl.innerHTML = `<div class="page-heading"><div><h1 class="page-title">本地服务未连接</h1><div class="page-subtitle">${ui.esc(
      page.title || ''
    )}暂不可用</div></div></div>`;

    bodyEl.innerHTML = `<div class="empty">
      <div class="empty-icon">${WB.icon('alert', 26)}</div>
      <div class="empty-title">无法连接 Wizstar.Api</div>
      <div class="empty-desc">${ui.esc(reason)}</div>
      <div class="empty-desc">请确认本地 API 已启动（默认 <code>http://${ui.esc(endpoint)}</code>），然后点击重试。</div>
      <div style="margin-top:18px">${ui.btn({
        label: '重试连接',
        tone: 'primary',
        icon: 'refresh',
        attrs: 'data-api-retry',
      })}</div>
    </div>`;

    const retry = bodyEl.querySelector('[data-api-retry]');
    if (retry) {
      retry.addEventListener('click', () => {
        retry.disabled = true;
        retry.innerHTML = '<span class="spinner"></span><span>连接中…</span>';
        if (WB.api && typeof WB.api.reload === 'function') {
          WB.api.reload().then(render);
        }
      });
    }
  }

  /** 首次加载中：显示占位，不渲染空表格造成「无数据」误解。 */
  function renderLoading(page) {
    headerEl.innerHTML = `<div class="page-heading"><div><h1 class="page-title">${page.title || ''}</h1></div></div>`;
    bodyEl.innerHTML = `<div class="empty">
      <div class="empty-icon"><span class="spinner"></span></div>
      <div class="empty-title">正在加载真实数据…</div>
      <div class="empty-desc">从本地 API 读取 Agent 名册、MCP 服务与业务数据。</div>
    </div>`;
  }

  /* ------------------------------ 全局委托 ------------------------------ */
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      e.preventDefault();
      go(nav.dataset.nav);
      return;
    }

    const goto = e.target.closest('[data-go]');
    if (goto) {
      e.preventDefault();
      go(goto.dataset.go);
      return;
    }

    const toastBtn = e.target.closest('[data-toast]');
    if (toastBtn) {
      e.preventDefault();
      ui.toast(toastBtn.dataset.toast, toastBtn.dataset.toastTone || 'info');
      return;
    }

    const logout = e.target.closest('[data-logout]');
    if (logout) {
      e.preventDefault();
      if (window.workbench) window.workbench.logout();
      return;
    }
  });

  window.addEventListener('hashchange', render);

  /* ------------------------------ 启动 ------------------------------ */
  function boot() {
    renderChrome();
    if (!location.hash) location.hash = `#/${DEFAULT_PAGE}`;
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
