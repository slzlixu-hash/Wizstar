'use strict';

/**
 * MCP 插件管理页（主界面 · 全局 API 网关视角）。
 *
 * 设计口径：
 *   - 面向 IT 运维 / 开发：只关心「服务通不通、鉴权对不对、Schema 能不能拿到」；
 *   - 中左栏：全局 MCP Servers（物理服务实例 + 绿/红网络状态）；
 *   - 中右栏：全局 MCP Configuration（Endpoint / 三档鉴权 / 自定义 Header / 在线调试终端）；
 *   - 不出现 Agent、Skill、Token 预算等业务概念。
 *
 * 数据源与写操作全部走真实接口：
 *   GET  /api/mcp/servers、/api/mcp/tools
 *   POST /api/mcp/probe（不写清单，直接握手并打印原始 initialize / tools/list）
 *   POST /api/mcp/servers、PUT /api/mcp/servers/{id}、DELETE /api/mcp/servers/{id}
 *   POST /api/mcp/servers/{id}/handshake、/disconnect
 */
(function () {
  const WB = window.WB;
  const ui = WB.ui;
  const pages = (WB.pages = WB.pages || {});

  const AUTH_MODES = [
    { id: 'none', label: '免签权 None' },
    { id: 'bearer', label: 'Bearer Token' },
    { id: 'hmac', label: 'HMAC 签名' },
  ];

  function esc(v) {
    return ui.esc(v === undefined || v === null ? '' : String(v));
  }

  function toast(msg, tone) {
    if (typeof ui.toast === 'function') ui.toast(msg, tone || 'info');
  }

  function fmtTime(v) {
    if (!v) return '—';
    const d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false });
  }

  function hostOf(server) {
    const raw = String(server.url || '');
    const m = /^(https?:\/\/[^\s/]+)/i.exec(raw);
    return m ? m[1].replace(/^https?:\/\//i, '') : raw;
  }

  function stateMeta(server) {
    if (!server) return { label: '待接入', tone: 'slate', dot: 'slate' };
    const raw = String(server.state || '').toLowerCase();
    if (server.online || raw === 'connected') return { label: '运行正常', tone: 'green', dot: 'green' };
    if (raw === 'connecting') return { label: '握手中', tone: 'cyan', dot: 'cyan' };
    if (raw === 'disabled') return { label: '未启用', tone: 'slate', dot: 'slate' };
    return { label: '异常 / 断连', tone: 'rose', dot: 'red' };
  }

  /** 四档鉴权在后端仍保留 header 兼容；本页只暴露产品要求的三档。 */
  function authModeOf(server) {
    const type = String((server && server.authType) || 'none').toLowerCase();
    return type === 'bearer' || type === 'hmac' ? type : 'none';
  }

  function blankDraft() {
    return {
      id: '',
      name: '',
      url: '',
      authType: 'none',
      authKeyId: '',
      authSecret: '',
      headers: [],
      autoStart: true,
    };
  }

  function draftFromServer(server) {
    return {
      id: String(server.id || ''),
      name: String(server.name || ''),
      url: String(server.url || ''),
      authType: authModeOf(server),
      authKeyId: String(server.authKeyId || ''),
      authSecret: '',
      headers: (server.headerKeys || []).map(function (key) { return { key: key, value: '' }; }),
      autoStart: !!server.autoStart,
    };
  }

  function deriveId(url, name) {
    const m = /^https?:\/\/([^/:]+)(?::(\d+))?/i.exec(String(url || ''));
    if (m) {
      const host = m[1].toLowerCase() === 'localhost' ? 'local' : m[1].toLowerCase().replace(/[^a-z0-9.-]/g, '');
      if (m[2]) return (host === 'local' ? 'local-' : 'svc-') + m[2];
      return host || 'mcp';
    }
    return String(name || 'mcp').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mcp';
  }

  function stamp() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  function pretty(value) {
    if (value === undefined || value === null) return '# (empty)';
    try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
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

  /* ------------------------------ 页面骨架 ------------------------------ */

  pages.mcp = {
    title: 'MCP 插件管理',
    subtitle: '全局 MCP 服务接入、鉴权与在线调试 · 实时数据',
    actions: '',

    render() {
      return `<div class="mcp-gw" data-mcp-root>
        <aside class="mcp-gw-side">
          <div class="mcp-gw-side-head">
            <div class="mcp-gw-side-title">
              ${ui.icon('server', 15)}
              <span>全局 MCP 服务 <em>(Global MCP Servers)</em></span>
            </div>
            <button type="button" class="mcp-gw-new" data-mcp-new>${ui.icon('plus', 13)} 接入新服务</button>
          </div>
          <label class="mcp-gw-search">${ui.icon('search', 14)}
            <input class="input" placeholder="搜索服务..." data-mcp-search autocomplete="off" />
          </label>
          <div class="mcp-gw-list" data-mcp-list>
            <div class="mcp-gw-loading">正在读取服务...</div>
          </div>
        </aside>
        <section class="mcp-gw-main" data-mcp-editor>
          <div class="mcp-gw-loading">正在读取全局 MCP 配置...</div>
        </section>
      </div>`;
    },

    mount(root, ctx) {
      const api = (WB.api && WB.api.mcp) || null;
      const listEl = root.querySelector('[data-mcp-list]');
      const editorEl = root.querySelector('[data-mcp-editor]');
      const searchEl = root.querySelector('[data-mcp-search]');

      const state = {
        servers: [],
        selectedId: null,
        isNew: false,
        loading: true,
        connected: false,
        keyword: '',
        draft: blankDraft(),
        terminal: '',
        busy: false,
      };

      function findServer(id) {
        return state.servers.find(function (s) { return s.id === id; }) || null;
      }

      function current() {
        return findServer(state.selectedId);
      }

      function updateSubtitle() {
        const el = document.querySelector('.page-subtitle');
        if (el) {
          el.textContent = '全局 MCP 服务接入、鉴权与在线调试 · ' +
            (state.connected ? '实时数据' : '本地服务未连接（' + ((ctx.data.app && ctx.data.app.endpoint) || '127.0.0.1:5301') + '）');
        }
      }

      function paintList() {
        if (!listEl) return;
        if (state.loading) {
          listEl.innerHTML = '<div class="mcp-gw-loading">正在读取服务...</div>';
          return;
        }
        if (!state.connected) {
          listEl.innerHTML = `<div class="mcp-gw-empty">
            ${ui.icon('wifi', 22)}
            <div class="mcp-gw-empty-title">本地服务未连接</div>
            <div class="mcp-gw-empty-desc">无法读取 MCP 清单，请确认 5301 端口服务已启动。</div>
            <button type="button" class="mcp-gw-retry" data-mcp-reload>重新加载</button>
          </div>`;
          return;
        }
        const kw = String(state.keyword || '').trim().toLowerCase();
        const rows = (state.servers || []).filter(function (s) {
          return !kw || [s.name, s.id, s.url, s.authLabel].join(' ').toLowerCase().indexOf(kw) !== -1;
        });
        if (!rows.length) {
          listEl.innerHTML = `<div class="mcp-gw-empty">
            ${ui.icon('plugin', 22)}
            <div class="mcp-gw-empty-title">${state.servers.length ? '没有匹配的服务' : '还没有接入 MCP 服务'}</div>
            <div class="mcp-gw-empty-desc">${state.servers.length ? '换个关键词试试。' : '点右上角「+ 接入新服务」开始。'}</div>
          </div>`;
          return;
        }
        listEl.innerHTML = rows.map(function (server) {
          const meta = stateMeta(server);
          const on = !state.isNew && server.id === state.selectedId;
          return `<button type="button" class="mcp-gw-card${on ? ' is-on' : ''}" data-mcp-select="${esc(server.id)}">
            <div class="mcp-gw-card-name">
              <span>${esc(server.name || server.id)}</span>
              ${server.builtin ? '<i class="mcp-gw-tag">内置</i>' : ''}
            </div>
            <div class="mcp-gw-card-status">
              <i class="mcp-gw-dot is-${esc(meta.dot)}"></i>${esc(meta.label)}
            </div>
            <div class="mcp-gw-card-url mono" title="${esc(server.url || '')}">${esc(server.url || '未配置 Endpoint')}</div>
          </button>`;
        }).join('');
      }

      function headerRowsHtml() {
        if (!(state.draft.headers || []).length) {
          return '<div class="mcp-gw-headers-empty" data-mcp-headers-empty>暂无自定义请求头。企业网关的租户 / 路由头可在这里追加。</div>';
        }
        return state.draft.headers.map(function (row, i) {
          return `<div class="mcp-gw-header-row" data-mcp-header-row="${i}">
            <input class="input" placeholder="Header 名称，如 X-Tenant-Id" value="${esc(row.key)}" data-mcp-header-key autocomplete="off" />
            <input class="input" type="password" placeholder="${row.key ? '值（留空沿用已保存值）' : '值'}" value="${esc(row.value)}" data-mcp-header-value autocomplete="new-password" />
            <button type="button" class="mcp-gw-header-del" data-mcp-header-del="${i}" title="移除">×</button>
          </div>`;
        }).join('');
      }

      function authFieldsHtml(server) {
        const draft = state.draft;
        const hasSecret = !!(server && server.hasAuthSecret);
        if (draft.authType === 'none') {
          return '<div class="mcp-gw-field-hint">免签模式：不发送任何鉴权头。需要租户 / 路由头时，在下方「自定义 Header」中追加。</div>';
        }
        if (draft.authType === 'bearer') {
          return `<label class="field"><span class="field-label">Bearer Token</span>
            <input class="input" type="password" data-mcp-secret value="${esc(draft.authSecret)}"
              placeholder="${hasSecret ? '已配置，留空沿用' : '必填'}" autocomplete="new-password" />
          </label>`;
        }
        return `<div class="mcp-gw-grid2">
          <label class="field"><span class="field-label">Key ID</span>
            <input class="input" data-mcp-key-id value="${esc(draft.authKeyId)}" placeholder="如 wizstar-local" autocomplete="off" />
          </label>
          <label class="field"><span class="field-label">Secret</span>
            <input class="input" type="password" data-mcp-secret value="${esc(draft.authSecret)}"
              placeholder="${hasSecret ? '已配置，留空沿用' : '必填'}" autocomplete="new-password" />
          </label>
        </div>
        <div class="mcp-gw-field-hint">HMAC 签名绑定请求体，仅建议跨公网的高危服务使用。</div>`;
      }

      function editorHtml(server) {
        const draft = state.draft;
        const meta = stateMeta(server);
        const isNew = state.isNew || !server;
        const disabled = !!(server && String(server.state || '').toLowerCase() === 'disabled');
        const builtin = !!(server && server.builtin);
        const statusBadge = ui.badge(meta.label, { tone: meta.tone, dot: true });

        return `<div class="mcp-gw-main-head">
          <div class="mcp-gw-main-title">
            ${ui.icon('settings', 15)}
            <span>全局 MCP 配置 <em>(Global MCP Configuration)</em></span>
            <span class="mcp-gw-main-id mono">${esc(isNew ? 'new-server' : server.id)}</span>
          </div>
          <div class="mcp-gw-main-state">
            ${statusBadge}
            ${builtin ? ui.badge('内置服务', { tone: 'violet' }) : ''}
            ${server ? `<button type="button" class="mcp-gw-power" data-mcp-toggle title="${disabled ? '重新握手并启用' : '断开连接但保留清单'}">
              ${ui.icon('power', 13)} ${disabled ? '启用服务' : '停用服务'}
            </button>` : ''}
          </div>
        </div>

        <div class="mcp-gw-main-body">
          ${server && server.lastError && !server.online ? `<div class="mcp-alert">${esc(server.lastError)}</div>` : ''}

          <section class="mcp-gw-section">
            <div class="mcp-gw-section-title">基本配置 <span>(Basic Configuration)</span></div>
            <div class="mcp-gw-grid2">
              <label class="field"><span class="field-label">服务名称 (Name)</span>
                <input class="input" data-mcp-name value="${esc(draft.name)}" placeholder="如 supplier-1688（1688供应链专线）" autocomplete="off" />
              </label>
              <label class="field"><span class="field-label">服务 ID (Server ID)</span>
                <input class="input" data-mcp-id value="${esc(isNew ? draft.id : server.id)}" placeholder="${isNew ? '留空按 URL 自动生成' : '不可修改'}"
                  ${isNew ? '' : 'disabled'} autocomplete="off" />
              </label>
            </div>
            <div class="field mcp-gw-url-field">
              <span class="field-label">服务 URL (Endpoint)</span>
              <div class="mcp-gw-url-row">
                <input class="input mono" data-mcp-url value="${esc(draft.url)}" placeholder="http://127.0.0.1:5207" autocomplete="off" />
                <button type="button" class="mcp-gw-connect" data-mcp-connect>${ui.icon('wifi', 13)} 探活 &amp; 连接</button>
              </div>
            </div>
          </section>

          <section class="mcp-gw-section">
            <div class="mcp-gw-section-title">鉴权方式 <span>(Auth Settings)</span></div>
            <div class="mcp-gw-auth">
              ${AUTH_MODES.map(function (mode) {
                return `<label class="mcp-gw-radio">
                  <input type="radio" name="mcp-gw-auth" value="${mode.id}"${draft.authType === mode.id ? ' checked' : ''} />
                  <span>${esc(mode.label)}</span>
                </label>`;
              }).join('')}
            </div>
            ${authFieldsHtml(server)}
            ${server && String(server.authType || '').toLowerCase() === 'header'
              ? '<div class="mcp-gw-field-hint is-warn">该服务当前使用旧版「自定义 Header」鉴权；本页仅展示三档标准鉴权，保存后会切换为免签，请改用自定义 Header 或 Bearer。</div>'
              : ''}
          </section>

          <section class="mcp-gw-section">
            <div class="mcp-gw-section-head">
              <div class="mcp-gw-section-title">自定义 Header <span>(Custom Headers)</span></div>
              <button type="button" class="mcp-gw-linkbtn" data-mcp-header-add>${ui.icon('plus', 12)} 添加 Header</button>
            </div>
            <div class="mcp-gw-headers" data-mcp-headers>${headerRowsHtml()}</div>
          </section>

          <section class="mcp-gw-section mcp-gw-term-section">
            <div class="mcp-gw-section-head">
              <div class="mcp-gw-section-title">在线调试终端 <span>(Terminal)</span></div>
              <button type="button" class="mcp-gw-probe" data-mcp-probe>${ui.icon('play', 12)} 探活 &amp; 抓取 Schema</button>
            </div>
            <pre class="mcp-gw-term" data-mcp-term></pre>
          </section>
        </div>

        <div class="mcp-gw-foot">
          <button type="button" class="mcp-gw-delete" data-mcp-delete
            ${isNew || builtin || !server ? 'disabled' : ''}
            title="${builtin ? '内置服务不可删除：可改配置或停用' : (isNew ? '新建服务保存后才有删除入口' : '从声明清单移除并停用')}">
            ${ui.icon('trash', 13)} 删除服务
          </button>
          <span class="mcp-gw-note">${builtin ? '内置服务：可改配置 / 可停用，不可删除' : (isNew ? '保存后写入声明式清单并自动握手' : '外部服务：支持完整增删改')}</span>
          <span class="mcp-gw-foot-spacer"></span>
          <button type="button" class="mcp-gw-save" data-mcp-save>${isNew ? '保存配置 &amp; 首次握手' : '保存配置 &amp; 重启服务'}</button>
        </div>`;
      }

      function defaultTerminal() {
        if (!state.draft.url) return '$ 填写 Endpoint 后点击「探活 & 抓取 Schema」\n# 终端会打印 initialize / tools/list 的原始 JSON 报文';
        return '$ mcp-cli ping --url ' + state.draft.url + '\n# 点击「探活 & 抓取 Schema」发起 initialize + tools/list，原始 JSON 会打印在这里。';
      }

      function paintTerminal() {
        const term = editorEl.querySelector('[data-mcp-term]');
        if (!term) return;
        const text = state.terminal || defaultTerminal();
        term.innerHTML = text.split('\n').map(hlLine).join('\n');
        term.scrollTop = term.scrollHeight;
      }

      function paintEditor() {
        if (!editorEl) return;
        if (state.loading) {
          editorEl.innerHTML = '<div class="mcp-gw-loading">正在读取全局 MCP 配置...</div>';
          return;
        }
        if (!state.connected) {
          editorEl.innerHTML = `<div class="mcp-gw-editor-empty">
            ${ui.icon('wifi', 26)}
            <div class="mcp-gw-editor-empty-title">本地服务未连接</div>
            <div class="mcp-gw-editor-empty-desc">MCP 清单与在线调试依赖 5301 端口的本地 API 服务。</div>
            <button type="button" class="mcp-gw-retry" data-mcp-reload>重新加载</button>
          </div>`;
          return;
        }
        if (state.isNew) {
          state.draft = state.draft || blankDraft();
          editorEl.innerHTML = editorHtml(null);
          paintTerminal();
          return;
        }
        const server = current();
        if (!server) {
          editorEl.innerHTML = `<div class="mcp-gw-editor-empty">
            ${ui.icon('plugin', 26)}
            <div class="mcp-gw-editor-empty-title">选择一个 MCP 服务</div>
            <div class="mcp-gw-editor-empty-desc">从左侧选择服务，或点「+ 接入新服务」声明新的网关。</div>
          </div>`;
          return;
        }
        editorEl.innerHTML = editorHtml(server);
        paintTerminal();
      }

      function paint() {
        paintList();
        paintEditor();
        updateSubtitle();
      }

      function collectDraft() {
        const draft = state.draft;
        const q = function (sel) { return editorEl.querySelector(sel); };
        const nameEl = q('[data-mcp-name]');
        const idEl = q('[data-mcp-id]');
        const urlEl = q('[data-mcp-url]');
        const keyEl = q('[data-mcp-key-id]');
        const secretEl = q('[data-mcp-secret]');
        if (nameEl) draft.name = String(nameEl.value || '').trim();
        if (idEl) draft.id = String(idEl.value || '').trim();
        if (urlEl) draft.url = String(urlEl.value || '').trim();
        if (keyEl) draft.authKeyId = String(keyEl.value || '').trim();
        if (secretEl) draft.authSecret = String(secretEl.value || '');
        draft.headers = Array.prototype.map.call(editorEl.querySelectorAll('[data-mcp-header-row]'), function (row) {
          const key = row.querySelector('[data-mcp-header-key]');
          const value = row.querySelector('[data-mcp-header-value]');
          return {
            key: String((key && key.value) || '').trim(),
            value: String((value && value.value) || ''),
          };
        });
        return draft;
      }

      function buildPayload(opts) {
        collectDraft();
        const draft = state.draft;
        const isNew = state.isNew;
        const name = String(draft.name || '').trim();
        const url = String(draft.url || '').trim();
        if (!url) return { error: '请填写服务 URL (Endpoint)' };
        if (!/^https?:\/\/[^\s]+$/i.test(url)) return { error: '服务 URL 必须是合法的 http(s) 地址' };
        if (!opts.probe && !name) return { error: '请填写服务名称 (Name)' };

        let id = isNew ? String(draft.id || '').trim() : String(state.selectedId || '');
        if (isNew && !id) id = deriveId(url, name);
        if (!opts.probe && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
          return { error: '服务 ID 只允许小写字母 / 数字 / ._-，且以字母或数字开头' };
        }

        const mode = draft.authType;
        const hasOldSecret = !!(current() && current().hasAuthSecret);
        const hasOldKeyId = !!(current() && current().authKeyId);
        if (mode === 'bearer' && !String(draft.authSecret || '').trim() && !hasOldSecret) {
          return { error: 'Bearer 模式需要填写 Token' };
        }
        if (mode === 'hmac') {
          if (!String(draft.authKeyId || '').trim() && !hasOldKeyId) return { error: 'HMAC 模式需要填写 Key ID' };
          if (!String(draft.authSecret || '').trim() && !hasOldSecret) return { error: 'HMAC 模式需要填写 Secret' };
        }

        const headers = {};
        (draft.headers || []).forEach(function (row) {
          const key = String(row.key || '').trim();
          if (key) headers[key] = String(row.value || '');
        });

        const body = {
          name: name || String((current() && current().name) || id),
          transport: 'http',
          url: url,
          autoStart: current() ? !!current().autoStart : true,
          authType: mode,
          headers: headers,
        };
        if (id) body.id = id;
        if (mode === 'hmac') {
          if (String(draft.authKeyId || '').trim()) body.authKeyId = String(draft.authKeyId).trim();
          if (String(draft.authSecret || '').trim()) body.authSecret = String(draft.authSecret);
        } else if (mode === 'bearer') {
          if (String(draft.authSecret || '').trim()) body.authSecret = String(draft.authSecret);
        }
        return { body: body, id: id };
      }

      function appendTerm(text) {
        state.terminal = state.terminal ? state.terminal + '\n' + text : text;
        paintTerminal();
      }

      function setBusy(busy, selector, busyText) {
        state.busy = !!busy;
        const btn = selector ? editorEl.querySelector(selector) : null;
        if (!btn) return;
        if (busy) {
          if (!btn.dataset.busyHtml) btn.dataset.busyHtml = btn.innerHTML;
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span>' + esc(busyText || '处理中...');
        } else {
          btn.disabled = false;
          if (btn.dataset.busyHtml) {
            btn.innerHTML = btn.dataset.busyHtml;
            delete btn.dataset.busyHtml;
          }
        }
      }

      async function load(opts) {
        const silent = !!(opts && opts.silent);
        if (!silent) {
          state.loading = true;
          paint();
        }
        if (!api || !WB.api.available()) {
          state.loading = false;
          state.connected = false;
          state.servers = [];
          paint();
          return false;
        }
        let res;
        try { res = await api.load(); } catch (_) { res = { ok: false, error: '请求异常' }; }
        state.loading = false;
        if (!res.ok) {
          state.connected = false;
          state.servers = [];
          paint();
          if (!silent) toast('加载失败：' + (res.error || '本地服务未连接'), 'warn');
          return false;
        }
        state.connected = true;
        state.servers = api.apply(res.servers, res.tools) || [];
        const target = state.servers.find(function (s) { return s.id === state.selectedId; }) || state.servers[0] || null;
        if (target) {
          state.selectedId = target.id;
          state.isNew = false;
          state.draft = draftFromServer(target);
        } else if (!state.isNew) {
          state.selectedId = null;
          state.isNew = true;
          state.draft = blankDraft();
        }
        paint();
        return true;
      }

      async function runProbe() {
        if (state.busy) return;
        const built = buildPayload({ probe: true });
        if (built.error) { toast(built.error, 'warn'); return; }
        const body = built.body;
        const started = Date.now();
        setBusy(true, '[data-mcp-probe]', '探活中...');
        appendTerm('$ mcp-cli ping --url ' + body.url);
        appendTerm('[' + stamp() + '] → POST ' + body.url.replace(/\/$/, '') + '/mcp  (initialize → tools/list)');
        let res;
        try { res = await api.probe(body); } catch (_) { res = { ok: false, error: '请求异常' }; }
        setBusy(false, '[data-mcp-probe]', '');
        const ms = Date.now() - started;
        if (!res.ok) {
          appendTerm('[' + stamp() + '] ← ERROR ' + (res.error || '探活失败'));
          toast('探活失败：' + (res.error || '服务不可达'), 'warn');
          return;
        }
        const data = res.data || {};
        appendTerm('[' + stamp() + '] ← 200 OK (' + ms + 'ms) · protocol=' + (data.protocolVersion || '?') +
          ' · server=' + (data.serverName || '?') + (data.serverVersion ? ' ' + data.serverVersion : ''));
        appendTerm('[' + stamp() + '] initialize (raw):');
        appendTerm(pretty(data.raw && data.raw.initialize));
        appendTerm('[' + stamp() + '] tools/list (raw):');
        appendTerm(pretty(data.raw && data.raw.toolsList));
        appendTerm('[' + stamp() + '] 已加载工具 (' + (data.toolCount || 0) + '): ' +
          (data.tools || []).map(function (t) { return t.name; }).join(', '));
        toast('探活成功 · ' + (data.toolCount || 0) + ' 个工具', 'success');
      }

      async function saveServer() {
        if (state.busy) return;
        const built = buildPayload({ probe: false });
        if (built.error) { toast(built.error, 'warn'); return; }
        const body = built.body;
        const isNew = state.isNew;
        setBusy(true, '[data-mcp-save]', '保存中...');
        let res;
        try {
          res = isNew ? await api.create(body) : await api.update(state.selectedId, body);
        } catch (_) { res = { ok: false, error: '请求异常' }; }
        setBusy(false, '[data-mcp-save]', '');
        if (!res.ok) {
          appendTerm('[' + stamp() + '] ← 保存失败：' + (res.error || '服务未连接'));
          toast((isNew ? '接入失败：' : '保存失败：') + (res.error || '服务未连接'), 'warn');
          return;
        }
        const data = res.data || {};
        const id = data.id || built.id;
        state.selectedId = id;
        state.isNew = false;
        appendTerm('[' + stamp() + '] ← 配置已写入清单 · ' + (data.connected ? '握手成功' : '握手失败'));
        appendTerm(pretty(data.snapshot || data));
        await load({ silent: true });
        toast(data.connected
          ? (isNew ? '接入成功，已握手并拉取工具' : '配置已保存并重新握手成功')
          : '配置已保存，但握手失败（可稍后重试）', data.connected ? 'success' : 'warn');
      }

      async function probeAndSave() {
        if (state.busy) return;
        const built = buildPayload({ probe: false });
        if (built.error) { toast(built.error, 'warn'); return; }
        await saveServer();
      }

      async function toggleServer() {
        const server = current();
        if (!server || state.busy) return;
        const disabled = String(server.state || '').toLowerCase() === 'disabled';
        if (!disabled) {
          const ok = await ui.confirm({
            title: '停用 ' + server.name + '？',
            desc: '运行时断开并清空工具缓存，清单保留；随时可点「启用服务」重新握手。',
            ok: '停用',
            tone: 'danger',
          });
          if (!ok) return;
          const res = await api.disconnect(server.id);
          if (!res.ok) { toast('停用失败：' + (res.error || '服务未连接'), 'warn'); return; }
          toast(server.name + ' 已停用（清单保留）', 'success');
        } else {
          const res = await api.handshake(server.id);
          if (!res.ok) { toast('启用失败：' + (res.error || '服务不可达'), 'warn'); return; }
          toast(server.name + ' 已启用并握手成功', 'success');
        }
        await load({ silent: true });
      }

      async function deleteServer() {
        const server = current();
        if (!server || state.busy) return;
        if (server.builtin) { toast('内置服务不可删除：可改配置或停用', 'warn'); return; }
        const ok = await ui.confirm({
          title: '删除 ' + server.name + '？',
          desc: '将从声明清单移除该服务并停用运行时（数据保留，可重新接入）。',
          ok: '删除',
          tone: 'danger',
        });
        if (!ok) return;
        const res = await api.remove(server.id);
        if (!res.ok) { toast('删除失败：' + (res.error || '服务未连接'), 'warn'); return; }
        state.selectedId = null;
        state.isNew = false;
        await load({ silent: true });
        toast(server.name + ' 已从清单移除', 'success');
      }

      function selectServer(id) {
        const server = findServer(id);
        if (!server) return;
        state.selectedId = id;
        state.isNew = false;
        state.draft = draftFromServer(server);
        state.terminal = '';
        paint();
      }

      /* ------------------------------ 事件 ------------------------------ */

      root.addEventListener('click', function (e) {
        if (e.target.closest('[data-mcp-new]')) {
          state.isNew = true;
          state.selectedId = null;
          state.draft = blankDraft();
          state.terminal = '';
          paint();
          return;
        }
        if (e.target.closest('[data-mcp-reload]')) {
          load();
          return;
        }
        const card = e.target.closest('[data-mcp-select]');
        if (card) {
          selectServer(card.dataset.mcpSelect);
          return;
        }
        if (e.target.closest('[data-mcp-header-add]')) {
          collectDraft();
          state.draft.headers.push({ key: '', value: '' });
          paintEditor();
          const rows = editorEl.querySelectorAll('[data-mcp-header-key]');
          if (rows.length) rows[rows.length - 1].focus();
          return;
        }
        const delHeader = e.target.closest('[data-mcp-header-del]');
        if (delHeader) {
          collectDraft();
          state.draft.headers.splice(Number(delHeader.dataset.mcpHeaderDel), 1);
          paintEditor();
          return;
        }
        if (e.target.closest('[data-mcp-probe]')) {
          runProbe();
          return;
        }
        if (e.target.closest('[data-mcp-connect]')) {
          probeAndSave();
          return;
        }
        if (e.target.closest('[data-mcp-save]')) {
          saveServer();
          return;
        }
        if (e.target.closest('[data-mcp-toggle]')) {
          toggleServer();
          return;
        }
        if (e.target.closest('[data-mcp-delete]')) {
          deleteServer();
        }
      });

      root.addEventListener('input', function (e) {
        if (e.target.matches('[data-mcp-search]')) {
          state.keyword = String(e.target.value || '');
          paintList();
          return;
        }
        if (e.target.matches('[data-mcp-name]')) state.draft.name = e.target.value;
        if (e.target.matches('[data-mcp-id]')) state.draft.id = e.target.value;
        if (e.target.matches('[data-mcp-url]')) state.draft.url = e.target.value;
        if (e.target.matches('[data-mcp-key-id]')) state.draft.authKeyId = e.target.value;
        if (e.target.matches('[data-mcp-secret]')) state.draft.authSecret = e.target.value;
      });

      root.addEventListener('change', function (e) {
        if (e.target.matches('input[name="mcp-gw-auth"]')) {
          collectDraft();
          state.draft.authType = e.target.value;
          paintEditor();
        }
      });

      load();
    },
  };
})();
