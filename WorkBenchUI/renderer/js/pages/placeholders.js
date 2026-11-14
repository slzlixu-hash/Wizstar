'use strict';

/**
 * 商品管理 / 订单履约 / 店铺管理。
 *
 * 数据全部来自真实业务表（由 api-client.js 预取填充）：
 *   products ← GET /api/business/products（sku_project + sku_variant + sku_channel_listing）
 *   orders   ← GET /api/business/orders（ecom_order + ecom_order_item + store_instance）
 *   shops    ← GET /api/business/shops（store_instance + ecom_order 今日 GMV）
 *
 * 可用交互（全部真实）：搜索 / 状态筛选（前端过滤已加载的真实数据）、刷新（重新请求）、
 * 导出 CSV（浏览器端生成）。表为空时渲染真实空态，不填充任何示例行。
 */
(function () {
  const WB = window.WB;
  const ui = WB.ui;
  const pages = (WB.pages = WB.pages || {});

  function statRow(stats) {
    const list = Array.isArray(stats) ? stats : [];
    if (!list.length) return '';
    return `<div class="grid grid-4">${list
      .map((s) => ui.statTile({ label: s.label, value: s.value, unit: s.unit, meta: s.meta }))
      .join('')}</div>`;
  }

  function pageActions(cfg) {
    return `${ui.searchBox({ placeholder: cfg.searchPlaceholder, width: '240px', attrs: 'data-ph-search' })}
      ${ui.btn({ label: '刷新', tone: 'ghost', icon: 'refresh', attrs: 'data-ph-refresh' })}`;
  }

  /** 前端 CSV 导出：把当前筛选后的真实行导出为文件。 */
  function exportCsv(cfg, rows) {
    const cols = cfg.csvColumns;
    const escape = (v) => {
      const s = v === undefined || v === null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.map((c) => escape(c.label)).join(',')];
    rows.forEach((r) => lines.push(cols.map((c) => escape(c.value(r))).join(',')));

    // BOM 让 Excel 正确识别 UTF-8 中文
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = cfg.fileName + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function buildPage(cfg) {
    return {
      title: cfg.title,
      subtitle: cfg.subtitle,
      actions: pageActions(cfg),
      render(ctx) {
        const store = ctx.data[cfg.key] || { stats: [], rows: [] };
        const rows = store.rows || [];
        return `<div class="stack">
          ${statRow(store.stats)}
          <section class="card card--flush">
            <div class="ph-toolbar">
              <div class="segmented" data-ph-filter>
                ${cfg.filters
                  .map((f, i) => `<button type="button" class="${i === 0 ? 'active' : ''}" data-filter="${f.id}">${f.label}</button>`)
                  .join('')}
              </div>
              <div class="row gap-10">
                <span class="tiny dim">共 <b class="num" data-ph-count>${rows.length}</b> 条</span>
                ${ui.btn({ label: '导出 CSV', tone: 'ghost', size: 'xs', icon: 'download', attrs: 'data-ph-export' })}
              </div>
            </div>
            <div data-ph-table>${cfg.table(rows, ctx)}</div>
          </section>
        </div>`;
      },
      mount(root, ctx) {
        const tableHost = root.querySelector('[data-ph-table]');
        const countEl = root.querySelector('[data-ph-count]');
        const search = root.querySelector('[data-ph-search]') || document.querySelector('[data-ph-search]');
        let activeFilter = 'all';
        let keyword = '';

        function current() {
          const store = ctx.data[cfg.key] || { rows: [] };
          const all = store.rows || [];
          const active = cfg.filters.find((f) => f.id === activeFilter) || cfg.filters[0];
          return all.filter((r) => {
            const passFilter = activeFilter === 'all' || active.test(r);
            const passSearch =
              !keyword ||
              JSON.stringify(r).toLowerCase().includes(keyword) ||
              String(r.id).toLowerCase().includes(keyword);
            return passFilter && passSearch;
          });
        }

        function apply() {
          const rows = current();
          tableHost.innerHTML = cfg.table(rows, ctx);
          if (countEl) countEl.textContent = rows.length;
        }

        ui.bind(root.querySelector('[data-ph-filter]') || root, 'button', 'click', (e) => {
          const btn = e.target.closest('[data-filter]');
          if (!btn) return;
          root.querySelectorAll('[data-ph-filter] button').forEach((b) => b.classList.toggle('active', b === btn));
          activeFilter = btn.dataset.filter;
          apply();
        });

        if (search) {
          search.addEventListener('input', () => {
            keyword = search.value.trim().toLowerCase();
            apply();
          });
        }

        /* 导出：当前筛选结果 */
        const exportBtn = root.querySelector('[data-ph-export]');
        if (exportBtn) {
          exportBtn.addEventListener('click', () => {
            const rows = current();
            if (!rows.length) {
              ctx.toast('当前没有可导出的数据', 'info');
              return;
            }
            exportCsv(cfg, rows);
            ctx.toast(`已导出 ${rows.length} 条记录`, 'success');
          });
        }

        /* 刷新：重新请求该业务端点 */
        const refreshBtn = root.querySelector('[data-ph-refresh]');
        if (refreshBtn) {
          refreshBtn.addEventListener('click', async () => {
            if (refreshBtn.disabled) return;
            const original = refreshBtn.innerHTML;
            refreshBtn.disabled = true;
            refreshBtn.innerHTML = '<span class="spinner"></span><span>刷新中…</span>';

            const res = await WB.api.refreshBusiness(cfg.endpoint);
            refreshBtn.disabled = false;
            refreshBtn.innerHTML = original;

            if (!res.ok) {
              ctx.toast('刷新失败：' + (res.error || '服务未连接'), 'warn');
              return;
            }
            apply();
            ctx.toast('已从业务表重新加载', 'success');
          });
        }
      },
    };
  }

  /* ------------------------------ 商品管理 ------------------------------ */
  pages.products = buildPage({
    key: 'products',
    endpoint: 'products',
    fileName: 'products',
    title: '商品管理',
    subtitle: '全渠道商品库 · 数据来自 sku_project / sku_variant / sku_channel_listing',
    searchPlaceholder: '搜索商品名称或 SKU',
    filters: [
      { id: 'all', label: '全部', test: () => true },
      { id: 'on', label: '在售', test: (r) => r.rawStatus === 'published' },
      { id: 'audit', label: '待审核', test: (r) => r.rawStatus === 'pending_review' },
      { id: 'warn', label: '缺货预警', test: (r) => Number(r.stock) <= 0 },
    ],
    csvColumns: [
      { label: 'SKU', value: (r) => r.id },
      { label: '商品名称', value: (r) => r.name },
      { label: '售价', value: (r) => r.price },
      { label: '库存', value: (r) => r.stock },
      { label: '主渠道', value: (r) => r.channel },
      { label: '状态', value: (r) => r.status },
      { label: '毛利率', value: (r) => r.marginRate },
    ],
    table(rows) {
      return ui.table({
        columns: [
          { label: 'SKU', width: '150px', render: (r) => `<span class="cell-id">${ui.esc(r.id)}</span>` },
          {
            label: '商品名称',
            render: (r) =>
              `<div class="ph-product"><span class="ph-thumb">${ui.icon('box', 16)}</span><span title="${ui.esc(
                r.name
              )}">${ui.esc(r.name)}</span></div>`,
          },
          { label: '售价', width: '110px', render: (r) => `<span class="num">${ui.esc(r.price)}</span>` },
          {
            label: '库存',
            width: '100px',
            render: (r) =>
              `<span class="num ${Number(r.stock) === 0 ? 'text-rose' : Number(r.stock) < 100 ? 'text-amber' : ''}">${ui.num(
                r.stock
              )}</span>`,
          },
          { label: '主渠道', width: '130px', render: (r) => ui.chip(r.channel, { icon: 'shop' }) },
          { label: '状态', width: '110px', render: (r) => ui.badge(r.status, { tone: r.tone, dot: true }) },
        ],
        rows,
        empty: `<div class="empty"><div class="empty-icon">${ui.icon('box', 26)}</div><div class="empty-title">商品库暂无数据</div><div class="empty-desc">业务表 <code>sku_project</code> 当前为空；选品流程写入后会自动出现在这里。</div></div>`,
      });
    },
  });

  /* ------------------------------ 订单履约 ------------------------------ */
  pages.orders = buildPage({
    key: 'orders',
    endpoint: 'orders',
    fileName: 'orders',
    title: '订单履约',
    subtitle: '全渠道订单与代发进度 · 数据来自 ecom_order / ecom_order_item',
    searchPlaceholder: '搜索订单号或店铺',
    filters: [
      { id: 'all', label: '全部', test: () => true },
      { id: 'sent', label: '已发货', test: (r) => r.rawStatus === 'shipped' },
      {
        id: 'pending',
        label: '待发货',
        test: (r) => r.rawStatus === 'pending_purchase' || r.rawStatus === 'purchasing' || r.rawStatus === 'awaiting_tracking',
      },
      { id: 'after', label: '售后', test: (r) => r.aftersale },
    ],
    csvColumns: [
      { label: '订单号', value: (r) => r.id },
      { label: '店铺', value: (r) => r.shop },
      { label: '商品', value: (r) => r.items },
      { label: '金额', value: (r) => r.amount },
      { label: '状态', value: (r) => r.status },
      { label: '时间', value: (r) => r.eta },
    ],
    table(rows) {
      return ui.table({
        columns: [
          { label: '订单号', width: '200px', render: (r) => `<span class="cell-id">${ui.esc(r.id)}</span>` },
          { label: '店铺', width: '160px', render: (r) => `<span class="row gap-6">${ui.icon('shop', 14)}${ui.esc(r.shop)}</span>` },
          { label: '商品', render: (r) => `<span class="muted" title="${ui.esc(r.items)}">${ui.esc(r.items)}</span>` },
          { label: '金额', width: '110px', render: (r) => `<span class="num">${ui.esc(r.amount)}</span>` },
          { label: '状态', width: '120px', render: (r) => ui.badge(r.status, { tone: r.tone, dot: true }) },
          { label: '付款 / 创建', width: '110px', render: (r) => `<span class="tiny dim">${ui.esc(r.eta)}</span>` },
        ],
        rows,
        empty: `<div class="empty"><div class="empty-icon">${ui.icon('clipboard', 26)}</div><div class="empty-title">订单表暂无数据</div><div class="empty-desc">业务表 <code>ecom_order</code> 当前为空；平台订单同步后会出现在这里。</div></div>`,
      });
    },
  });

  /* ------------------------------ 店铺管理 ------------------------------ */
  pages.shops = buildPage({
    key: 'shops',
    endpoint: 'shops',
    fileName: 'shops',
    title: '店铺管理',
    subtitle: '多平台店铺授权与今日经营概览 · 数据来自 store_instance',
    searchPlaceholder: '搜索店铺名称或平台',
    filters: [
      { id: 'all', label: '全部', test: () => true },
      { id: 'ok', label: '授权正常', test: (r) => r.rawAuth === 'valid' },
      { id: 'warn', label: '临期 / 过期', test: (r) => r.rawAuth === 'expiring' || r.rawAuth === 'expired' },
    ],
    csvColumns: [
      { label: '店铺ID', value: (r) => r.id },
      { label: '店铺名称', value: (r) => r.name },
      { label: '平台', value: (r) => r.platform },
      { label: '授权状态', value: (r) => r.auth },
      { label: '今日GMV', value: (r) => r.gmv },
    ],
    table(rows) {
      return ui.table({
        columns: [
          {
            label: '店铺',
            render: (r) =>
              `<div class="ph-product"><span class="ph-thumb">${ui.icon('shop', 16)}</span><div><div>${ui.esc(
                r.name
              )}</div><div class="tiny dim">${ui.esc(r.id)}</div></div></div>`,
          },
          { label: '平台', width: '130px', render: (r) => ui.chip(r.platform, { icon: 'globe' }) },
          { label: '授权状态', width: '130px', render: (r) => ui.badge(r.auth, { tone: r.tone, dot: true }) },
          { label: '最近同步', width: '120px', render: (r) => `<span class="tiny dim">${ui.esc(r.expire)}</span>` },
          { label: '今日 GMV', width: '120px', render: (r) => `<span class="num">${ui.esc(r.gmv)}</span>` },
          { label: '日刊登上限', width: '110px', render: (r) => `<span class="num">${ui.num(r.listingLimit)}</span>` },
        ],
        rows,
        empty: `<div class="empty"><div class="empty-icon">${ui.icon('shop', 26)}</div><div class="empty-title">暂无绑定店铺</div><div class="empty-desc">业务表 <code>store_instance</code> 当前为空；完成开放平台授权后会出现在这里。</div></div>`,
      });
    },
  });
})();
