'use strict';

/**
 * 运营指挥工作台（dashboard）
 *
 * 数据全部来自真实接口（由 api-client.js 预取填充）：
 *   - KPI / 协同流 ← GET /api/business/dashboard（业务表聚合）
 *   - 待处理任务 ← GET /api/approvals?status=pending（HITL 审批单）
 * 交互全部落真实端点：
 *   - 通过 / 拒绝 ← POST /api/approvals/{id}/approve | reject
 *   - 刷新      ← WB.api.reload()
 * 没有后端能力的操作一律不提供，不做本地假成功。
 */
(function () {
  const WB = window.WB;
  const ui = WB.ui;
  const pages = (WB.pages = WB.pages || {});

  /** KPI 的 meta 按「·」拆成值旁小注与底部说明两段（仅用于版面呈现）。 */
  function splitKpiMeta(kpi) {
    const raw = String(kpi.meta || '');
    if (kpi.warn) return { side: '', meta: raw };
    const parts = raw.split(' · ');
    if (parts.length > 1) return { side: parts[0], meta: parts.slice(1).join(' · ') };
    return { side: '', meta: raw };
  }

  function kpiCard(kpi) {
    const extra = splitKpiMeta(kpi);
    return `<section class="card dash-kpi${kpi.warn ? ' dash-kpi--warn' : ''}">
      <div class="dash-kpi-head">
        <span class="dash-kpi-label">${ui.esc(kpi.label)}</span>
        ${kpi.warn ? `<span class="dash-kpi-alert" title="需要人工审批">${ui.icon('alert', 16)}</span>` : ''}
      </div>
      <div class="dash-kpi-value">
        ${kpi.prefix ? `<span class="dash-kpi-prefix">${ui.esc(kpi.prefix)}</span>` : ''}
        <span class="dash-kpi-num num">${ui.esc(kpi.value)}</span>
        ${kpi.unit ? `<span class="dash-kpi-unit">${ui.esc(kpi.unit)}</span>` : ''}
        ${extra.side ? `<span class="dash-kpi-side">（${ui.esc(extra.side)}）</span>` : ''}
        ${kpi.delta ? `<span class="delta ${ui.esc(kpi.deltaTone || 'up')}">${ui.esc(kpi.delta)}</span>` : ''}
      </div>
      ${extra.meta ? `<div class="dash-kpi-meta" title="${ui.esc(extra.meta)}">${ui.esc(extra.meta)}</div>` : ''}
    </section>`;
  }

  /* ------------------------------ 全链路协同流 ------------------------------ */
  function pipelineFlow(stages) {
    return stages
      .map((stage, i) => {
        const tone = ui.esc(stage.tone || 'slate');
        const chip = `<button type="button" class="dash-stage dash-stage--${tone}" data-go="products" title="查看对应商品状态">
          <span class="dash-stage-label">${ui.esc(stage.label)}</span>
          <span class="dash-stage-count num">${ui.num(stage.count)}</span>
        </button>`;
        if (i === stages.length - 1) return chip;
        return `${chip}<span class="dash-link" aria-hidden="true"><i class="dash-link-arrow"></i></span>`;
      })
      .join('');
  }

  /* ------------------------------ 待处理任务表 ------------------------------ */
  function taskTable(tasks) {
    return ui.table({
      columns: [
        { label: '单号', width: '84px', render: (t) => `<span class="cell-id">${ui.esc(t.id)}</span>` },
        {
          label: '来源',
          width: '96px',
          render: (t) => `<span class="dash-src" title="${ui.esc(t.type)}">${ui.esc(t.source)}</span>`,
        },
        { label: '任务描述', render: (t) => `<span class="dash-desc" title="${ui.esc(t.desc)}">${ui.esc(t.desc)}</span>` },
        { label: '提交时间', width: '72px', render: (t) => `<span class="dash-time num">${ui.esc(t.time)}</span>` },
        {
          label: '操作',
          width: '150px',
          cls: 'dash-ops-cell',
          render: (t) =>
            `<span class="dash-ops-row">${ui.btn({
              label: '通过',
              tone: 'primary',
              size: 'xs',
              attrs: `data-dash-approve="${ui.esc(t.approvalId)}"`,
            })}${ui.btn({
              label: '拒绝',
              tone: 'ghost',
              size: 'xs',
              attrs: `data-dash-reject="${ui.esc(t.approvalId)}"`,
            })}</span>`,
        },
      ],
      rows: tasks,
      rowAttrs: (t) => `data-task-row="${ui.esc(t.id)}"`,
      empty: `<div class="empty"><div class="empty-icon">${ui.icon('shield', 26)}</div><div class="empty-title">暂无待审批事项</div><div class="empty-desc">Agent 触发不可逆操作时会在此挂起，等待人工决策。</div></div>`,
    });
  }

  /* ------------------------------ Agent 小卡 ------------------------------ */
  function agentCard(agent) {
    const tone = ui.esc(agent.tone || 'cyan');
    const summary = `${agent.name} · ${agent.en} · 授权工具 ${agent.rules} 个 · ${agent.todayLabel} ${ui.num(agent.today)}`;
    return `<button type="button" class="dash-agent dash-agent--${tone}" data-go="agents" title="${ui.esc(summary)}">
      ${ui.avatar(agent, 'md')}
      <span class="dash-agent-body">
        <span class="dash-agent-top">
          <span class="dash-agent-name">${ui.esc(agent.name)}</span>
          <i class="status-dot ${ui.esc(agent.dot || 'online')}"></i>
        </span>
        <span class="dash-agent-en">${ui.esc(agent.en)} · ${agent.wildcard ? '全部工具' : ui.num(agent.rules) + ' 工具'}</span>
      </span>
    </button>`;
  }

  pages.dashboard = {
    title: '运营指挥工作台',
    subtitle: `<span class="dash-now-pill">${ui.icon('clock', 13)}实时数据</span>`,
    actions: '',
    render(ctx) {
      const d = ctx.data.dashboard || { kpis: [], pipeline: [], tasks: [] };
      const agents = ctx.data.agents || [];
      const online = agents.filter((a) => a.online).length;

      return `<div class="stack dash-page">
        <div class="grid grid-4 dash-kpis">${(d.kpis || []).map(kpiCard).join('')}</div>

        <section class="card dash-pipeline">
          <div class="dash-card-head">
            <h2 class="dash-pipeline-title">全链路智能体协同流</h2>
            <span class="tiny dim">商品立项状态分布（真实业务表）</span>
          </div>
          <div class="dash-flow">${pipelineFlow(d.pipeline || [])}</div>
        </section>

        <div class="dash-split">
          <section class="card dash-tasks">
            <div class="dash-card-head">
              <h2 class="dash-card-title">待处理高优先任务</h2>
              <div class="dash-head-actions">
                ${ui.badge('HITL 待审批', { tone: 'amber', dot: true })}
                ${ui.btn({
                  label: '刷新',
                  tone: 'link',
                  icon: 'refresh',
                  attrs: 'data-dash-refresh',
                })}
              </div>
            </div>
            <div class="dash-task-table">${taskTable(d.tasks || [])}</div>
            <div class="dash-task-foot">
              <span class="dash-foot-note"><i class="status-dot amber"></i>HITL 人工审批保护已开启，服务端不自动批准</span>
              <span class="dash-foot-count">共 <b class="num" data-task-count>${(d.tasks || []).length}</b> 项待处理</span>
            </div>
          </section>

          <section class="card dash-agents">
            <div class="dash-card-head">
              <h2 class="dash-card-title">Agent 名册与工具授权</h2>
              <span class="dash-online"><i class="status-dot ${online > 0 ? 'online' : 'offline'}"></i>${online} / ${
                agents.length
              } 启用</span>
            </div>
            <div class="dash-agent-grid">${agents.map(agentCard).join('')}</div>
            ${ui.btn({
              label: '重新加载全部数据',
              tone: 'gradient',
              size: 'lg',
              block: true,
              icon: 'refresh',
              cls: 'dash-auto',
              attrs: 'data-dash-reload',
            })}
          </section>
        </div>
      </div>`;
    },
    mount(root, ctx) {
      const dashboard = ctx.data.dashboard || { tasks: [] };
      const countEl = root.querySelector('[data-task-count]');
      let remaining = (dashboard.tasks || []).length;

      async function decide(btn, approve) {
        const row = btn.closest('[data-task-row]');
        if (!row || row.classList.contains('is-approved') || row.classList.contains('is-rejected')) return;

        const approvalId = btn.getAttribute(approve ? 'data-dash-approve' : 'data-dash-reject');
        const id = row.getAttribute('data-task-row');
        const task = (dashboard.tasks || []).find((t) => t.id === id);
        if (!approvalId) return;

        const ok = await ui.confirm({
          title: `${approve ? '通过' : '拒绝'}审批 ${id}`,
          desc: `来源：${ui.esc(task ? task.source : '')} · ${ui.esc(task ? task.type : '')}<br />${ui.esc(
            task ? task.desc : ''
          )}<br /><span class="dim">${
            approve
              ? '通过后不自动执行：Agent 需在下一次携带相同 operationId 的调用才会真正落库。'
              : '拒绝后该 operationId 将被标记为拒绝，不会执行。'
          }</span>`,
          ok: approve ? '通过审批' : '确认拒绝',
          cancel: '取消',
          tone: approve ? undefined : 'danger',
        });
        if (!ok) return;

        const res = await WB.api.request(
          'POST',
          '/api/approvals/' + encodeURIComponent(approvalId) + (approve ? '/approve' : '/reject'),
          { note: '' }
        );

        if (!res.ok) {
          ctx.toast('操作失败：' + (res.error || '服务未连接'), 'warn');
          return;
        }

        row.classList.add(approve ? 'is-approved' : 'is-rejected');
        const ops = row.querySelector('.dash-ops-row');
        if (ops) {
          ops.innerHTML = ui.badge(approve ? '已通过' : '已拒绝', { tone: approve ? 'green' : 'rose', dot: true });
        }
        remaining = Math.max(0, remaining - 1);
        if (countEl) countEl.textContent = String(remaining);
        ctx.toast(`审批 ${id} 已${approve ? '通过' : '拒绝'}`, approve ? 'success' : 'info');
      }

      root.querySelectorAll('[data-dash-approve]').forEach((btn) => {
        btn.addEventListener('click', () => decide(btn, true));
      });
      root.querySelectorAll('[data-dash-reject]').forEach((btn) => {
        btn.addEventListener('click', () => decide(btn, false));
      });

      const reload = (btn) => {
        if (!btn || btn.dataset.loading === '1') return;
        btn.dataset.loading = '1';
        const original = btn.innerHTML;
        btn.innerHTML = `<span class="spinner"></span><span>正在重新加载…</span>`;
        Promise.resolve(WB.api.reload()).then(() => {
          btn.dataset.loading = '0';
          btn.innerHTML = original;
          ctx.toast('数据已从后端重新加载', 'success');
        });
      };

      const refreshBtn = root.querySelector('[data-dash-refresh]');
      if (refreshBtn) refreshBtn.addEventListener('click', () => reload(refreshBtn));

      const reloadBtn = root.querySelector('[data-dash-reload]');
      if (reloadBtn) reloadBtn.addEventListener('click', () => reload(reloadBtn));
    },
  };
})();
