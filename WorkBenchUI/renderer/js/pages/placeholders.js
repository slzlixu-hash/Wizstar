'use strict';

/**
 * 占位页面：商品管理 / 订单履约 / 店铺管理。
 * 参考稿未给出这三页的设计，这里按同一套设计语言做「真实感占位」：
 * 统计卡 + 筛选条 + 数据表，交互仅在前端过滤，不接任何接口。
 */
(function () {
  const WB = window.WB;
  const ui = WB.ui;
  const pages = (WB.pages = WB.pages || {});

  function statRow(stats) {
    return `<div class="grid grid-4">${stats
      .map((s) => ui.statTile({ label: s.label, value: s.value, unit: s.unit, meta: s.meta }))
      .join('')}</div>`;
  }

  function pageActions(cfg) {
    return `${ui.searchBox({ placeholder: cfg.searchPlaceholder, width: '240px', attrs: 'data-ph-search' })}
      ${ui.btn({ label: '筛选', tone: 'ghost', icon: 'filter' })}
      ${ui.btn({ label: cfg.addLabel, tone: 'primary', icon: 'plus', attrs: 'data-ph-add' })}`;
  }

  function buildPage(cfg) {
    return {
      title: cfg.title,
      subtitle: cfg.subtitle,
      actions: pageActions(cfg),
      render(ctx) {
        const rows = ctx.data[cfg.key].rows;
        return `<div class="stack">
          ${statRow(ctx.data[cfg.key].stats)}
          <section class="card card--flush">
            <div class="ph-toolbar">
              <div class="segmented" data-ph-filter>
                ${cfg.filters
                  .map((f, i) => `<button type="button" class="${i === 0 ? 'active' : ''}" data-filter="${f.id}">${f.label}</button>`)
                  .join('')}
              </div>
              <div class="row gap-10">
                <span class="tiny dim">共 <b class="num" data-ph-count>${rows.length}</b> 条</span>
                ${ui.btn({ label: '导出', tone: 'ghost', size: 'xs', icon: 'download' })}
                ${ui.btn({ label: '刷新', tone: 'ghost', size: 'xs', icon: 'refresh', attrs: 'data-toast="已刷新演示数据（未连接接口）"' })}
              </div>
            </div>
            <div data-ph-table>${cfg.table(rows, ctx)}</div>
          </section>
        </div>`;
      },
      mount(root, ctx) {
        const tableHost = root.querySelector('[data-ph-table]');
        const countEl = root.querySelector('[data-ph-count]');
        const search = document.querySelector('[data-ph-search]');
        let activeFilter = 'all';
        let keyword = '';

        function apply() {
          const all = ctx.data[cfg.key].rows;
          const rows = all.filter((r) => {
            const passFilter = activeFilter === 'all' || cfg.filters.find((f) => f.id === activeFilter).test(r);
            const passSearch =
              !keyword ||
              JSON.stringify(r).toLowerCase().includes(keyword) ||
              String(r.id).toLowerCase().includes(keyword);
            return passFilter && passSearch;
          });
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

        const addBtn = document.querySelector('[data-ph-add]');
        if (addBtn) {
          addBtn.addEventListener('click', () => {
            ui.toast(`「${cfg.addLabel}」为界面占位，功能待接入业务接口`, 'info');
          });
        }
      },
    };
  }

  /* ------------------------------ 商品管理 ------------------------------ */
  pages.products = buildPage({
    key: 'products',
    title: '商品管理',
    subtitle: '全渠道商品库 · 价格 / 库存 / 上架状态（界面演示数据）',
    searchPlaceholder: '搜索商品名称或 SKU',
    addLabel: '新增商品',
    filters: [
      { id: 'all', label: '全部', test: () => true },
      { id: 'on', label: '在售', test: (r) => r.status === '在售' },
      { id: 'audit', label: '待审核', test: (r) => r.status === '待审核' },
      { id: 'warn', label: '缺货预警', test: (r) => r.status === '缺货' },
    ],
    table(rows) {
      return ui.table({
        columns: [
          { label: 'SKU', width: '130px', render: (r) => `<span class="cell-id">${ui.esc(r.id)}</span>` },
          {
            label: '商品名称',
            render: (r) => `<div class="ph-product"><span class="ph-thumb">${ui.icon('box', 16)}</span><span>${ui.esc(r.name)}</span></div>`,
          },
          { label: '售价', width: '110px', render: (r) => `<span class="num">${ui.esc(r.price)}</span>` },
          {
            label: '库存',
            width: '110px',
            render: (r) =>
              `<span class="num ${r.stock === 0 ? 'text-rose' : r.stock < 100 ? 'text-amber' : ''}">${ui.num(r.stock)}</span>`,
          },
          { label: '主渠道', width: '130px', render: (r) => ui.chip(r.channel, { icon: 'shop' }) },
          { label: '状态', width: '110px', render: (r) => ui.badge(r.status, { tone: r.tone, dot: true }) },
          {
            label: '操作',
            width: '120px',
            align: 'right',
            render: () =>
              `<span class="row gap-6" style="justify-content:flex-end">${ui.btn({
                label: '编辑',
                tone: 'link',
                size: 'xs',
                attrs: 'data-toast="编辑商品为界面占位"',
              })}</span>`,
          },
        ],
        rows,
        empty: `<div class="empty"><div class="empty-icon">${ui.icon('box', 26)}</div><div class="empty-title">没有匹配的商品</div><div class="empty-desc">换个关键词或筛选条件试试。</div></div>`,
      });
    },
  });

  /* ------------------------------ 订单履约 ------------------------------ */
  pages.orders = buildPage({
    key: 'orders',
    title: '订单履约',
    subtitle: '今日订单与代发进度 · 售后工单（界面演示数据）',
    searchPlaceholder: '搜索订单号或店铺',
    addLabel: '手动补单',
    filters: [
      { id: 'all', label: '全部', test: () => true },
      { id: 'sent', label: '已代发', test: (r) => r.status === '已代发' },
      { id: 'pending', label: '待发货', test: (r) => r.status === '待发货' },
      { id: 'after', label: '售后', test: (r) => r.status.includes('售后') || r.status === '已签收' },
    ],
    table(rows) {
      return ui.table({
        columns: [
          { label: '订单号', width: '190px', render: (r) => `<span class="cell-id">${ui.esc(r.id)}</span>` },
          { label: '店铺', width: '170px', render: (r) => `<span class="row gap-6">${ui.icon('shop', 14)}${ui.esc(r.shop)}</span>` },
          { label: '商品', render: (r) => `<span class="muted">${ui.esc(r.items)}</span>` },
          { label: '金额', width: '110px', render: (r) => `<span class="num">${ui.esc(r.amount)}</span>` },
          { label: '状态', width: '130px', render: (r) => ui.badge(r.status, { tone: r.tone, dot: true }) },
          { label: '预计 / 完成', width: '140px', render: (r) => `<span class="tiny dim">${ui.esc(r.eta)}</span>` },
        ],
        rows,
        empty: `<div class="empty"><div class="empty-icon">${ui.icon('clipboard', 26)}</div><div class="empty-title">没有匹配的订单</div><div class="empty-desc">换个订单号或状态筛选试试。</div></div>`,
      });
    },
  });

  /* ------------------------------ 店铺管理 ------------------------------ */
  pages.shops = buildPage({
    key: 'shops',
    title: '店铺管理',
    subtitle: '多平台店铺授权与今日经营概览（界面演示数据）',
    searchPlaceholder: '搜索店铺名称或平台',
    addLabel: '绑定店铺',
    filters: [
      { id: 'all', label: '全部', test: () => true },
      { id: 'ok', label: '授权正常', test: (r) => r.auth === '授权正常' },
    ],
    table(rows) {
      return ui.table({
        columns: [
          { label: '店铺', render: (r) => `<div class="ph-product"><span class="ph-thumb">${ui.icon('shop', 16)}</span><div><div>${ui.esc(r.name)}</div><div class="tiny dim">${ui.esc(r.id)}</div></div></div>` },
          { label: '平台', width: '130px', render: (r) => ui.chip(r.platform, { icon: 'globe' }) },
          { label: '授权状态', width: '130px', render: (r) => ui.badge(r.auth, { tone: r.tone, dot: true }) },
          { label: '到期日', width: '120px', render: (r) => `<span class="tiny dim">${ui.esc(r.expire)}</span>` },
          { label: '今日 GMV', width: '120px', render: (r) => `<span class="num">${ui.esc(r.gmv)}</span>` },
          {
            label: '操作',
            width: '150px',
            align: 'right',
            render: () => `<span class="row gap-10" style="justify-content:flex-end">${ui.btn({ label: '重新授权', tone: 'link', size: 'xs', attrs: 'data-toast="授权流程为界面占位"' })}${ui.btn({ label: '设置', tone: 'link', size: 'xs', attrs: 'data-toast="店铺设置为界面占位"' })}</span>`,
          },
        ],
        rows,
        empty: `<div class="empty"><div class="empty-icon">${ui.icon('shop', 26)}</div><div class="empty-title">没有匹配的店铺</div><div class="empty-desc">换个关键词试试。</div></div>`,
      });
    },
  });
})();
