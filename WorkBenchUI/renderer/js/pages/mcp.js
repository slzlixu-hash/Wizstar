'use strict';

/**
 * MCP 插件管理页（纯界面演示）。
 * 数据来自 WB.data.mcp：8 个本机 MCP 服务（4 在线 / 4 待接入）。
 * 交互（全部为前端演示）：筛选 / 搜索 / 类型过滤 / 健康探测 / 卡片切换调试服务 /
 * 右侧调试抽屉终端 JSON 着色 / 运行测试追加一行结果 / 关闭抽屉。
 */
(function () {
  const WB = window.WB;
  const ui = WB.ui;
  const pages = (WB.pages = WB.pages || {});

  /* 卡片图标与色调（按数据顺序展示 8 个服务，图标仅作视觉区分） */
  const CARD_ICONS = ['shop', 'shop', 'globe', 'server', 'link', 'shop', 'sparkles', 'database'];
  const CARD_TONES = ['cyan', 'blue', 'violet', 'green', 'amber', 'slate', 'rose', 'cyan'];
  const STAT_ICONS = ['plugin', 'wifi', 'link', 'zap'];

  const FILTERS = [
    { id: 'all', label: '全部' },
    { id: 'online', label: '在线' },
    { id: 'pending', label: '待接入' },
  ];

  const TYPE_OPTIONS = [
    { value: 'all', label: '全部类型' },
    { value: 'http', label: 'HTTP 服务' },
    { value: 'system', label: '系统级环境' },
    { value: 'pending', label: '待接入配置' },
  ];

  /* ------------------------------ 数据小工具 ------------------------------ */

  function transportHost(transport) {
    const m = /(\d{1,3}(?:\.\d{1,3}){3}:\d+)/.exec(String(transport || ''));
    return m ? m[1] : '';
  }

  function typeOf(server) {
    const t = String(server.transport || '');
    if (t.indexOf('系统级') === 0) return 'system';
    if (t.indexOf('待接入') === 0) return 'pending';
    return 'http';
  }

  /** 从 log 里推导一个默认工具名（纯展示用）。 */
  function defaultTool(server) {
    const log = server.log || [];
    for (let i = 0; i < log.length; i += 1) {
      const m = /"name"\s*:\s*"([^"]+)"/.exec(String(log[i] && log[i][0] ? log[i][0] : ''));
      if (m) return m[1];
    }
    return 'tools/list';
  }

  /* ------------------------------ 终端 JSON 着色 ------------------------------ */

  /** 逐行高亮：key → .t-key，字符串 → .t-str，数字 → .t-num。 */
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

  function termHtml(server) {
    const log = server.log || [];
    if (!log.length) {
      return '<div class="mcp-t-line t-dim">// 该服务尚未握手，暂无 MCP 调用日志</div>';
    }
    return log
      .map((row) => `<div class="mcp-t-line">${hlLine(row && row[0] != null ? row[0] : '')}</div>`)
      .join('');
  }

  /* ------------------------------ 统计卡 ------------------------------ */

  function statCard(stat, i) {
    const tone = stat.tone || 'cyan';
    const dot = tone === 'green' || tone === 'amber' ? '<i class="mcp-stat__dot"></i>' : '';
    return `<section class="card mcp-stat mcp-tone-${ui.esc(tone)}">
      <div class="mcp-stat__top">
        <span class="mcp-stat__ico">${ui.icon(STAT_ICONS[i] || 'plugin', 15)}</span>
        <span class="mcp-stat__label">${ui.esc(stat.label)}</span>
      </div>
      <div class="mcp-stat__value num">${ui.esc(stat.value)}<span class="mcp-stat__unit">${ui.esc(stat.unit || '')}</span>${dot}</div>
    </section>`;
  }

  /* ------------------------------ 服务卡 ------------------------------ */

  function cardHtml(server, activeId, i) {
    const icon = CARD_ICONS[i] || 'server';
    const tone = CARD_TONES[i] || 'cyan';
    const online = !!server.online;
    const status = ui.statusDot(online ? 'online' : 'offline', server.tools);
    const actions = online
      ? `<button type="button" class="mcp-act" data-act="health">健康检测</button>
         <button type="button" class="mcp-act" data-act="config">配置</button>
         <button type="button" class="mcp-act mcp-act--danger" data-act="disconnect">断开连接</button>`
      : `<button type="button" class="mcp-act" data-act="config">配置连接</button>`;

    return `<article class="card mcp-card${online ? '' : ' mcp-card--off'}${server.id === activeId ? ' is-active' : ''}" data-server="${ui.esc(server.id)}">
      <header class="mcp-card__head">
        <span class="mcp-ico mcp-tone-${ui.esc(tone)}">${ui.icon(icon, 19)}</span>
        <div class="mcp-card__ident">
          <div class="mcp-card__name" title="${ui.esc(server.name)}">${ui.esc(server.name)}</div>
          <div class="mcp-card__slug mono">${ui.esc(server.slug)}</div>
        </div>
        ${online ? ui.badge('在线', { tone: 'green', dot: true }) : ui.badge('待接入', { tone: 'slate', dot: true })}
      </header>
      <div class="mcp-card__body">
        <dl class="mcp-kv">
          <dt>传输</dt>
          <dd class="mono" title="${ui.esc(server.transport)}">${ui.esc(server.transport)}</dd>
          <dt>状态</dt>
          <dd>${status}</dd>
          <dt>绑定</dt>
          <dd title="${ui.esc(server.bind)}">${ui.esc(server.bind)}</dd>
          <dt>风险等级</dt>
          <dd>${ui.badge(server.risk, { tone: server.riskTone })}</dd>
        </dl>
        <div class="mcp-card__acts">${actions}</div>
      </div>
    </article>`;
  }

  /* ------------------------------ 调试抽屉 ------------------------------ */

  function drawerHtml(server) {
    const online = !!server.online;
    const host = transportHost(server.transport);
    const endpoint = online && host ? `http://${host}` : '尚未配置传输地址';
    return `<div class="mcp-drawer__head">
        <div class="mcp-drawer__heading">
          <div class="mcp-drawer__title">${ui.esc(server.name)} · 调试测试</div>
          <div class="mcp-drawer__slug mono">${ui.esc(server.slug)}</div>
        </div>
        ${ui.iconBtn('close', { title: '关闭调试', attrs: 'data-mcp-close' })}
      </div>
      <div class="mcp-drawer__body">
        <div class="mcp-endpoint ${online ? 'is-online' : 'is-off'}">
          <i class="status-dot ${online ? 'online' : 'offline'}"></i>
          <span class="mcp-endpoint__state">${online ? '在线' : '待接入'} ·</span>
          <span class="mcp-endpoint__addr mono">${ui.esc(endpoint)}</span>
          ${online && host ? '<span class="mcp-endpoint__probe mono">GET /healthz</span>' : ''}
        </div>
        ${ui.input({
          placeholder: '调用工具选择 (e.g., search_items)',
          value: defaultTool(server),
          attrs: 'data-mcp-tool',
        })}
        <div class="mcp-drawer__selects">
          <div class="mcp-select">${ui.select({ options: ['全部状态', '只读工具', '写入工具'], attrs: 'data-mcp-scope' })}</div>
          <div class="mcp-select">${ui.select({ options: ['全部安全级', '安全', '敏感'], attrs: 'data-mcp-safe' })}</div>
        </div>
        <div class="mcp-term">
          <div class="mcp-term__head">
            <span>${ui.icon('terminal', 13)} terminal</span>
            <span class="mono">JSON-RPC</span>
          </div>
          <div class="terminal mcp-term__body" data-mcp-term>${termHtml(server)}</div>
        </div>
      </div>
      <div class="mcp-drawer__foot">
        ${ui.btn({ label: '运行测试', tone: 'primary', icon: 'play', attrs: 'data-mcp-run', cls: 'mcp-run' })}
        ${ui.btn({ label: '关闭调试', tone: 'ghost', attrs: 'data-mcp-close' })}
      </div>`;
  }

  /* ------------------------------ 页面注册 ------------------------------ */

  pages.mcp = {
    title: 'MCP 插件管理',
    subtitle: '本机 MCP 服务注册与握手状态（演示数据）',
    actions: ui.btn({
      label: '接入新 MCP 服务',
      icon: 'plus',
      tone: 'primary',
      attrs: 'data-mcp-add',
    }),

    render(ctx) {
      const mcp = ctx.data.mcp;
      const first = mcp.servers[0];
      return `<div class="mcp-page">
        <div class="mcp-main">
          <div class="mcp-stats">${mcp.stats.map(statCard).join('')}</div>
          <div class="mcp-toolbar">
            ${ui.segmented(FILTERS, 'all', 'data-mcp-filter')}
            ${ui.btn({
              label: '全部健康探测 (GET /healthz)',
              tone: 'ghost',
              size: 'sm',
              icon: 'refresh',
              attrs: 'data-mcp-probe',
              cls: 'mcp-probe',
            })}
            <div class="mcp-toolbar__right">
              ${ui.searchBox({ placeholder: '搜索服务名称…', width: '156px', attrs: 'data-mcp-search' })}
              <div class="mcp-type">${ui.select({ options: TYPE_OPTIONS, value: 'all', attrs: 'data-mcp-type' })}</div>
            </div>
          </div>
          <div class="mcp-grid" data-mcp-grid>${mcp.servers
            .map((s, i) => cardHtml(s, first.id, i))
            .join('')}</div>
        </div>
        <aside class="mcp-drawer" data-mcp-drawer>${drawerHtml(first)}</aside>
      </div>`;
    },

    mount(root, ctx) {
      const servers = ctx.data.mcp.servers;
      const grid = root.querySelector('[data-mcp-grid]');
      const drawer = root.querySelector('[data-mcp-drawer]');
      const filterBtns = root.querySelectorAll('[data-mcp-filter]');
      const typeSel = root.querySelector('[data-mcp-type]');
      const search = root.querySelector('[data-mcp-search]');
      const probe = root.querySelector('[data-mcp-probe]');

      const state = {
        serviceId: servers[0] ? servers[0].id : '',
        filter: 'all',
        type: 'all',
        keyword: '',
      };

      const current = () => servers.find((s) => s.id === state.serviceId) || servers[0];

      function filtered() {
        const kw = state.keyword;
        return servers.filter((s) => {
          if (state.filter === 'online' && !s.online) return false;
          if (state.filter === 'pending' && s.online) return false;
          if (state.type !== 'all' && typeOf(s) !== state.type) return false;
          if (kw) {
            const hay = [s.name, s.slug, s.transport, s.bind, s.note, s.risk, s.tools]
              .join(' ')
              .toLowerCase();
            if (hay.indexOf(kw) === -1) return false;
          }
          return true;
        });
      }

      function paintGrid() {
        const rows = filtered();
        grid.innerHTML = rows.length
          ? rows.map((s) => cardHtml(s, state.serviceId, servers.indexOf(s))).join('')
          : `<div class="mcp-empty">${ui.icon('search', 24)}
              <div class="mcp-empty__title">没有匹配的 MCP 服务</div>
              <div class="tiny dim">试试清空关键词，或切换「全部 / 在线 / 待接入」筛选。</div>
            </div>`;
      }

      function paintDrawer() {
        const server = current();
        if (!server) return;
        drawer.innerHTML = drawerHtml(server);
        drawer.hidden = false;
      }

      function openService(id) {
        state.serviceId = id;
        paintGrid();
        paintDrawer();
      }

      function appendRunResult() {
        const server = current();
        const term = drawer.querySelector('[data-mcp-term]');
        const input = drawer.querySelector('[data-mcp-tool]');
        if (!server || !term) return;
        const stamp = new Date().toTimeString().slice(0, 8);
        if (!server.online) {
          const line = document.createElement('div');
          line.className = 'mcp-t-line mcp-t-line--run';
          line.innerHTML = `<span class="t-dim">[${stamp}]</span> <span class="t-dim">transport error: MCP 服务尚未握手，未发送请求</span>`;
          term.appendChild(line);
          term.scrollTop = term.scrollHeight;
          ui.toast(`${server.name} 尚未接入，无法运行测试`, 'warn');
          return;
        }
        const tool = String((input && input.value) || defaultTool(server)).trim();
        const ms = 18 + Math.round(Math.random() * 46);
        const line = document.createElement('div');
        line.className = 'mcp-t-line mcp-t-line--run';
        line.innerHTML =
          `<span class="t-dim">[${stamp}]</span> { ` +
          `<span class="t-key">"method"</span>: <span class="t-str">"tools/call"</span>, ` +
          `<span class="t-key">"name"</span>: <span class="t-str">"${ui.esc(tool)}"</span>, ` +
          `<span class="t-key">"status"</span>: <span class="t-str">"success"</span>, ` +
          `<span class="t-key">"duration"</span>: <span class="t-num">${ms}</span> }`;
        term.appendChild(line);
        term.scrollTop = term.scrollHeight;
        ui.toast(`${server.name} · ${tool} 调用成功（${ms}ms）`, 'success');
      }

      function openConfigModal(server) {
        ui.modal({
          title: `${server.name} · 配置`,
          desc: '演示界面：MCP 服务配置项占位，不会写入任何本地配置。',
          body: ui.kv([
            ['服务 ID', `<span class="mono">${ui.esc(server.slug)}</span>`],
            ['传输地址', `<span class="mono">${ui.esc(server.transport)}</span>`],
            ['绑定 Agent', ui.esc(server.bind)],
            ['风险等级', ui.badge(server.risk, { tone: server.riskTone })],
            ['工具说明', ui.esc(server.note)],
          ]),
          actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}${ui.btn({
            label: '保存配置',
            tone: 'primary',
            attrs: 'data-toast="配置已保存（演示）" data-modal-close',
          })}`,
        });
      }

      function handleAction(action, server) {
        if (!server) return;
        if (action === 'health') {
          if (!server.online) {
            ui.toast(`${server.name} 尚未接入，无法探测`, 'warn');
            return;
          }
          const latency = String(server.health || '').split('·').pop().trim();
          ui.toast(`${server.name} · 健康检测通过（${latency}）`, 'success');
          return;
        }
        if (action === 'config') {
          openConfigModal(server);
          return;
        }
        if (action === 'disconnect') {
          ui.confirm({
            title: `断开 ${server.name}？`,
            desc: '演示操作：仅展示前端确认流程，不会真正断开 MCP 连接，也不会修改本地配置。',
            ok: '断开连接',
            cancel: '取消',
            tone: 'danger',
          }).then((ok) => {
            if (ok) ui.toast(`${server.name} 已断开连接（演示）`, 'success');
          });
        }
      }

      /* 卡片：点击切换调试服务；卡片内操作按钮单独处理 */
      grid.addEventListener('click', (e) => {
        const card = e.target.closest('[data-server]');
        if (!card) return;
        const server = servers.find((s) => s.id === card.dataset.server);
        if (!server) return;
        const act = e.target.closest('[data-act]');
        if (act) {
          e.stopPropagation();
          handleAction(act.dataset.act, server);
          return;
        }
        openService(server.id);
      });

      /* 工具条：在线状态筛选 */
      filterBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
          filterBtns.forEach((b) => b.classList.toggle('active', b === btn));
          state.filter = btn.dataset.mcpFilter;
          paintGrid();
        });
      });

      /* 工具条：服务类型下拉 */
      if (typeSel) {
        typeSel.addEventListener('change', () => {
          state.type = typeSel.value;
          paintGrid();
        });
      }

      /* 工具条：搜索 */
      if (search) {
        search.addEventListener('input', () => {
          state.keyword = String(search.value || '').trim().toLowerCase();
          paintGrid();
        });
      }

      /* 工具条：全部健康探测 */
      if (probe) {
        probe.addEventListener('click', () => {
          if (probe.disabled) return;
          const label = probe.querySelector('span');
          const text = label ? label.textContent : '';
          probe.disabled = true;
          if (label) label.textContent = '探测中…';
          setTimeout(() => {
            probe.disabled = false;
            if (label) label.textContent = text;
            const onlineCount = servers.filter((s) => s.online).length;
            ui.toast(
              `健康探测完成：${onlineCount} 个服务握手正常，${servers.length - onlineCount} 个待接入未响应`,
              'success'
            );
          }, 900);
        });
      }

      /* 抽屉：关闭 / 运行测试（事件委托，抽屉内容重绘后仍有效） */
      drawer.addEventListener('click', (e) => {
        if (e.target.closest('[data-mcp-close]')) {
          drawer.hidden = true;
          return;
        }
        if (e.target.closest('[data-mcp-run]')) {
          appendRunResult();
        }
      });

      drawer.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.closest('[data-mcp-tool]')) {
          appendRunResult();
        }
      });

      /* 页头：+ 接入新 MCP 服务 */
      const addBtn = document.querySelector('[data-mcp-add]');
      if (addBtn) {
        addBtn.addEventListener('click', () => {
          ui.modal({
            title: '接入新 MCP 服务',
            desc: '登记本机 MCP 服务并完成工具握手。演示界面不会写入任何本地配置，也不会发起真实请求。',
            body: `<div class="mcp-form">
              <label class="field"><span class="field-label">服务名称</span>${ui.input({ placeholder: '如：1688 货源专线' })}</label>
              <label class="field"><span class="field-label">传输地址</span>${ui.input({ placeholder: '如：127.0.0.1:5207' })}</label>
              <label class="field"><span class="field-label">传输协议</span>${ui.select({ options: ['HTTP (JSON-RPC)', 'SSE', 'stdio'] })}</label>
              <div class="mcp-form__note">保存后将读取服务能力清单（tools/list），并按风险等级写入工具注册表；敏感工具默认需要人工审批（HITL）。</div>
            </div>`,
            actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}${ui.btn({
              label: '创建并握手',
              tone: 'primary',
              attrs: 'data-toast="已创建 MCP 服务（演示）" data-modal-close',
            })}`,
          });
        });
      }
    },
  };
})();
