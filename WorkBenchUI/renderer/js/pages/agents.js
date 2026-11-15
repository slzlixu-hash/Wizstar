'use strict';

/**
 * Agent 团队管理页
 *
 * 数据：WB.data.agents（GET /api/ui/bootstrap 的真实名册）+ WB.data.team.stats（GET /api/agents/stats）
 * 交互：
 *   - 搜索 / 状态筛选：前端过滤真实名册
 *   - 进入工作台：右滑 Agent 工作台（对话 / 记忆 / 上下文 / 配置），全部走真实接口
 *   - 查看配置：直接打开工作台的「配置」分区
 *
 * 名册由 `config/agents.yaml` 声明式管理，本页不提供「新建 Agent」——没有写入端点就不给假按钮。
 */
(function () {
  const WB = window.WB;
  const ui = WB.ui;
  const pages = (WB.pages = WB.pages || {});

  const TONE_RGB = {
    green: '52, 211, 153',
    cyan: '34, 211, 238',
    blue: '96, 165, 250',
    violet: '167, 139, 250',
    amber: '251, 191, 36',
    rose: '251, 113, 133',
    slate: '148, 163, 184',
  };

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
        ${ui.iconBtn('filter', { title: '按启用状态筛选', attrs: 'data-team-filter' })}
        ${ui.searchBox({
          placeholder: '搜索 Agent...',
          width: '224px',
          attrs: 'id="team-search" data-team-search autocomplete="off" spellcheck="false"',
        })}
      </div>
    </div>`;
  }

  function mcpChips(mcp) {
    return String(mcp || '')
      .split('·')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => ui.chip(item))
      .join('');
  }

  function cardHtml(agent) {
    const tone = TONE_RGB[agent.tone] ? agent.tone : 'cyan';
    const searchText = [agent.name, agent.en, agent.desc, agent.mcp, agent.status].join(' ').toLowerCase();
    const quickCount = (agent.quickPrompts || []).length;

    return `<article class="team-card" data-team-card data-search="${ui.esc(searchText)}"
      data-enabled="${agent.online ? '1' : '0'}"
      style="--tone-rgb:${TONE_RGB[tone]}">
      <div class="team-card-head">
        <span class="team-avatar">${ui.avatar(agent, 'lg')}</span>
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
        <span class="team-status-label">名册状态：</span>
        <span class="team-status-text">${ui.esc(agent.status)} · 单次最大 ${ui.num(agent.today)} 步</span>
      </div>

      <div class="team-mcp">
        <span class="team-mcp-label">授权工具：</span>
        ${mcpChips(agent.mcp)}
      </div>

      <div class="team-meta">
        <span><span class="team-meta-label">授权工具：</span>${
          agent.wildcard ? '<b>全部</b><span>（通配 *）</span>' : `<b class="num">${ui.num(agent.rules)}</b><span>条</span>`
        }</span>
        <span><span class="team-meta-label">${quickCount ? '快捷指令：' : '最大步数：'}</span><b class="num">${
          quickCount ? ui.num(quickCount) : ui.num(agent.today)
        }</b><span>${quickCount ? '条' : '步'}</span></span>
      </div>

      <div class="team-actions">
        ${ui.btn({ label: '管理界面', tone: 'primary', size: 'sm', attrs: `data-team-enter="${ui.esc(agent.id)}"` })}
        ${ui.btn({ label: '查看配置', tone: 'ghost', size: 'sm', attrs: `data-team-config="${ui.esc(agent.id)}"` })}
      </div>
    </article>`;
  }

  /* ------------------------------ 页面注册 ------------------------------ */

  pages.agents = {
    title: 'Agent 团队管理',
    subtitle: '6 位 Agent 的分工、记忆与上下文 · 人设来自 config/agents.yaml',

    render(ctx) {
      const agents = ctx.data.agents || [];
      const stats = (ctx.data.team && ctx.data.team.stats) || [];
      return `<div class="team-page">
        ${toolbarHtml(stats)}
        <div class="team-grid" id="team-grid">${agents.map(cardHtml).join('')}</div>
        ${
          agents.length
            ? ''
            : `<div class="empty"><div class="empty-icon">${ui.icon('robot', 26)}</div>
                <div class="empty-title">名册中暂无 Agent</div>
                <div class="empty-desc">请检查 <code>src/Wizstar.Api/config/agents.yaml</code> 是否已声明 Agent。</div></div>`
        }
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

      const search = page.querySelector('[data-team-search]');
      const cards = Array.from(page.querySelectorAll('[data-team-card]'));
      const empty = page.querySelector('#team-empty');
      let enabledOnly = null; // null=全部 true=仅启用 false=仅停用

      const applyFilter = () => {
        const keyword = search ? search.value.trim().toLowerCase() : '';
        let shown = 0;
        cards.forEach((card) => {
          const hitKeyword = !keyword || (card.dataset.search || '').includes(keyword);
          const hitState =
            enabledOnly === null || (enabledOnly ? card.dataset.enabled === '1' : card.dataset.enabled === '0');
          const hit = hitKeyword && hitState;
          card.classList.toggle('is-hidden', !hit);
          if (hit) shown += 1;
        });
        if (empty) empty.classList.toggle('is-hidden', shown > 0);
      };

      if (search) search.addEventListener('input', applyFilter);

      ui.bind(page, '[data-team-filter]', 'click', () => {
        enabledOnly = enabledOnly === null ? true : enabledOnly === true ? false : null;
        applyFilter();
        ctx.toast(
          enabledOnly === null ? '筛选：全部 Agent' : enabledOnly ? '筛选：仅已启用' : '筛选：仅已停用',
          'info'
        );
      });

      ui.bind(page, '[data-team-enter]', 'click', (e) => {
        const agent = findAgent(e.currentTarget.getAttribute('data-team-enter'));
        if (!agent) return;
        // 指挥官：独立窗口铺满整个界面（不在主壳内容框里）；其余 Agent：右滑工作台
        if (agent.id === 'commander') {
          if (window.workbench && typeof window.workbench.openCommander === 'function') {
            window.workbench.openCommander();
            return;
          }
          window.location.href = 'commander.html';
          return;
        }
        if (WB.agentWorkbench) WB.agentWorkbench.open(agent, 'chat');
      });

      ui.bind(page, '[data-team-config]', 'click', (e) => {
        const agent = findAgent(e.currentTarget.getAttribute('data-team-config'));
        if (agent && WB.agentWorkbench) WB.agentWorkbench.open(agent, 'config');
      });
    },
  };
})();
