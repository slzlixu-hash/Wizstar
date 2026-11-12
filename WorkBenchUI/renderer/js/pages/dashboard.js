'use strict';

/**
 * 运营指挥工作台（dashboard）
 * 契约见 CONTRACT.md 第 4 / 7 节：数据只读 WB.data.dashboard 与 WB.data.agents，
 * 交互全部为本地演示级（确认框 / toast / loading），不连接任何接口。
 */
(function () {
  const WB = window.WB;
  const ui = WB.ui;
  const pages = (WB.pages = WB.pages || {});

  const clamp = (v) => Math.max(0, Math.min(100, Number(v) || 0));

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
        const chip = `<button type="button" class="dash-stage dash-stage--${tone}" data-toast="${ui.esc(
          `${stage.label} · 当前 ${ui.num(stage.count)} 个任务`
        )}">
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
        { label: '任务 ID', width: '74px', render: (t) => `<span class="cell-id">${ui.esc(t.id)}</span>` },
        { label: '来源', width: '84px', render: (t) => `<span class="dash-src" title="${ui.esc(t.type)}">${ui.esc(t.source)}</span>` },
        { label: '任务描述', render: (t) => `<span class="dash-desc" title="${ui.esc(t.desc)}">${ui.esc(t.desc)}</span>` },
        { label: '触发时间', width: '64px', render: (t) => `<span class="dash-time num">${ui.esc(t.time)}</span>` },
        {
          label: '操作',
          width: '132px',
          cls: 'dash-ops-cell',
          render: (t) => `<span class="dash-ops-row">${ui.btn({
            label: '审批',
            tone: 'primary',
            size: 'xs',
            attrs: `data-dash-approve="${ui.esc(t.id)}"`,
          })}${ui.btn({ label: '委派', tone: 'ghost', size: 'xs', caret: true, attrs: `data-dash-assign="${ui.esc(t.id)}"` })}</span>`,
        },
      ],
      rows: tasks,
      rowAttrs: (t) => `data-task-row="${ui.esc(t.id)}"`,
    });
  }

  /* ------------------------------ Agent 负载小卡 ------------------------------ */
  function agentCard(agent) {
    const tone = ui.esc(agent.tone || 'cyan');
    const summary = `${agent.name} · 负载 ${agent.load}% · ${agent.todayLabel} ${ui.num(agent.today)} 次`;
    return `<button type="button" class="dash-agent dash-agent--${tone}" data-toast="${ui.esc(summary)}">
      ${ui.avatar(agent, 'md')}
      <span class="dash-agent-body">
        <span class="dash-agent-top">
          <span class="dash-agent-name">${ui.esc(agent.name)}</span>
          <i class="status-dot ${ui.esc(agent.dot || 'online')}"></i>
        </span>
        <span class="dash-agent-en">${ui.esc(agent.en)}</span>
        <span class="dash-agent-load">
          <span class="bar bar--thin"><i style="width: ${clamp(agent.load)}%"></i></span>
          <span class="dash-agent-pct num">${ui.esc(agent.load)}%</span>
        </span>
      </span>
    </button>`;
  }

  pages.dashboard = {
    title: '运营指挥工作台',
    subtitle: `<span class="dash-now-pill">${ui.icon('clock', 13)}现在简体中文</span>`,
    actions: '',
    render(ctx) {
      const d = ctx.data.dashboard;
      const agents = ctx.data.agents || [];
      const online = agents.filter((a) => a.online).length;

      return `<div class="stack dash-page">
        <div class="grid grid-4 dash-kpis">${d.kpis.map(kpiCard).join('')}</div>

        <section class="card dash-pipeline">
          <h2 class="dash-pipeline-title">全链路智能体协同流</h2>
          <div class="dash-flow">${pipelineFlow(d.pipeline)}</div>
        </section>

        <div class="dash-split">
          <section class="card dash-tasks">
            <div class="dash-card-head">
              <h2 class="dash-card-title">待处理高优先任务</h2>
              <div class="dash-head-actions">
                ${ui.badge('HITL 待审批', { tone: 'amber', dot: true })}
                ${ui.btn({
                  label: '查看全部',
                  tone: 'link',
                  attrs: 'data-toast="全部审批任务将在「审批中心」统一处理（界面演示）"',
                })}
              </div>
            </div>
            <div class="dash-task-table">${taskTable(d.tasks)}</div>
            <div class="dash-task-foot">
              <span class="dash-foot-note"><i class="status-dot amber"></i>HITL 人工审批保护已开启</span>
              <span class="dash-foot-count">共 <b class="num" data-task-count>${d.tasks.length}</b> 项待处理</span>
            </div>
          </section>

          <section class="card dash-agents">
            <div class="dash-card-head">
              <h2 class="dash-card-title">6 位 Agent 实时运行负载</h2>
              <span class="dash-online"><i class="status-dot online"></i>${online} / ${agents.length} 在线</span>
            </div>
            <div class="dash-agent-grid">${agents.map(agentCard).join('')}</div>
            ${ui.btn({
              label: '一键启动自动测款',
              tone: 'gradient',
              size: 'lg',
              block: true,
              icon: 'zap',
              cls: 'dash-auto',
              attrs: 'data-dash-autotest',
            })}
          </section>
        </div>
      </div>`;
    },
    mount(root, ctx) {
      const dashboard = ctx.data.dashboard;
      const countEl = root.querySelector('[data-task-count]');
      let remaining = dashboard.tasks.length;

      root.querySelectorAll('[data-dash-approve]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('[data-task-row]');
          if (!row || row.classList.contains('is-approved')) return;
          const id = row.getAttribute('data-task-row');
          const task = dashboard.tasks.find((t) => t.id === id);
          if (!task) return;

          const ok = await ui.confirm({
            title: `审批任务 ${task.id}`,
            desc: `来源：${ui.esc(task.source)} · ${ui.esc(task.type)}<br />${ui.esc(task.desc)}<br /><span class="dim">审批通过后由对应 Agent 继续执行，结果仅在本界面演示，不写回业务系统。</span>`,
            ok: '通过审批',
            cancel: '再看看',
          });
          if (!ok) return;

          row.classList.add('is-approved');
          const ops = row.querySelector('.dash-ops-row');
          if (ops) ops.innerHTML = ui.badge('已通过', { tone: 'green', dot: true });
          remaining = Math.max(0, remaining - 1);
          if (countEl) countEl.textContent = String(remaining);
          ctx.toast(`任务 ${task.id} 已审批通过`, 'success');
        });
      });

      root.querySelectorAll('[data-dash-assign]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const row = btn.closest('[data-task-row]');
          const id = row ? row.getAttribute('data-task-row') : '';
          const agents = ctx.data.agents || [];
          const target = agents[0] || { name: '指挥官' };
          ctx.toast(`任务 ${id} 已委派给「${target.name}」Agent 跟进`, 'info');
        });
      });

      const auto = root.querySelector('[data-dash-autotest]');
      if (auto) {
        auto.addEventListener('click', () => {
          if (auto.dataset.loading === '1') return;
          auto.dataset.loading = '1';
          auto.classList.add('is-loading');
          const original = auto.innerHTML;
          auto.innerHTML = `<span class="spinner"></span><span>正在启动自动测款…</span>`;
          setTimeout(() => {
            auto.dataset.loading = '0';
            auto.classList.remove('is-loading');
            auto.innerHTML = original;
            ctx.toast('已启动「自动测款」：侦察兵 Agent 开始挖掘抖音爆款（界面演示）', 'success');
          }, 800);
        });
      }
    },
  };
})();
