'use strict';

/**
 * Agent 团队管理页（纯界面演示）。
 * 数据：WB.data.agents（6 位 Agent） + WB.data.team.stats（统计条）。
 * 交互：搜索过滤 / 新建 Agent modal / 进入工作台 toast / 设置与记忆 modal。
 */
(function () {
  const WB = window.WB;
  const ui = WB.ui;
  const pages = (WB.pages = WB.pages || {});

  // 卡片顶部渐变光 / hover 描边使用的色值（RGB 三元组，供 rgba(var(--tone-rgb), a) 使用）。
  const TONE_RGB = {
    green: '52, 211, 153',
    cyan: '34, 211, 238',
    blue: '96, 165, 250',
    violet: '167, 139, 250',
    amber: '251, 191, 36',
    rose: '251, 113, 133',
  };

  function avatarHtml(agent) {
    // 真实头像由 Lead 生成：renderer/assets/avatars/<id>.svg（commander/scout/…）。
    return ui.avatar(agent, 'lg');
  }

  /** MCP 工具字符串按「·」拆成多个 chip，例：'1688 API · 比价 MCP'。 */
  function mcpChips(mcp) {
    return String(mcp || '')
      .split('·')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => ui.chip(item))
      .join('');
  }

  /** 统计条右侧的绿色趋势小折线（纯内联 SVG，呼应参考稿的 sparkline）。 */
  function sparkline() {
    return `<svg class="team-spark" width="26" height="14" viewBox="0 0 26 14" aria-hidden="true">
      <path d="M1.5 11.5 L7 8.5 L12 10 L18 5.5 L24 3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="24" cy="3" r="2.1" fill="currentColor" />
    </svg>`;
  }

  function toolbarHtml(stats) {
    const items = (stats || [])
      .map((s) => {
        const ok = s.dot === 'online';
        return `<div class="team-stat${ok ? ' team-stat--ok' : ''}">
          <span class="team-stat-label">${ui.esc(s.label)}</span>
          <span class="team-stat-value num">${ui.esc(String(s.value).replace(/\s*\/\s*/g, '/'))}</span>
          ${s.suffix ? `<span class="team-stat-suffix">${ui.esc(s.suffix)}</span>` : ''}
          ${s.dot ? `<i class="status-dot ${ui.esc(s.dot)}"></i>` : ''}
          ${s.delta ? `<span class="team-delta" title="${ui.esc(s.delta)}">${sparkline()}</span>` : ''}
        </div>`;
      })
      .join('');

    return `<div class="team-toolbar">
      <div class="team-stats">${items}</div>
      <div class="team-tools">
        ${ui.iconBtn('filter', { title: '筛选 Agent', attrs: 'data-team-filter' })}
        ${ui.searchBox({
          placeholder: '搜索 Agent...',
          width: '224px',
          attrs: 'id="team-search" data-team-search autocomplete="off" spellcheck="false"',
        })}
        ${ui.btn({ label: '新建 Agent', icon: 'plus', tone: 'primary', size: 'sm', attrs: 'data-team-new' })}
      </div>
    </div>`;
  }

  function cardHtml(agent) {
    const tone = TONE_RGB[agent.tone] ? agent.tone : 'cyan';
    const searchText = [agent.name, agent.en, agent.desc, agent.mcp, agent.status].join(' ').toLowerCase();

    return `<article class="team-card" data-team-card data-search="${ui.esc(searchText)}"
      style="--tone-rgb:${TONE_RGB[tone]}">
      <div class="team-card-head">
        <span class="team-avatar">${avatarHtml(agent)}</span>
        <div class="team-ident">
          <div class="team-name-row">
            <span class="team-name" title="${ui.esc(agent.name)}">${ui.esc(agent.name)}</span>
            <span class="team-en">${ui.esc(agent.en)}</span>
          </div>
          <div class="team-desc" title="${ui.esc(agent.desc)}">${ui.esc(agent.desc)}</div>
        </div>
        <span class="team-badge">${ui.badge(agent.status, { tone: agent.tone, dot: true })}</span>
      </div>

      <div class="team-status">
        <span class="team-status-label">状态中：</span>
        <span class="team-status-text">${ui.esc(agent.status)} · 当前负载 ${ui.esc(agent.load)}%</span>
      </div>

      <div class="team-mcp">
        <span class="team-mcp-label">绑定的 MCP 工具：</span>
        ${mcpChips(agent.mcp)}
      </div>

      <div class="team-meta">
        <span><span class="team-meta-label">已沉淀规则：</span><b class="num">${ui.num(agent.rules)}</b><span>条</span></span>
        <span><span class="team-meta-label">${ui.esc(agent.todayLabel)}：</span><b class="num">${ui.num(agent.today)}</b></span>
      </div>

      <div class="team-actions">
        ${ui.btn({ label: '进入工作台', tone: 'primary', size: 'sm', attrs: `data-team-enter="${ui.esc(agent.id)}"` })}
        ${ui.btn({ label: '设置与记忆', tone: 'ghost', size: 'sm', attrs: `data-team-memory="${ui.esc(agent.id)}"` })}
      </div>
    </article>`;
  }

  /* ------------------------------ 新建 Agent ------------------------------ */
  function openCreateModal(ctx) {
    const servers = (ctx.data.mcp && ctx.data.mcp.servers) || [];
    const mcpOptions = servers.map((server) => `${server.name}${server.online ? '' : '（待接入）'}`);
    const modelOptions = (ctx.data.settings && ctx.data.settings.modelOptions) || [];

    const body = `<div class="team-form">
      <label class="field"><span class="field-label">Agent 名称</span>${ui.input({
        placeholder: '例如：选品专员',
        attrs: 'id="team-new-name" maxlength="24"',
      })}</label>
      <label class="field"><span class="field-label">英文标识</span>${ui.input({
        placeholder: '例如：Picker',
        attrs: 'id="team-new-en" maxlength="24"',
      })}</label>
      <label class="field team-form-wide"><span class="field-label">职责描述</span>${ui.input({
        placeholder: '一句话说明该 Agent 负责的环节',
        attrs: 'id="team-new-desc" maxlength="60"',
      })}</label>
      <label class="field"><span class="field-label">绑定 MCP 工具</span>${ui.select({
        options: mcpOptions,
        attrs: 'id="team-new-mcp"',
      })}</label>
      <label class="field"><span class="field-label">默认模型</span>${ui.select({
        options: modelOptions,
        attrs: 'id="team-new-model"',
      })}</label>
      <div class="team-form-wide">${ui.checkbox({
        label: '启用记忆自动沉淀（演示）',
        checked: true,
        attrs: 'id="team-new-memory"',
      })}</div>
    </div>`;

    const overlay = ui.modal({
      title: '新建 Agent',
      desc: '为团队新增一位协同 Agent。当前为纯界面演示，提交后只生成本地草稿，不会写入任何配置。',
      body,
      actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}${ui.btn({
        label: '创建 Agent',
        tone: 'primary',
        icon: 'plus',
        attrs: 'data-team-create',
      })}`,
    });

    overlay.querySelector('[data-team-create]').addEventListener('click', () => {
      const nameInput = overlay.querySelector('#team-new-name');
      const name = nameInput ? nameInput.value.trim() : '';
      if (!name) {
        ctx.toast('请先填写 Agent 名称', 'warn');
        if (nameInput) nameInput.focus();
        return;
      }
      overlay.close();
      ctx.toast(`已创建「${name}」Agent 草稿（演示模式）`, 'success');
    });
  }

  /* ------------------------------ 设置与记忆 ------------------------------ */
  function openMemoryModal(agent, ctx) {
    const body = `${ui.kv([
      ['Agent', `${ui.esc(agent.name)} · ${ui.esc(agent.en)}`],
      ['绑定 MCP 工具', ui.esc(agent.mcp)],
      [
        '记忆沉淀',
        `<b class="num">${ui.num(agent.rules)}</b> 条规则 · ${ui.esc(agent.todayLabel)} <b class="num">${ui.num(agent.today)}</b> 次`,
      ],
    ])}
    <div class="divider mt-16"></div>
    <div class="team-mem-switches">
      ${ui.switchControl({ label: '记忆自动沉淀', checked: true, attrs: 'data-team-mem' })}
      ${ui.switchControl({ label: '规则反思优化', checked: true, attrs: 'data-team-rule' })}
    </div>
    <div class="field-hint mt-8">演示模式：开关仅做界面状态演示，不会写入本地记忆文件。</div>`;

    const overlay = ui.modal({
      title: `设置与记忆 · ${agent.name}`,
      desc: '查看该 Agent 已沉淀的规则与今日调用，并演示记忆开关。',
      body,
      actions: `${ui.btn({ label: '关闭', tone: 'ghost', attrs: 'data-modal-close' })}${ui.btn({
        label: '保存设置',
        tone: 'primary',
        attrs: 'data-team-save',
      })}`,
    });

    overlay.querySelector('[data-team-save]').addEventListener('click', () => {
      overlay.close();
      ctx.toast(`已更新「${agent.name}」的记忆与规则设置（演示模式）`, 'success');
    });
  }

  /* ------------------------------ 页面注册 ------------------------------ */
  pages.agents = {
    title: 'Agent 团队管理',
    subtitle: '',
    actions: ui.userCluster(),

    render(ctx) {
      const agents = ctx.data.agents || [];
      const stats = (ctx.data.team && ctx.data.team.stats) || [];
      return `<div class="team-page">
        ${toolbarHtml(stats)}
        <div class="team-grid" id="team-grid">${agents.map(cardHtml).join('')}</div>
        <div class="team-empty is-hidden" id="team-empty">
          <span class="team-empty-ico">${ui.icon('search', 22)}</span>
          <div class="team-empty-title">没有匹配的 Agent</div>
          <div class="team-empty-desc">换个关键词试试，支持按名称、英文名或绑定的 MCP 工具搜索。</div>
        </div>
      </div>`;
    },

    mount(root, ctx) {
      const page = root.querySelector('.team-page');
      if (!page) return;

      const agents = ctx.data.agents || [];
      const findAgent = (id) => agents.find((agent) => agent.id === id);

      /* 搜索过滤：名称 / 英文名 / 描述 / MCP 工具 / 状态 */
      const search = page.querySelector('[data-team-search]');
      const cards = Array.from(page.querySelectorAll('[data-team-card]'));
      const empty = page.querySelector('#team-empty');

      const applyFilter = () => {
        const keyword = search ? search.value.trim().toLowerCase() : '';
        let shown = 0;
        cards.forEach((card) => {
          const hit = !keyword || (card.dataset.search || '').includes(keyword);
          card.classList.toggle('is-hidden', !hit);
          if (hit) shown += 1;
        });
        if (empty) empty.classList.toggle('is-hidden', shown > 0);
      };

      if (search) search.addEventListener('input', applyFilter);

      /* 筛选按钮（演示） */
      ui.bind(page, '[data-team-filter]', 'click', () => {
        ctx.toast('筛选条件：全部 6 位 Agent 均在线（演示模式）', 'info');
      });

      /* 新建 Agent */
      ui.bind(page, '[data-team-new]', 'click', () => openCreateModal(ctx));

      /* 进入工作台 */
      ui.bind(page, '[data-team-enter]', 'click', (e) => {
        const agent = findAgent(e.currentTarget.getAttribute('data-team-enter'));
        if (agent) ctx.toast(`已进入「${agent.name}」工作台（演示模式）`, 'success');
      });

      /* 设置与记忆 */
      ui.bind(page, '[data-team-memory]', 'click', (e) => {
        const agent = findAgent(e.currentTarget.getAttribute('data-team-memory'));
        if (agent) openMemoryModal(agent, ctx);
      });
    },
  };
})();
