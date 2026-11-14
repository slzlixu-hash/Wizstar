'use strict';

/**
 * MCP 插件管理页（纯真实数据，无演示降级）。
 *
 * 设计目标（重设计版）：
 *   方便接入 —— 粘贴服务地址自动识别（本机→免鉴权、自动生成 ID/名称），鉴权四档卡片式选择，保存即握手；
 *   方便管理 —— 单行一服务的列表（状态点/名称/地址/工具数/错误摘要），行内「调试 / 握手 / 编辑 可见、停用 / 删除在详情里」；
 *   方便查看 —— 顶部统计 + 最近检测时间 + 行内状态徽标与错误摘要；点行右滑出详情（元数据 / 工具清单 / 调试调用）。
 *
 * 数据源：/api/mcp/servers + /api/mcp/tools（全部真实响应，失败显示明确错误态）
 * 写操作：POST/PUT/DELETE /api/mcp/servers、/handshake、/disconnect、/tools/call、/debug-curl、/reconcile
 */
(function () {
  const WB = window.WB;
  const ui = WB.ui;
  const pages = (WB.pages = WB.pages || {});

  const SCOPES = [
    { id: 'all', label: '全部' },
    { id: 'builtin', label: '内置' },
    { id: 'external', label: '外部' },
  ];

  const STATES = [
    { id: 'all', label: '全部状态' },
    { id: 'online', label: '在线' },
    { id: 'offline', label: '异常' },
    { id: 'disabled', label: '已停用' },
  ];

  // 四档可插拔鉴权：本机直连默认免鉴权，HMAC 仅跨公网高危服务使用
  const AUTH_MODES = [
    { id: 'none', label: '免鉴权', hint: '本机 127.0.0.1 直连，不带任何凭证头' },
    { id: 'bearer', label: 'Bearer', hint: '标准 Authorization: Bearer <Key>' },
    { id: 'header', label: '自定义头', hint: 'X-Api-Key 等固定请求头' },
    { id: 'hmac', label: 'MCP-HMAC', hint: '跨公网高危服务，自动签名' },
  ];

  const EMPTY_STATS = [
    { label: '已登记插件', value: '—', unit: '', tone: 'cyan' },
    { label: '握手在线', value: '—', unit: '', tone: 'green' },
    { label: '异常 / 待接入', value: '—', unit: '', tone: 'amber' },
    { label: '可用工具', value: '—', unit: '', tone: 'violet' },
  ];

  const ICONS = ['shop', 'server', 'globe', 'link', 'database', 'sparkles', 'plugin', 'wifi'];
  const TONES = ['cyan', 'blue', 'violet', 'green', 'amber', 'slate', 'rose', 'cyan'];

  /* ------------------------------ 通用工具 ------------------------------ */

  function esc(v) {
    return ui.esc(v === undefined || v === null ? '' : String(v));
  }

  function mcpApi() {
    return (WB.api && WB.api.mcp) || null;
  }

  function toast(msg, tone) {
    if (typeof ui.toast === 'function') ui.toast(msg, tone || 'info');
  }

  function fmtTime(v) {
    if (!v) return '—';
    const d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false });
  }

  function fmtClock(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function field(overlay, key) {
    const el = overlay.querySelector('[data-f="' + key + '"]');
    return el ? String(el.value || '').trim() : '';
  }

  function hostOf(server) {
    const raw = String(server.url || '');
    const m = /^(https?:\/\/[^\s/]+)/i.exec(raw);
    if (m) return m[1].replace(/^https?:\/\//i, '');
    return raw || String(server.transport || '');
  }

  /** 状态语义统一出口：kind 给圆点，tone 给徽标配色。 */
  function stateInfo(server) {
    const state = String((server && server.state) || '').toLowerCase();
    if (server && server.online) return { kind: 'online', tone: 'green', label: '在线' };
    if (state === 'connecting') return { kind: 'busy', tone: 'cyan', label: '握手中' };
    if (state === 'error') return { kind: 'amber', tone: 'amber', label: '异常' };
    if (state === 'disabled') return { kind: 'offline', tone: 'slate', label: '已停用' };
    return { kind: 'offline', tone: 'slate', label: '未连接' };
  }

  /** 常见错误友好化：鉴权/连通性问题直接给可执行提示，其余保持原文（抽屉里可看全文）。 */
  function friendlyError(text) {
    const raw = String(text || '');
    if (!raw) return '';
    if (/(41001|\b401\b)/.test(raw) && /Authorization|HMAC|Bearer|鉴权/i.test(raw)) {
      return '鉴权失败：服务端拒绝了请求，请在「编辑」里核对鉴权模式与密钥';
    }
    if (/ECONNREFUSED|EHOSTUNREACH|不可达|拒绝连接|connect ECONN/i.test(raw)) {
      return '无法连接：服务未启动或端口不通（检查地址与进程）';
    }
    if (/超时|timed? ?out/i.test(raw)) return '连接超时：服务响应过慢或不可达';
    return raw;
  }

  /** 行内摘要：在线看工具数与连接时间，异常看错误，停用看原因。 */
  function summaryOf(server) {
    const st = stateInfo(server);
    if (server.online) {
      const parts = [String(server.toolsCount || 0) + ' 个工具'];
      if (server.connectedAt) parts.push('连接于 ' + fmtClock(server.connectedAt));
      return { text: parts.join(' · '), error: false };
    }
    if (st.label === '已停用') return { text: server.lastError || '已停用（清单保留，可重新启用）', error: false };
    return { text: friendlyError(server.lastError) || '尚未连接，点「连接」发起握手', error: true };
  }

  /* ------------------------------ 统计卡 ------------------------------ */

  const STAT_ICONS = ['plugin', 'wifi', 'link', 'zap'];

  function statCard(stat, i) {
    const tone = stat.tone || 'cyan';
    const dot = tone === 'green' || tone === 'amber' ? '<i class="mcp-stat__dot"></i>' : '';
    return `<section class="card mcp-stat mcp-tone-${esc(tone)}">
      <div class="mcp-stat__top">
        <span class="mcp-stat__ico">${ui.icon(STAT_ICONS[i] || 'plugin', 15)}</span>
        <span class="mcp-stat__label">${esc(stat.label)}</span>
      </div>
      <div class="mcp-stat__value num">${esc(stat.value)}<span class="mcp-stat__unit">${esc(stat.unit || '')}</span>${dot}</div>
    </section>`;
  }

  /* ------------------------------ 服务列表 ------------------------------ */

  function rowActions(server) {
    const st = stateInfo(server);
    const acts = [`<button type="button" class="mcp-act" data-act="debug">调试</button>`];
    if (st.label === '已停用') {
      acts.push(`<button type="button" class="mcp-act" data-act="handshake">启用</button>`);
    } else if (server.online) {
      acts.push(`<button type="button" class="mcp-act" data-act="handshake">重新握手</button>`);
    } else {
      acts.push(`<button type="button" class="mcp-act" data-act="handshake">连接</button>`);
    }
    acts.push(`<button type="button" class="mcp-act" data-act="config">编辑</button>`);
    return acts.join('');
  }

  function rowHtml(server, i) {
    const st = stateInfo(server);
    const sum = summaryOf(server);
    const tone = TONES[i % TONES.length];
    const icon = ICONS[i % ICONS.length];
    return `<article class="mcp-row${server.online ? '' : ' is-off'}${st.label === '已停用' ? ' is-disabled' : ''}"
        data-server="${esc(server.id)}" tabindex="0" role="button" title="点击查看详情与调试">
      <i class="status-dot ${st.kind}"></i>
      <span class="mcp-row__ico mcp-tone-${esc(tone)}">${ui.icon(icon, 17)}</span>
      <div class="mcp-row__main">
        <div class="mcp-row__title">
          <span class="mcp-row__name">${esc(server.name)}</span>
          ${server.builtin ? ui.badge('内置', { tone: 'cyan' }) : ''}
          <span class="mcp-chip" title="鉴权模式">${esc(server.authLabel || '免鉴权')}</span>
          ${ui.badge(st.label, { tone: st.tone, dot: true })}
        </div>
        <div class="mcp-row__meta mono" title="${esc(server.url || '')}">${esc(server.id)} · ${esc(hostOf(server))}</div>
        <div class="mcp-row__sub${sum.error ? ' is-error' : ''}" title="${esc(server.lastError || sum.text)}">${esc(sum.text)}</div>
      </div>
      <div class="mcp-row__side">
        <div class="mcp-row__acts">${rowActions(server)}</div>
      </div>
    </article>`;
  }

  function addRowHtml() {
    return `<button type="button" class="mcp-row mcp-row--add" data-mcp-add>
      <span class="mcp-row__plus">${ui.icon('plus', 16)}</span>
      <span class="mcp-row__main">
        <span class="mcp-row__name">接入外部 MCP 服务</span>
        <span class="mcp-row__meta">粘贴 URL → 自动识别鉴权 → 保存即握手</span>
      </span>
      <span class="mcp-row__arrow">${ui.icon('chevron-right', 15)}</span>
    </button>`;
  }

  function emptyHtml(reason, withAdd) {
    return `<div class="mcp-empty">
      ${ui.icon('plugin', 26)}
      <div class="mcp-empty__title">${esc(reason)}</div>
      <div class="tiny dim">MCP 服务用于给 Agent 提供外部工具；本地服务填 127.0.0.1 地址即可秒级接入。</div>
      ${withAdd ? `<div class="mcp-empty__acts">${ui.btn({ label: '接入 MCP 服务', icon: 'plus', tone: 'primary', attrs: 'data-mcp-add' })}</div>` : ''}
    </div>`;
  }

  function sectionHtml(title, rows, withAdd, emptyText) {
    return `<section class="mcp-sec">
      <div class="mcp-sec__head">
        <span class="mcp-sec__title">${esc(title)}</span>
        <span class="mcp-sec__count">${rows.length}</span>
        <span class="mcp-sec__hint">${title === '内置服务' ? '随产品发布 · 可改配置 / 可停用，不可删除' : '自行接入 · 支持完整增删改'}</span>
      </div>
      <div class="mcp-list">
        ${rows.length ? rows.map(rowHtml).join('') : `<div class="mcp-sec__empty">${esc(emptyText)}</div>`}
        ${withAdd ? addRowHtml() : ''}
      </div>
    </section>`;
  }

  function sectionsHtml(rows) {
    const builtins = rows.filter(function (r) { return r.builtin; });
    const externals = rows.filter(function (r) { return !r.builtin; });
    if (!builtins.length && !externals.length) return '';
    let html = '';
    if (builtins.length) html += sectionHtml('内置服务', builtins, false, '暂无内置服务');
    html += sectionHtml('外部服务', externals, true, '还没有外部服务，点下方「接入外部 MCP 服务」开始');
    return html;
  }

  /* ------------------------------ 详情抽屉 ------------------------------ */

  const RISK_LABEL = { read: '只读', write: '写入', irreversible: '不可逆' };

  function drawerToolsHtml(server) {
    const meta = server.toolsMeta || [];
    if (!meta.length) {
      return `<div class="mcp-sec__empty">${server.online ? '服务未返回工具' : '尚未握手，暂无工具清单'}</div>`;
    }
    const rows = meta.map(function (t) {
      const risk = String(t.risk || '').toLowerCase();
      const risky = risk === 'write' || risk === 'irreversible';
      const label = RISK_LABEL[risk] || '未声明';
      return `<div class="mcp-tool">
        <div class="mcp-tool__head">
          <span class="mcp-tool__name mono">${esc(t.name)}</span>
          ${ui.badge(label, { tone: risky ? 'amber' : risk === 'read' ? 'green' : 'slate' })}
          ${risk === 'irreversible' ? `<span class="mcp-tool__hint">需人工审批</span>` : ''}
        </div>
        <div class="mcp-tool__desc">${esc(t.description || '无描述')}</div>
      </div>`;
    }).join('');
    return rows;
  }

  function drawerHtml(server) {
    const st = stateInfo(server);
    const meta = [
      ['服务 ID', `<span class="mono">${esc(server.id)}</span>`],
      ['传输地址', `<span class="mono" title="${esc(server.url || '')}">${esc(server.url || '—')}</span>`],
      ['鉴权模式', esc(server.authLabel || '免鉴权')],
      ['协议版本', `<span class="mono">${esc(server.protocolVersion || '—')}</span>`],
      ['服务端', esc(server.bind || '—')],
      ['版本', `<span class="mono">${esc(server.serverVersion || '—')}</span>`],
      ['工具数量', esc(String(server.toolsCount || 0))],
      ['连接时间', `<span class="mono">${esc(fmtTime(server.connectedAt))}</span>`],
      ['最近检测', `<span class="mono">${esc(fmtTime(server.toolsFetchedAt))}</span>`],
    ];

    const toolSel = (server.toolNames && server.toolNames.length)
      ? ui.select({ options: server.toolNames.map(function (n) { return { value: n, label: n }; }), attrs: 'data-mcp-tool' })
      : `<div class="mcp-sec__empty" style="margin:0">（该服务未登记工具）</div>`;

    const offlineHint = server.online
      ? ''
      : `<div class="mcp-note">服务当前未连接：调试调用会失败，请先「${st.label === '已停用' ? '启用' : '连接'}」。</div>`;

    return `<div class="mcp-drawer__head">
        <div class="mcp-drawer__heading">
          <div class="mcp-drawer__title">
            <span class="mcp-drawer__name">${esc(server.name)}</span>
            ${server.builtin ? ui.badge('内置', { tone: 'cyan' }) : ui.badge('外部', { tone: 'slate' })}
            ${ui.badge(st.label, { tone: st.tone, dot: true })}
          </div>
          <div class="mcp-drawer__slug mono">${esc(server.id)}</div>
        </div>
        ${ui.iconBtn('close', { title: '关闭（Esc）', attrs: 'data-mcp-close' })}
      </div>
      <div class="mcp-drawer__body">
        <div class="mcp-endpoint mono" title="${esc(server.url || '')}">
          <i class="status-dot ${st.kind}"></i>
          <span class="mcp-endpoint__addr">${esc(hostOf(server) || '未配置地址')}</span>
        </div>
        ${server.lastError && !server.online ? `<div class="mcp-alert">${esc(server.lastError)}</div>` : ''}

        <div class="mcp-d-section">
          <div class="mcp-d-title">服务信息</div>
          ${ui.kv(meta, { cls: 'mcp-kv' })}
        </div>

        <div class="mcp-d-section">
          <div class="mcp-d-title">工具清单<span class="mcp-d-title__count">${(server.toolsMeta || []).length}</span></div>
          <div class="mcp-tools">${drawerToolsHtml(server)}</div>
        </div>

        <div class="mcp-d-section">
          <div class="mcp-d-title">调试调用<span class="mcp-d-title__hint">仅只读工具</span></div>
          ${offlineHint}
          <div class="mcp-select">${toolSel}</div>
          <label class="field" style="margin-top:8px">
            <span class="field-label">调用参数 (JSON，可空)</span>
            ${ui.input({ placeholder: '{ }', attrs: 'data-mcp-args' })}
          </label>
          <div class="mcp-d-actions">
            ${ui.btn({ label: '运行测试', tone: 'primary', icon: 'play', size: 'sm', attrs: 'data-mcp-run' })}
            ${ui.btn({ label: '复制调试 cURL', tone: 'ghost', size: 'sm', icon: 'copy', attrs: 'data-mcp-curl' })}
          </div>
          <div class="mcp-term">
            <div class="mcp-term__head">
              <span>${ui.icon('terminal', 13)} terminal</span>
              <span class="mono">tools/list</span>
            </div>
            <div class="terminal mcp-term__body" data-mcp-term></div>
          </div>
          <div class="tiny dim" style="line-height:1.6">写风险工具由平台以 43002 拒绝：须由 Agent 运行时执行（写操作需审批）。</div>
        </div>
      </div>
      <div class="mcp-drawer__foot">
        ${ui.btn({ label: st.label === '已停用' ? '启用服务' : '重新握手', tone: 'primary', icon: 'refresh', attrs: 'data-mcp-handshake' })}
        ${ui.btn({ label: '编辑配置', tone: 'ghost', icon: 'settings', attrs: 'data-mcp-edit' })}
        <span class="mcp-drawer__foot-right">
          ${st.label === '已停用' ? '' : '<button type="button" class="mcp-act" data-mcp-toggle>停用</button>'}
          ${server.builtin ? '' : '<button type="button" class="mcp-act mcp-act--danger" data-mcp-delete>删除</button>'}
        </span>
      </div>`;
  }

  /* ------------------------------ 终端着色 ------------------------------ */

  function hlLine(line) {
    const text = String(line == null ? '' : line);
    const re = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?/g;
    let out = '';
    let last = 0;
    let m = re.exec(text);
    while (m) {
      out += ui.esc(text.slice(last, m.index));
      const token = m[0];
      if (token.charAt(0) === '"') {
        const isKey = /^\s*:/.test(text.slice(re.lastIndex));
        out += `<span class="${isKey ? 't-key' : 't-str'}">${ui.esc(token)}</span>`;
      } else {
        out += `<span class="t-num">${ui.esc(token)}</span>`;
      }
      last = re.lastIndex;
      m = re.exec(text);
    }
    out += ui.esc(text.slice(last));
    return out;
  }

  function lineHtml(text) {
    return `<div class="mcp-t-line">${hlLine(text)}</div>`;
  }

  /* ------------------------------ 接入 / 编辑弹框 ------------------------------ */

  function authPanels(server) {
    const hasSecret = !!(server && server.hasAuthSecret);
    const secretPlaceholder = hasSecret ? '已配置，留空沿用' : '必填';
    return `
      <div class="mcp-auth-panel" data-auth-panel="none">
        <div class="mcp-form__hint">免鉴权：不带任何 Authorization 头。适合本机脚本 / 罗盘 / 1688 这类 127.0.0.1 直连服务。</div>
      </div>
      <div class="mcp-auth-panel" data-auth-panel="bearer">
        <label class="field"><span class="field-label">API Key</span>
          ${ui.input({ type: 'password', placeholder: secretPlaceholder, attrs: 'data-f="authSecret" autocomplete="new-password"' })}
        </label>
        <div class="mcp-form__hint">平台会发送 <span class="mono">Authorization: Bearer &lt;Key&gt;</span>。</div>
      </div>
      <div class="mcp-auth-panel" data-auth-panel="header">
        <label class="field"><span class="field-label">Header 名称</span>
          ${ui.input({ value: server ? String(server.authHeaderName || '') : '', placeholder: 'X-Api-Key', attrs: 'data-f="authHeaderName" autocomplete="off"' })}
        </label>
        <label class="field"><span class="field-label">Header 值（Key）</span>
          ${ui.input({ type: 'password', placeholder: secretPlaceholder, attrs: 'data-f="authSecret" autocomplete="new-password"' })}
        </label>
      </div>
      <div class="mcp-auth-panel" data-auth-panel="hmac">
        <label class="field"><span class="field-label">Key ID</span>
          ${ui.input({ value: server ? String(server.authKeyId || '') : '', placeholder: '如 wizstar-local', attrs: 'data-f="authKeyId" autocomplete="off"' })}
        </label>
        <label class="field"><span class="field-label">Secret</span>
          ${ui.input({ type: 'password', placeholder: secretPlaceholder, attrs: 'data-f="authSecret" autocomplete="new-password"' })}
        </label>
        <div class="mcp-form__hint">签名绑定请求体与 +300s 时间窗，仅建议跨公网的高危服务使用。</div>
      </div>`;
  }

  function serviceForm(server) {
    const isEdit = !!server;
    const authType = server ? String(server.authType || 'none') : 'none';
    return `<div class="mcp-form" data-mcp-form>
      <label class="field">
        <span class="field-label">服务地址（URL）<span class="mcp-req">*</span></span>
        ${ui.input({ value: server ? String(server.url || '') : '', placeholder: 'http://127.0.0.1:5210 或 https://mcp.example.com', attrs: 'data-f="url" data-mcp-url autocomplete="off"' })}
        <span class="mcp-form__hint" data-mcp-url-hint>粘贴地址即可：本机 127.0.0.1 会自动选「免鉴权」并生成服务 ID。</span>
      </label>
      <label class="field">
        <span class="field-label">显示名称<span class="mcp-req">*</span></span>
        ${ui.input({ value: server ? server.name : '', placeholder: '如：1688 货源', attrs: 'data-f="name"' })}
      </label>

      <div class="field">
        <span class="field-label">鉴权模式</span>
        <div class="mcp-auth-modes" data-mcp-auth-modes>
          ${AUTH_MODES.map(function (m) {
            return `<button type="button" class="mcp-auth-mode${m.id === authType ? ' is-on' : ''}" data-auth-mode="${m.id}" title="${esc(m.hint)}">
              <span class="mcp-auth-mode__label">${esc(m.label)}</span>
              <span class="mcp-auth-mode__hint">${esc(m.hint)}</span>
            </button>`;
          }).join('')}
        </div>
        <input type="hidden" data-f="authType" value="${esc(authType)}" />
      </div>
      ${authPanels(server)}

      <details class="mcp-advanced"${isEdit ? '' : ''}>
        <summary>高级选项</summary>
        <div class="mcp-advanced__body">
          <label class="field"><span class="field-label">服务 ID（小写字母/数字/._-）</span>
            ${ui.input({ value: server ? server.id : '', placeholder: '留空自动生成，如 local-5210', attrs: 'data-f="id"' })}
          </label>
          <label class="field"><span class="field-label">启动时自动握手</span>
            ${ui.switchControl({ checked: server ? !!server.autoStart : true, attrs: 'data-f="autoStart"' })}
          </label>
        </div>
      </details>

      <div class="mcp-form__note">保存后立即写入声明式清单并自动握手；密钥明文不回显，编辑时留空即沿用原值。</div>
    </div>`;
  }

  /** 地址解析：本机回环 → none + 生成 id/名称；外部 → 保留当前选择。 */
  function applyUrlHints(overlay, opts) {
    const urlEl = overlay.querySelector('[data-mcp-url]');
    const hintEl = overlay.querySelector('[data-mcp-url-hint]');
    const idEl = overlay.querySelector('[data-f="id"]');
    const nameEl = overlay.querySelector('[data-f="name"]');
    if (!urlEl) return;

    const raw = String(urlEl.value || '').trim();
    const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?/i.exec(raw);
    const port = loopback && loopback[2] ? loopback[2] : '';

    if (loopback) {
      if (!opts.authTouched) setAuthMode(overlay, 'none');
      if (!opts.idTouched && idEl && !idEl.value) idEl.value = port ? 'local-' + port : 'local';
      if (!opts.nameTouched && nameEl && !nameEl.value) nameEl.value = port ? '本机 MCP · ' + port : '本机 MCP';
      if (hintEl) hintEl.textContent = '已识别为本机地址：默认免鉴权、自动生成服务 ID，填好名称即可保存。';
    } else if (raw) {
      if (hintEl) hintEl.textContent = '外部地址：请按服务端要求选择鉴权模式（Bearer / 自定义头 / HMAC）。';
    } else if (hintEl) {
      hintEl.textContent = '粘贴地址即可：本机 127.0.0.1 会自动选「免鉴权」并生成服务 ID。';
    }
  }

  function setAuthMode(overlay, mode) {
    const hidden = overlay.querySelector('[data-f="authType"]');
    if (hidden) hidden.value = mode;
    overlay.querySelectorAll('[data-auth-mode]').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.authMode === mode);
    });
    overlay.querySelectorAll('[data-auth-panel]').forEach(function (p) {
      p.hidden = p.dataset.authPanel !== mode;
    });
  }

  function bindServiceForm(overlay, opts) {
    const touched = { auth: !!opts.isEdit, id: !!opts.isEdit, name: !!opts.isEdit };
    // 编辑态沿用已有配置，不做自动改写；新建态才随输入智能补全
    if (opts.isEdit) {
      const hidden = overlay.querySelector('[data-f="authType"]');
      setAuthMode(overlay, hidden ? hidden.value : 'none');
    } else {
      setAuthMode(overlay, 'none');
    }

    overlay.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-auth-mode]');
      if (!btn) return;
      touched.auth = true;
      setAuthMode(overlay, btn.dataset.authMode);
    });

    const urlEl = overlay.querySelector('[data-mcp-url]');
    if (urlEl) {
      urlEl.addEventListener('input', function () { applyUrlHints(overlay, { authTouched: touched.auth, idTouched: touched.id, nameTouched: touched.name }); });
    }
    const idEl = overlay.querySelector('[data-f="id"]');
    if (idEl) idEl.addEventListener('input', function () { touched.id = true; });
    const nameEl = overlay.querySelector('[data-f="name"]');
    if (nameEl) nameEl.addEventListener('input', function () { touched.name = true; });

    if (!opts.isEdit && urlEl) applyUrlHints(overlay, touched);
  }

  /** 收集表单：按鉴权模式取凭证；留空 = 不提交（后端沿用旧值）。 */
  function collectBody(overlay, server) {
    const mode = field(overlay, 'authType') || 'none';
    const autoEl = overlay.querySelector('[data-f="autoStart"]');
    const body = {
      name: field(overlay, 'name'),
      url: field(overlay, 'url'),
      transport: 'http',
      authType: mode,
      autoStart: autoEl ? !!autoEl.checked : false,
    };
    const id = field(overlay, 'id');
    if (id) body.id = id;
    if (!server && !body.id) body.id = deriveId(body.url, body.name);
    if (!body.url) return { error: '请填写服务地址（URL）' };
    if (!/^https?:\/\/[^\s]+$/i.test(body.url)) return { error: '服务地址必须是合法的 http(s) URL' };
    if (!body.name) return { error: '请填写显示名称' };

    if (mode === 'header') {
      const headerName = field(overlay, 'authHeaderName');
      if (headerName) body.authHeaderName = headerName;
    }
    if (mode !== 'none') {
      const secret = field(overlay, 'authSecret');
      const hasOld = !!(server && server.hasAuthSecret);
      if (!secret && !hasOld) return { error: mode === 'hmac' ? 'MCP-HMAC 模式需要填写 Secret' : '该鉴权模式需要填写 Key' };
      if (mode === 'hmac') {
        const keyId = field(overlay, 'authKeyId');
        if (!keyId && !(server && server.authKeyId)) return { error: 'MCP-HMAC 模式需要填写 Key ID' };
        if (keyId) body.authKeyId = keyId;
      }
      if (secret) body.authSecret = secret;
    }
    return { body: body };
  }

  function deriveId(url, name) {
    const m = /^https?:\/\/([^/:]+)(?::(\d+))?/i.exec(String(url || ''));
    if (m) {
      const host = m[1].toLowerCase() === 'localhost' ? 'local' : m[1].toLowerCase().replace(/[^a-z0-9.-]/g, '');
      if (m[2]) return 'svc-' + m[2];
      return (host === 'local' ? 'local' : host.split('.')[0] || 'mcp') ;
    }
    return String(name || 'mcp').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mcp';
  }

  function openServiceModal(api, server, onDone) {
    const isEdit = !!server;
    const overlay = ui.modal({
      title: isEdit ? `${esc(server.name)} · 编辑配置` : '接入 MCP 服务',
      desc: isEdit
        ? (server.builtin ? '内置服务：可改配置、可停用，不可删除。保存后自动重新握手。' : '保存后自动重新握手。')
        : '三步接入：填地址 → 确认鉴权 → 保存并握手。本机地址默认免鉴权。',
      body: serviceForm(server),
      actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}
        ${ui.btn({ label: isEdit ? '保存并重新握手' : '保存并连接', tone: 'primary', attrs: 'data-mcp-save' })}`,
    });
    bindServiceForm(overlay, { isEdit: isEdit });

    overlay.addEventListener('click', async function (e) {
      if (!e.target.closest('[data-mcp-save]')) return;
      const collected = collectBody(overlay, server);
      if (collected.error) { toast(collected.error, 'warn'); return; }

      const btn = overlay.querySelector('[data-mcp-save]');
      if (btn) btn.disabled = true;
      const body = collected.body;
      const res = isEdit ? await api.update(server.id, body) : await api.create(body);
      if (btn) btn.disabled = false;

      if (!res.ok) {
        toast((isEdit ? '保存失败：' : '接入失败：') + (res.error || '服务未连接'), 'warn');
        return;
      }
      overlay.close();
      const connected = res.data && res.data.connected;
      toast(
        isEdit
          ? (connected === false ? '配置已保存，握手失败（可稍后重试）' : '配置已保存并重新握手成功')
          : (connected === false ? '已登记，握手失败（可稍后重新连接）' : '接入成功，已握手并拉取工具'),
        connected === false ? 'warn' : 'success'
      );
      onDone();
    });
  }

  /* ------------------------------ 页面注册 ------------------------------ */

  pages.mcp = {
    title: 'MCP 插件管理',
    subtitle: '内置 / 外部服务接入、状态与调试',
    actions: ui.btn({ label: '接入 MCP 服务', icon: 'plus', tone: 'primary', attrs: 'data-mcp-add' }),

    render(ctx) {
      const live = ctx.data.mcpSource === 'live' && ctx.data.mcp;
      const mcp = live ? ctx.data.mcp : { stats: EMPTY_STATS, servers: [] };
      return `<div class="mcp-page">
        <div class="mcp-main">
          <div class="mcp-stats" data-mcp-stats>${mcp.stats.map(statCard).join('')}</div>
          <div class="mcp-toolbar">
            ${ui.segmented(SCOPES, 'all', 'data-mcp-scope')}
            ${ui.segmented(STATES, 'all', 'data-mcp-state')}
            <div class="mcp-toolbar__right">
              <span class="mcp-last" data-mcp-last>最近检测 —</span>
              ${ui.btn({ label: '全部健康探测', tone: 'ghost', size: 'sm', icon: 'refresh', attrs: 'data-mcp-probe' })}
              ${ui.searchBox({ placeholder: '搜索名称 / 地址 / 工具…', width: '190px', attrs: 'data-mcp-search' })}
            </div>
          </div>
          <div class="mcp-sections" data-mcp-grid></div>
        </div>
        <div class="mcp-backdrop" data-mcp-backdrop hidden></div>
        <aside class="mcp-drawer" data-mcp-drawer aria-hidden="true" tabindex="-1"></aside>
      </div>`;
    },

    mount(root, ctx) {
      const api = mcpApi();
      const statsEl = root.querySelector('[data-mcp-stats]');
      const grid = root.querySelector('[data-mcp-grid]');
      const lastEl = root.querySelector('[data-mcp-last]');
      const drawer = root.querySelector('[data-mcp-drawer]');
      const backdrop = root.querySelector('[data-mcp-backdrop]');
      const probeBtn = root.querySelector('[data-mcp-probe]');
      const search = root.querySelector('[data-mcp-search]');
      const scopeBtns = root.querySelectorAll('[data-mcp-scope]');
      const stateBtns = root.querySelectorAll('[data-mcp-state]');

      let servers = [];
      let connected = false;
      const state = { serviceId: '', scope: 'all', stateFilter: 'all', keyword: '' };

      /* 浮层 portal：页面入场动画的 transform 会让 fixed 锚定到页面区，
         挪到 body 才能贴住视口；切页/重渲染时按挂载令牌回收，避免残留。 */
      document.body.appendChild(backdrop);
      document.body.appendChild(drawer);
      const portalToken = 'mcp-portal-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      root.dataset.mcpPortal = portalToken;
      const portalObserver = new MutationObserver(function () {
        if (root.dataset.mcpPortal === portalToken && root.querySelector('.mcp-page')) return;
        backdrop.remove();
        drawer.remove();
        document.removeEventListener('keydown', onKeydown);
        portalObserver.disconnect();
      });
      portalObserver.observe(root, { childList: true });

      function onKeydown(e) {
        if (e.key === 'Escape' && drawer.classList.contains('is-open')) closeDrawer();
      }
      document.addEventListener('keydown', onKeydown);

      const current = function () {
        return servers.find(function (s) { return s.id === state.serviceId; }) || servers[0] || null;
      };

      function updateSubtitle() {
        const el = document.querySelector('.page-subtitle');
        if (el) {
          el.textContent = '内置 / 外部服务接入、状态与调试 · ' +
            (connected ? '实时数据' : '本地服务未连接（' + ((ctx.data.app && ctx.data.app.endpoint) || '127.0.0.1:5301') + '）');
        }
      }

      function lastCheckedAt() {
        let max = 0;
        servers.forEach(function (s) {
          [s.toolsFetchedAt, s.connectedAt].forEach(function (t) {
            const n = t ? new Date(t).getTime() : 0;
            if (n > max) max = n;
          });
        });
        return max ? new Date(max) : null;
      }

      function paintStats() {
        if (!statsEl) return;
        const stats = (ctx.data.mcpSource === 'live' && ctx.data.mcp && ctx.data.mcp.stats) ? ctx.data.mcp.stats : EMPTY_STATS;
        statsEl.innerHTML = stats.map(statCard).join('');
        if (lastEl) {
          const at = lastCheckedAt();
          lastEl.textContent = at ? '最近检测 ' + fmtTime(at) : '最近检测 —';
        }
      }

      function filtered() {
        const kw = state.keyword;
        return servers.filter(function (s) {
          const st = stateInfo(s);
          if (state.scope === 'builtin' && !s.builtin) return false;
          if (state.scope === 'external' && s.builtin) return false;
          if (state.stateFilter === 'online' && !s.online) return false;
          if (state.stateFilter === 'offline' && (s.online || st.label === '已停用')) return false;
          if (state.stateFilter === 'disabled' && st.label !== '已停用') return false;
          if (kw) {
            const hay = [s.name, s.id, s.url, s.authLabel, (s.toolNames || []).join(' ')]
              .join(' ').toLowerCase();
            if (hay.indexOf(kw) === -1) return false;
          }
          return true;
        });
      }

      function paintGrid() {
        const rows = filtered();
        if (!servers.length) {
          grid.innerHTML = emptyHtml(connected ? '还没有接入任何 MCP 服务' : '本地服务未连接，无法加载清单', true);
          return;
        }
        if (!rows.length) {
          grid.innerHTML = emptyHtml('没有匹配的服务', false);
          return;
        }
        grid.innerHTML = sectionsHtml(rows);
      }

      function paintDrawer() {
        const server = current();
        if (!server) { drawer.innerHTML = ''; return; }
        drawer.innerHTML = drawerHtml(server);
        paintTerm();
      }

      function paintTerm() {
        const server = current();
        const term = drawer.querySelector('[data-mcp-term]');
        if (!server || !term) return;
        const lines = ['{', '  "method": "tools/list",', '  "server": ' + JSON.stringify(server.id) + ',', '  "tools": ['];
        const meta = server.toolsMeta || [];
        meta.forEach(function (t, i) {
          lines.push('    ' + JSON.stringify({ name: t.name, risk: t.risk || null, description: t.description }) + (i < meta.length - 1 ? ',' : ''));
        });
        if (!meta.length) lines.push('    // ' + (server.online ? '服务未返回工具' : '尚未握手，暂无工具清单'));
        lines.push('  ]', '}');
        term.innerHTML = lines.map(lineHtml).join('');
      }

      function paintAll() {
        servers = (ctx.data.mcpSource === 'live' && ctx.data.mcp) ? (ctx.data.mcp.servers || []).slice() : [];
        if (!servers.some(function (s) { return s.id === state.serviceId; })) {
          state.serviceId = servers[0] ? servers[0].id : '';
        }
        if (!servers.length) closeDrawer();
        paintStats();
        paintGrid();
        if (drawer.classList.contains('is-open')) paintDrawer();
        updateSubtitle();
      }

      function openDrawer(server) {
        if (!server) return;
        state.serviceId = server.id;
        paintGrid();
        paintDrawer();
        drawer.classList.add('is-open');
        drawer.setAttribute('aria-hidden', 'false');
        backdrop.hidden = false;
        try { drawer.focus({ preventScroll: true }); } catch (_) { /* 焦点失败不影响打开 */ }
      }

      function closeDrawer() {
        drawer.classList.remove('is-open');
        drawer.setAttribute('aria-hidden', 'true');
        backdrop.hidden = true;
      }

      async function reload(silent) {
        if (!api || !WB.api.available()) {
          connected = false;
          servers = [];
          paintAll();
          return false;
        }
        let res;
        try { res = await api.load(); } catch (_) { res = { ok: false, error: '请求异常' }; }
        if (!res.ok) {
          connected = false;
          servers = [];
          paintAll();
          if (!silent) toast('加载失败：' + (res.error || '本地服务未连接'), 'warn');
          return false;
        }
        connected = true;
        api.apply(res.servers, res.tools);
        paintAll();
        return true;
      }

      /* ------------------------------ 动作 ------------------------------ */

      async function doHandshake(server) {
        toast('正在与 ' + server.name + ' 握手…', 'info');
        let res;
        try { res = await api.handshake(server.id); } catch (_) { res = { ok: false, error: '请求异常' }; }
        if (!res.ok) {
          toast('握手失败：' + (res.error || '服务不可达'), 'warn');
          await reload(true);
          return;
        }
        toast(server.name + ' · 握手成功', 'success');
        await reload(true);
      }

      async function doReconcile(btn) {
        if (!btn || btn.disabled) return;
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span><span>探测中…</span>';
        let res;
        try { res = await api.reconcile(); } catch (_) { res = { ok: false, error: '请求异常' }; }
        btn.disabled = false;
        btn.innerHTML = original;

        if (!res.ok) {
          toast('探测失败：' + (res.error || '本地服务未连接'), 'warn');
          await reload(true);
          return;
        }
        const s = res.data || {};
        toast('对账完成：新增 ' + (s.added || 0) + ' / 刷新 ' + (s.refreshed || 0) +
          ' / 移除 ' + (s.removed || 0) + ' / 失败 ' + (s.failed || 0), Number(s.failed) > 0 ? 'warn' : 'success');
        await reload(true);
      }

      async function doDisconnect(server) {
        const ok = await ui.confirm({
          title: '停用 ' + server.name + '？',
          desc: '运行时停用：清空工具缓存、状态置为已停用；清单保留，随时可重新启用。',
          ok: '停用',
          tone: 'danger',
        });
        if (!ok) return;
        const res = await api.disconnect(server.id);
        if (!res.ok) { toast('停用失败：' + (res.error || '服务未连接'), 'warn'); return; }
        toast(server.name + ' 已停用（可随时启用）', 'success');
        await reload(true);
      }

      async function doDelete(server) {
        if (server.builtin) { toast('内置服务不可删除：可停用或修改配置', 'warn'); return; }
        const ok = await ui.confirm({
          title: '删除 ' + server.name + '？',
          desc: '将从声明清单移除该服务并停用运行时（数据保留，可重新接入）。',
          ok: '删除',
          tone: 'danger',
        });
        if (!ok) return;
        const res = await api.remove(server.id);
        if (!res.ok) { toast('删除失败：' + (res.error || '服务未连接'), 'warn'); return; }
        toast(server.name + ' 已清除', 'success');
        closeDrawer();
        await reload(true);
      }

      function appendTermLine(term, text) {
        const line = document.createElement('div');
        line.className = 'mcp-t-line mcp-t-line--run';
        line.innerHTML = hlLine(text);
        term.appendChild(line);
        term.scrollTop = term.scrollHeight;
      }

      async function runTest() {
        const server = current();
        const term = drawer.querySelector('[data-mcp-term]');
        if (!server || !term) return;
        const stamp = new Date().toTimeString().slice(0, 8);
        if (!server.online) {
          appendTermLine(term, `[${stamp}] 服务未连接（${stateInfo(server).label}），未发起请求`);
          toast(server.name + ' 未连接，无法调试', 'warn');
          return;
        }
        const sel = drawer.querySelector('[data-mcp-tool]');
        const argsInput = drawer.querySelector('[data-mcp-args]');
        const name = sel ? String(sel.value || '') : '';
        if (!name) { appendTermLine(term, `[${stamp}] 该服务未登记工具，无法调用`); return; }

        let args = {};
        const raw = String((argsInput && argsInput.value) || '').trim();
        if (raw) {
          try { args = JSON.parse(raw); } catch (_) {
            appendTermLine(term, `[${stamp}] 参数不是合法 JSON：${raw}`);
            toast('调用参数必须是合法 JSON 对象', 'warn');
            return;
          }
        }

        const btn = drawer.querySelector('[data-mcp-run]');
        if (btn) btn.disabled = true;
        const started = Date.now();
        let res;
        try { res = await api.callTool({ serverId: server.id, name: name, arguments: args }); }
        catch (_) { res = { ok: false, error: '请求异常' }; }
        if (btn) btn.disabled = false;

        appendTermLine(term, `[${stamp}] tools/call ${server.id}/${name} 参数=${JSON.stringify(args)}（前端 ${Date.now() - started}ms）`);
        if (!res.ok) {
          appendTermLine(term, JSON.stringify({ success: false, error: res.error || '调用失败' }));
          toast('调用失败：' + (res.error || '服务未连接'), 'warn');
          return;
        }
        appendTermLine(term, JSON.stringify(res.data));
        toast(server.name + ' · ' + name + ' 调用成功', 'success');
      }

      async function copyDebugCurl() {
        const server = current();
        if (!server) return;
        const sel = drawer.querySelector('[data-mcp-tool]');
        const tool = sel ? String(sel.value || '') : '';
        let res;
        try { res = await api.debugCurl(server.id, tool || undefined); } catch (_) { res = { ok: false }; }
        if (!res.ok || !res.data || !res.data.curl) {
          toast('生成失败：' + (res.error || '本地服务未连接'), 'warn');
          return;
        }
        const text = res.data.curl;
        const hmac = String(res.data.authType || '') === 'hmac';
        const okMsg = '调试 cURL 已复制' + (hmac ? '（签名 ±300s 内有效）' : '');
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { toast(okMsg, 'success'); },
              function () { toast('复制失败，请手动选中终端文本复制', 'warn'); });
            return;
          }
        } catch (_) { /* 降级提示 */ }
        toast('当前环境不支持自动复制', 'warn');
      }

      /* ------------------------------ 事件 ------------------------------ */

      grid.addEventListener('click', function (e) {
        if (e.target.closest('[data-mcp-add]')) {
          openServiceModal(api, null, function () { reload(true); });
          return;
        }
        const row = e.target.closest('[data-server]');
        if (!row) return;
        const server = servers.find(function (s) { return s.id === row.dataset.server; });
        if (!server) return;
        const act = e.target.closest('[data-act]');
        if (act) {
          e.stopPropagation();
          if (act.dataset.act === 'debug') openDrawer(server);
          else if (act.dataset.act === 'handshake') doHandshake(server);
          else if (act.dataset.act === 'config') openServiceModal(api, server, function () { reload(true); });
          return;
        }
        openDrawer(server);
      });

      grid.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('[data-server]');
        if (!row) return;
        e.preventDefault();
        const server = servers.find(function (s) { return s.id === row.dataset.server; });
        if (server) openDrawer(server);
      });

      scopeBtns.forEach(function (btn) {
        btn.addEventListener('click', function () {
          scopeBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
          state.scope = btn.dataset.mcpScope;
          paintGrid();
        });
      });

      stateBtns.forEach(function (btn) {
        btn.addEventListener('click', function () {
          stateBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
          state.stateFilter = btn.dataset.mcpState;
          paintGrid();
        });
      });

      if (search) {
        search.addEventListener('input', function () {
          state.keyword = String(search.value || '').trim().toLowerCase();
          paintGrid();
        });
      }

      if (probeBtn) probeBtn.addEventListener('click', function () { doReconcile(probeBtn); });

      drawer.addEventListener('click', function (e) {
        const server = current();
        if (!server) return;
        if (e.target.closest('[data-mcp-close]')) { closeDrawer(); return; }
        if (e.target.closest('[data-mcp-run]')) { runTest(); return; }
        if (e.target.closest('[data-mcp-curl]')) { copyDebugCurl(); return; }
        if (e.target.closest('[data-mcp-handshake]')) { doHandshake(server); return; }
        if (e.target.closest('[data-mcp-edit]')) { openServiceModal(api, server, function () { reload(true); }); return; }
        if (e.target.closest('[data-mcp-toggle]')) {
          if (stateInfo(server).label === '已停用') doHandshake(server);
          else doDisconnect(server);
          return;
        }
        if (e.target.closest('[data-mcp-delete]')) { doDelete(server); }
      });

      backdrop.addEventListener('click', closeDrawer);

      drawer.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && e.target.closest('[data-mcp-args]')) runTest();
      });

      const headerAdd = document.querySelector('.page-header [data-mcp-add]');
      if (headerAdd) headerAdd.addEventListener('click', function () {
        openServiceModal(api, null, function () { reload(true); });
      });

      reload(true);
    },
  };
})();
