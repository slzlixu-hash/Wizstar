'use strict';

/**
 * 通用 UI 组件（纯字符串模板 + 少量 DOM 增强）。
 * 页面通过 WB.ui.* 生成 HTML，再挂到 #page-body 中；交互在各自的 mount() 里绑定。
 */
(function () {
  const WB = (window.WB = window.WB || {});

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/[&<>"']/g, (m) => ESC_MAP[m]);
  }

  function num(v) {
    return typeof v === 'number' ? v.toLocaleString('en-US') : v;
  }

  function icon(name, size = 18, cls = '') {
    return WB.icon ? WB.icon(name, size, cls) : '';
  }

  /* ------------------------------ 基础原子 ------------------------------ */
  function badge(text, opts = {}) {
    const tone = opts.tone ? ` badge-${opts.tone}` : '';
    const dot = opts.dot ? '<i class="dot"></i>' : '';
    return `<span class="badge${tone}${opts.cls ? ' ' + opts.cls : ''}">${dot}${esc(text)}</span>`;
  }

  function chip(text, opts = {}) {
    const glyph = opts.icon ? icon(opts.icon, 13) : '';
    return `<span class="chip${opts.tone ? ' chip--' + opts.tone : ''}">${glyph}${esc(text)}</span>`;
  }

  function tag(text) {
    return `<span class="tag">${esc(text)}</span>`;
  }

  function statusDot(kind, label) {
    const text = label ? `<span>${esc(label)}</span>` : '';
    return `<span class="row gap-6" style="align-items:center"><i class="status-dot ${esc(kind)}"></i>${text}</span>`;
  }

  function avatar(entity, size = 'md') {
    const a = entity || {};
    const src = a.avatar ? esc(a.avatar) : `assets/avatars/${esc(a.id || 'user')}.svg`;
    const initial = a.initial || (a.name ? String(a.name).slice(0, 1) : '?');
    const s = `avatar avatar--${size}`;
    if (a.photo === false || !a.id) {
      return `<span class="${s}" style="font-size:${size === 'xl' ? 20 : 13}px;font-weight:700;color:#cfe0f5">${esc(initial)}</span>`;
    }
    // 图片加载失败时回落到首字，不留破图
    return `<span class="${s}"><img src="${src}" alt="${esc(a.name || '')}" draggable="false"
      onerror="this.style.display='none';var f=this.parentElement&&this.parentElement.querySelector('.avatar__fallback');if(f)f.hidden=false;" />
      <span class="avatar__fallback" hidden style="font-size:${size === 'xl' ? 20 : 13}px;font-weight:700;color:#cfe0f5">${esc(initial)}</span></span>`;
  }

  /* ------------------------------ 按钮 / 输入 ------------------------------ */
  /**
   * btn({ label, icon, tone: 'primary|gradient|ghost|outline|danger|link|', size:'sm|xs|lg|icon', attrs, id, cls, block, caret })
   */
  function btn(o = {}) {
    const classes = ['btn'];
    if (o.tone) classes.push(`btn-${o.tone}`);
    if (o.size) classes.push(`btn-${o.size}`);
    if (o.block) classes.push('btn-block');
    if (o.cls) classes.push(o.cls);
    const glyph = o.icon ? icon(o.icon, 16) : '';
    const label = o.label ? `<span>${esc(o.label)}</span>` : '';
    const caret = o.caret ? `<span class="caret">${icon('chevron-down', 14)}</span>` : '';
    const attrs = o.attrs || '';
    return `<button type="button" class="${classes.join(' ')}"${o.id ? ` id="${esc(o.id)}"` : ''} ${attrs}>${glyph}${label}${caret}</button>`;
  }

  function iconBtn(name, opts = {}) {
    return `<button type="button" class="icon-btn" ${opts.attrs || ''} title="${esc(opts.title || '')}">${icon(name, opts.size || 17)}${
      opts.dot ? '<i class="dot-badge"></i>' : ''
    }</button>`;
  }

  function input(o = {}) {
    return `<input class="input" type="${esc(o.type || 'text')}" placeholder="${esc(o.placeholder || '')}" ${
      o.value !== undefined ? `value="${esc(o.value)}"` : ''
    } ${o.attrs || ''} />`;
  }

  function select(o = {}) {
    const opts = (o.options || [])
      .map((it) => {
        const val = typeof it === 'string' ? it : it.value;
        const label = typeof it === 'string' ? it : it.label;
        return `<option value="${esc(val)}"${val === o.value ? ' selected' : ''}>${esc(label)}</option>`;
      })
      .join('');
    return `<span class="select-wrap"><select class="select" ${o.attrs || ''}>${opts}</select>${icon('chevron-down', 14)}</span>`;
  }

  function searchBox(o = {}) {
    return `<label class="search-box" style="${o.width ? `width:${o.width}` : ''}">${icon('search', 15)}<input class="input" type="search" placeholder="${esc(
      o.placeholder || '搜索'
    )}" ${o.attrs || ''} /></label>`;
  }

  function switchControl(o = {}) {
    return `<label class="switch"><input type="checkbox"${o.checked ? ' checked' : ''} ${o.attrs || ''}><span class="track"></span>${
      o.label ? `<span>${esc(o.label)}</span>` : ''
    }</label>`;
  }

  function checkbox(o = {}) {
    return `<label class="checkbox"><input type="checkbox"${o.checked ? ' checked' : ''} ${o.attrs || ''}><span class="box">${icon(
      'check',
      11
    )}</span>${o.label ? `<span>${esc(o.label)}</span>` : ''}</label>`;
  }

  /* ------------------------------ 卡片 / 区块 ------------------------------ */
  function card(o = {}) {
    const head =
      o.title || o.actions
        ? `<div class="card-head"><div><div class="card-title">${o.title || ''}</div>${
            o.sub ? `<div class="card-sub">${o.sub}</div>` : ''
          }</div>${o.actions ? `<div class="card-actions">${o.actions}</div>` : ''}</div>`
        : '';
    return `<section class="card${o.cls ? ' ' + o.cls : ''}"${o.id ? ` id="${esc(o.id)}"` : ''}>${head}${o.body || ''}</section>`;
  }

  function statTile(o = {}) {
    return `<section class="card stat-tile${o.warn ? ' stat-tile--warn' : ''}">
      <div class="stat-label">${o.icon ? icon(o.icon, 15) : ''}<span>${esc(o.label)}</span>${
      o.warn ? `<span class="stat-warn-ico">${icon('alert', 15)}</span>` : ''
    }</div>
      <div class="stat-value">${o.prefix ? `<span class="stat-prefix">${esc(o.prefix)}</span>` : ''}<span>${esc(o.value)}</span>${
      o.unit ? `<span class="unit">${esc(o.unit)}</span>` : ''
    }${o.delta ? `<span class="delta ${o.deltaTone || 'up'}">${esc(o.delta)}</span>` : ''}</div>
      ${o.meta ? `<div class="stat-meta">${o.meta}</div>` : ''}
    </section>`;
  }

  /** 键值行；pairs = [[label, valueHtml], ...] */
  function kv(pairs, opts = {}) {
    const rows = pairs
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
      .join('');
    return `<dl class="kv${opts.cls ? ' ' + opts.cls : ''}">${rows}</dl>`;
  }

  /* ------------------------------ 表格 ------------------------------ */
  /**
   * table({ columns: [{label, key, cls, align, render(row)}], rows, rowAttrs(row), empty })
   */
  function table(o = {}) {
    const cols = o.columns || [];
    const head = cols
      .map(
        (c) =>
          `<th${c.width ? ` style="width:${c.width}"` : ''}${c.align ? ` style="text-align:${c.align}"` : ''}${
            c.cls ? ` class="${c.cls}"` : ''
          }>${esc(c.label)}</th>`
      )
      .join('');
    const body = (o.rows || [])
      .map((r, i) => {
        const tds = cols
          .map((c) => {
            const v = c.render ? c.render(r, i) : esc(r[c.key]);
            return `<td${c.align ? ` style="text-align:${c.align}"` : ''}${c.cls ? ` class="${c.cls}"` : ''}>${v ?? ''}</td>`;
          })
          .join('');
        return `<tr${o.rowAttrs ? ' ' + o.rowAttrs(r, i) : ''}>${tds}</tr>`;
      })
      .join('');
    if (!body && o.empty) return o.empty;
    return `<div class="table-wrap"><table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  /* ------------------------------ 标签页 ------------------------------ */
  /** tabs(items:[{id,label,icon}], activeId, attr='data-view') */
  function tabs(items, activeId, attr = 'data-tab') {
    return `<div class="tabs">${items
      .map(
        (it) =>
          `<button type="button" class="tab${it.id === activeId ? ' active' : ''}" ${attr}="${esc(it.id)}">${
            it.icon ? icon(it.icon, 15) : ''
          }${esc(it.label)}</button>`
      )
      .join('')}</div>`;
  }

  function segmented(items, activeId, attr = 'data-seg') {
    return `<div class="segmented">${items
      .map((it) => `<button type="button" class="${it.id === activeId ? 'active' : ''}" ${attr}="${esc(it.id)}">${esc(it.label)}</button>`)
      .join('')}</div>`;
  }

  /* ------------------------------ Toast ------------------------------ */
  const TOAST_ICON = { success: 'check', info: 'info', warn: 'alert', error: 'alert' };
  function toast(message, tone = 'info', timeout = 2600) {
    let layer = document.querySelector('.toast-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'toast-layer';
      document.body.appendChild(layer);
    }
    const el = document.createElement('div');
    el.className = `toast ${tone}`;
    el.innerHTML = `<span class="toast-icon">${icon(TOAST_ICON[tone] || 'info', 14)}</span><span>${esc(message)}</span>`;
    layer.appendChild(el);
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 260);
    }, timeout);
    return el;
  }

  /* ------------------------------ 弹窗 ------------------------------ */
  function modal(o = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">${o.title || ''}</div>
      ${o.desc ? `<div class="modal-desc">${o.desc}</div>` : ''}
      ${o.body ? `<div class="modal-body mt-16">${o.body}</div>` : ''}
      <div class="modal-foot">${
        o.actions ||
        btn({ label: '关闭', tone: 'ghost', attrs: 'data-modal-close' })
      }</div>
    </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-modal-close]')) close();
    });
    overlay.close = close;
    return overlay;
  }

  /** 确认框：返回 Promise<boolean> */
  function confirm(o = {}) {
    return new Promise((resolve) => {
      const overlay = modal({
        title: o.title || '确认操作',
        desc: o.desc || '',
        actions: `${btn({ label: o.cancel || '取消', tone: 'ghost', attrs: 'data-overlay-close' })}${btn({
          label: o.ok || '确认',
          tone: o.tone || 'primary',
          attrs: 'data-overlay-ok',
        })}`,
      });
      overlay.addEventListener('click', (e) => {
        if (e.target.closest('[data-overlay-ok]')) {
          overlay.remove();
          resolve(true);
        } else if (e.target === overlay || e.target.closest('[data-overlay-close]')) {
          overlay.remove();
          resolve(false);
        }
      });
    });
  }

  /**
   * 右上角登录用户菜单：头像 + 用户名，点击展开「切换用户 / 退出系统」。
   * 管理员头像用 ico/admin.ico（相对 renderer 为 ../ico/admin.ico）；
   * 其他账号回落为首字头像。图片加载失败时自动切成首字，不留破图。
   */
  function userMenu(user) {
    const u = user || (WB.data && WB.data.app.user) || { name: '用户', role: '', initial: '用' };
    const name = u.displayName || u.name || u.username || '用户';
    const role = String(u.role || '');
    const roleLabel = role === 'admin' ? '管理员' : role || '操作员';
    const initial = String(u.initial || name.slice(0, 1) || '用');
    const isAdmin = role === 'admin' || String(u.username || '').toLowerCase() === 'admin';
    const avatar = isAdmin
      ? `<img class="user-menu__img" src="../ico/admin.ico" alt="" data-user-avatar />
         <span class="user-menu__initial" hidden>${esc(initial)}</span>`
      : `<span class="user-menu__initial">${esc(initial)}</span>`;
    const subline = u.username ? `${roleLabel} · ${esc(u.username)}` : roleLabel;

    return `<div class="user-menu" data-user-menu>
      <button type="button" class="user-menu__trigger" data-user-menu-toggle aria-haspopup="menu" aria-expanded="false" title="${esc(subline)}">
        <span class="user-menu__avatar">${avatar}</span>
        <span class="user-menu__name">${esc(name)}</span>
        ${icon('chevron-down', 13, 'dim')}
      </button>
      <div class="user-menu__pop" data-user-menu-pop role="menu" hidden>
        <div class="user-menu__head">
          <div class="user-menu__head-name">${esc(name)}</div>
          <div class="user-menu__head-role">${subline}</div>
        </div>
        <button type="button" class="user-menu__item" role="menuitem" data-user-switch>
          ${icon('refresh', 14)}<span>切换用户</span>
        </button>
        <button type="button" class="user-menu__item is-danger" role="menuitem" data-user-exit>
          ${icon('power', 14)}<span>退出系统</span>
        </button>
      </div>
    </div>`;
  }

  /* ------------------------------ 工具函数 ------------------------------ */
  function bind(root, selector, event, handler, options) {
    const nodes = typeof selector === 'string' ? root.querySelectorAll(selector) : [selector];
    nodes.forEach((n) => n && n.addEventListener(event, handler, options));
  }

  function html(strings, ...values) {
    return strings.reduce((acc, s, i) => acc + s + (values[i] ?? ''), '');
  }

  WB.ui = {
    esc,
    num,
    icon,
    badge,
    chip,
    tag,
    statusDot,
    avatar,
    userMenu,
    btn,
    iconBtn,
    input,
    select,
    searchBox,
    switchControl,
    checkbox,
    card,
    statTile,
    kv,
    table,
    tabs,
    segmented,
    toast,
    modal,
    confirm,
    bind,
    html,
  };
})();
