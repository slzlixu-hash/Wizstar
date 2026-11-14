'use strict';

/**
 * Agent 团队管理页
 *
 * 数据：WB.data.agents（GET /api/ui/bootstrap 的真实名册）+ WB.data.team.stats（GET /api/agents/stats）
 * 交互：
 *   - 搜索 / 状态筛选：前端过滤真实名册
 *   - 进入工作台：POST /api/agents/{key}/chat 真实对话（模型通道 offline 时如实提示）
 *   - 查看配置：GET /api/agents/{key} 展示完整 systemPrompt 与授权工具
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
        <span><span class="team-meta-label">${ui.esc(agent.todayLabel)}：</span><b class="num">${ui.num(agent.today)}</b><span>步</span></span>
      </div>

      <div class="team-actions">
        ${ui.btn({ label: '进入工作台', tone: 'primary', size: 'sm', attrs: `data-team-enter="${ui.esc(agent.id)}"` })}
        ${ui.btn({ label: '查看配置', tone: 'ghost', size: 'sm', attrs: `data-team-config="${ui.esc(agent.id)}"` })}
      </div>
    </article>`;
  }

  /* ------------------------------ 真实对话 ------------------------------ */

  function openChatModal(agent, ctx) {
    const conversationId = 'ui-' + agent.id + '-' + Date.now();

    const overlay = ui.modal({
      title: `工作台 · ${agent.name}`,
      desc: '消息经 POST /api/agents/{key}/chat 直达后端；模型通道 offline 时会如实提示。',
      body: `<div class="team-chat">
        <div class="team-chat-log" data-chat-log>
          <div class="team-chat-hint">向「${ui.esc(agent.name)}」发送一条消息开始会话。</div>
        </div>
        <div class="team-chat-input">
          ${ui.input({ placeholder: '输入消息，回车发送', attrs: 'data-chat-input autocomplete="off"' })}
          ${ui.btn({ label: '发送', icon: 'zap', tone: 'primary', size: 'sm', attrs: 'data-chat-send' })}
        </div>
      </div>`,
      actions: `${ui.btn({ label: '关闭', tone: 'ghost', attrs: 'data-modal-close' })}`,
    });

    const log = overlay.querySelector('[data-chat-log]');
    const input = overlay.querySelector('[data-chat-input]');
    const sendBtn = overlay.querySelector('[data-chat-send]');

    function bubble(kind, text, meta) {
      const cls =
        kind === 'user' ? 'team-chat-msg team-chat-msg--user'
          : kind === 'error' ? 'team-chat-msg team-chat-msg--error'
            : 'team-chat-msg team-chat-msg--agent';
      const el = document.createElement('div');
      el.className = cls;
      el.innerHTML = `<div class="team-chat-body">${ui.esc(text)}</div>${
        meta ? `<div class="team-chat-meta">${ui.esc(meta)}</div>` : ''
      }`;
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
    }

    let busy = false;

    async function send() {
      const text = String(input.value || '').trim();
      if (!text || busy) return;

      busy = true;
      sendBtn.disabled = true;
      const hint = log.querySelector('.team-chat-hint');
      if (hint) hint.remove();

      bubble('user', text);
      input.value = '';

      const res = await WB.api.request('POST', '/api/agents/' + encodeURIComponent(agent.id) + '/chat', {
        conversationId: conversationId,
        message: text,
      });

      busy = false;
      sendBtn.disabled = false;
      input.focus();

      if (!res.ok) {
        bubble('error', '调用失败：' + (res.error || '服务未连接'));
        return;
      }

      const d = res.data || {};
      bubble('agent', d.output || '（模型未返回文本）', [
        d.mode ? '通道 ' + d.mode : '',
        d.assembledTools != null ? '装配工具 ' + d.assembledTools : '',
        d.elapsedMs != null ? d.elapsedMs + ' ms' : '',
      ].filter(Boolean).join(' · '));

      if (Array.isArray(d.pendingApprovalIds) && d.pendingApprovalIds.length) {
        bubble('error', `已挂起 ${d.pendingApprovalIds.length} 个审批单，请到「工作台」处理后再继续。`);
      }

      if (String(d.mode || '') === 'offline' && d.message) {
        bubble('error', '模型通道 offline：' + d.message);
      }
    }

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    input.focus();
  }

  /* ------------------------------ 查看配置（真实 systemPrompt） ------------------------------ */

  async function openConfigModal(agentId, ctx) {
    const res = await WB.api.request('GET', '/api/agents/' + encodeURIComponent(agentId));
    if (!res.ok) {
      ctx.toast('读取配置失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }

    const p = res.data || {};
    const tools = Array.isArray(p.allowedTools) ? p.allowedTools : [];

    ui.modal({
      title: `配置 · ${p.displayName || p.key}`,
      desc: '来自 config/agents.yaml（后端只读加载）。',
      body: `${ui.kv([
        ['Key', ui.esc(p.key || '')],
        ['英文名', ui.esc(p.name || '')],
        ['职责', ui.esc(p.description || '—')],
        ['启用状态', p.enabled === false ? '已停用' : '已启用'],
        ['最大步数', `<b class="num">${ui.num(p.maxSteps)}</b> 步`],
        ['授权工具', tools.length ? tools.map((t) => `<code>${ui.esc(t)}</code>`).join(' ') : '未授权任何工具'],
      ])}
      <div class="divider mt-16"></div>
      <div class="field-label mt-8">System Prompt</div>
      <pre class="team-prompt">${ui.esc(p.systemPrompt || '（未配置）')}</pre>`,
      actions: `${ui.btn({ label: '关闭', tone: 'ghost', attrs: 'data-modal-close' })}`,
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
        if (agent) openChatModal(agent, ctx);
      });

      ui.bind(page, '[data-team-config]', 'click', (e) => {
        openConfigModal(e.currentTarget.getAttribute('data-team-config'), ctx);
      });
    },
  };
})();
