'use strict';

/**
 * 指挥官管理界面（#/commander）
 *
 * 布局对齐设计稿：顶部身份条 + 左侧功能轨 + 中间任务台 + 右侧「协同与指令台」。
 * 数据全部真实：
 *   任务        GET /api/business/products（含流水线进度）
 *   配方        GET /api/pipelines
 *   协同日志    GET /api/commander/activity
 *   订单/轨迹   GET /api/operations?sinceHours=24
 *   记忆        GET /api/agents/commander/memory
 *   工具        GET /api/mcp/tools + GET /api/agents/commander
 *   对话        POST /api/agents/commander/chat
 *   新建/推进/终止  POST /api/business/products、/pipeline/{advance,cancel}
 */
(function () {
  const WB = window.WB;
  const ui = WB.ui;
  const pages = (WB.pages = WB.pages || {});

  const PANELS = [
    { id: 'workbench', label: '运行台', icon: 'home' },
    { id: 'chat', label: 'Chat', icon: 'inbox' },
    { id: 'pipelines', label: '工作流管理', icon: 'layers' },
    { id: 'memory', label: '记忆体', icon: 'database' },
    { id: 'skills', label: 'Skill 技能', icon: 'zap' },
    { id: 'mcp', label: 'MCP 工具', icon: 'plugin' },
    { id: 'logs', label: '轨迹日志', icon: 'terminal' },
  ];

  const STATUS_FILTERS = [
    { value: 'all', label: '全部' },
    { value: 'active', label: '进行中' },
    { value: 'waiting', label: '待人工确认' },
    { value: 'paused', label: '已暂停' },
    { value: 'done', label: '已完成' },
    { value: 'cancelled', label: '已终止' },
    { value: 'archived', label: '已归档' },
    { value: 'idle', label: '待推进' },
  ];

  const DOCK_CHIPS = [
    { label: '//plan 制定推进计划', text: '//plan 请根据当前任务状态，给出下一步推进计划（按工序与责任人）。' },
    { label: '//status 汇报流水线状态', text: '//status 汇总当前所有任务的流水线状态与阻塞点。' },
    { label: '//approve 审核待办', text: '//approve 列出当前待人工确认的节点，并说明每项审核要点。' },
    { label: '//retry 处理异常任务', text: '//retry 检查失败或待接线的任务，给出重试或人工处理的建议。' },
  ];

  const state = {
    panel: 'workbench',
    tasks: [],
    pipelines: [],
    activity: [],
    operations: [],
    memory: null,
    profile: null,
    tools: [],
    approvals: [],
    model: null,
    filters: { keyword: '', range: '7d', pipeline: 'all', status: 'all' },
    chat: [],
    busy: false,
    dockExtra: [],
    loaded: false,
    // 任务详情视图：list（任务列表）| task（执行详情）
    view: 'list',
    detailTask: null,
    detail: null,
    detailLoading: false,
    detailError: null,
    // 登录用户（侧栏底部固定展示）
    user: null,
    // 工作流编排器状态
    wfSearch: '',
    wfSource: 'all',
    wfSelectedId: null,
    wfDraft: null,
    wfDirty: false,
    wfAgents: [],
    // Chat 面板
    cwConversationId: '',
    cwSessions: [],
    cwSessionsLoaded: false,
    cwAttachments: [],
    cwMemory: null,
    // 群聊会诊：single=单聊；group=多人会诊（cwGroup 为后端会话视图）
    cwKind: 'single',
    cwGroup: null,
    cwMentions: [],
    cwShowArchived: false,
    // 记忆体（自学习中枢）
    memTab: 'agent',
    memSearch: '',
    memTag: 'all',
    memStatus: 'all',
    memLearning: false,
    memTeam: [],
    memTeamOverview: [],
    memTeamSearch: '',
    memTeamScope: 'all',
    memTeamCategory: 'all',
    memScopes: { categories: [], channels: [], tags: [] },
    memPreview: null,
    memPreviewLoading: false,
    memSimCategory: 'all',
    memSimChannel: 'all',
    memKnowledgeId: null,
    memKnowledgeDraft: null,
    memKnowledgeSearch: '',
    memKnowledgeTag: 'all',
    memKnowledgeStatus: 'all',
    // Skill 技能
    skills: [],
    skillIssues: [],
    skillTools: [],
    skillSelectedCode: null,
    skillDraft: null,
    skillTab: 'visual',
    skillSearch: '',
    skillAgentKey: 'commander',
    skillExpandedServers: [],
    skillYaml: '',
    skillYamlError: null,
    skillSaving: false,
    skillLoaded: false,
    auditLogs: [],
    auditLoaded: false,
    auditLoading: false,
    auditSince: '24',
    auditPipeline: 'all',
    auditSeverity: 'all',
    auditAgent: 'all',
    auditKeyword: '',
    auditSearchTimer: null,
    // MCP 工具切片（Agent × MCP 服务）
    mcpServers: [],
    mcpTools: [],
    mcpSlices: {},
    mcpLoaded: false,
    mcpLoading: false,
    mcpServerId: null,
    mcpSearch: '',
    mcpSelected: [],
    mcpPage: 1,
    mcpPageSize: 10,
    mcpTab: 'visual',
    mcpDirty: false,
    mcpSaving: false,
  };

  const STAGE_META = {
    pending: { label: '待执行', tone: 'slate', dot: 'offline' },
    running: { label: '执行中', tone: 'cyan', dot: 'busy' },
    waiting_human: { label: '待人工审核', tone: 'amber', dot: 'amber' },
    paused: { label: '已暂停', tone: 'amber', dot: 'amber' },
    completed: { label: '已完成', tone: 'green', dot: 'online' },
    failed: { label: '失败', tone: 'rose', dot: 'amber' },
    blocked: { label: '待接线', tone: 'slate', dot: 'offline' },
    cancelled: { label: '已终止', tone: 'rose', dot: 'offline' },
  };

  /* 群聊会诊：专员短名（@ 胶囊与发言头）与身份色（圆点由 CSS 按 data-agent 取色）。 */
  const AGENT_SHORT = {
    commander: 'Commander',
    scout: 'Scout',
    sourcing: 'Sourcing',
    creative: 'Creative',
    publisher: 'Publisher',
    analyst: 'Analyst',
  };

  function agentShort(key) {
    const hit = (state.wfAgents || []).find((a) => a.key === key);
    return AGENT_SHORT[key] || (hit && hit.name) || key;
  }

  function groupSpecialists() {
    return ((state.cwGroup && state.cwGroup.participants) || []).filter((k) => k !== 'commander');
  }

  function groupMentioned(key) {
    return state.cwMentions.indexOf(key) !== -1;
  }

  function syncGroupMentions() {
    state.cwMentions = groupSpecialists();
  }

  function stageMeta(status) {
    return STAGE_META[String(status || '').toLowerCase()] || STAGE_META.pending;
  }

  function esc(v) {
    return ui.esc(v === undefined || v === null ? '' : String(v));
  }

  function toast(message, tone) {
    if (typeof ui.toast === 'function') ui.toast(message, tone || 'info');
  }

  async function request(method, path, body) {
    try {
      return await WB.api.request(method, path, body);
    } catch (_) {
      return { ok: false, error: '请求异常' };
    }
  }

  function fmtTime(v, withDate) {
    if (!v) return '—';
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    const time = d.toLocaleTimeString('zh-CN', { hour12: false });
    if (!withDate) return time;
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) + ' ' + time;
  }

  function fmtClock(v) {
    if (!v) return '--:--:--';
    const d = new Date(v);
    return isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString('zh-CN', { hour12: false });
  }

  /* ------------------------------ 任务状态 ------------------------------ */

  function taskState(task) {
    const status = String(task.stageStatus || '').toLowerCase();
    const index = Number(task.stageIndex) || 0;
    const total = Number(task.stageTotal) || 0;
    if (String(task.rawStatus || '').toLowerCase() === 'archived' || task.status === '已归档') {
      return { key: 'archived', label: '已归档', tone: 'slate', dot: 'offline', index, total };
    }
    if (status === 'cancelled') return { key: 'cancelled', label: '已终止', tone: 'rose', dot: 'offline', index, total };
    if (status === 'paused') return { key: 'paused', label: '已暂停', tone: 'amber', dot: 'amber', index, total };
    if (status === 'completed' && (total === 0 || index >= total)) {
      return { key: 'done', label: '已完成', tone: 'green', dot: 'online', index, total };
    }
    if (status === 'waiting_human') return { key: 'waiting', label: '待人工确认', tone: 'amber', dot: 'amber', index, total };
    if (status === 'running') return { key: 'active', label: '进行中', tone: 'cyan', dot: 'busy', index, total };
    if (status === 'failed') return { key: 'idle', label: '失败', tone: 'amber', dot: 'amber', index, total };
    return { key: 'idle', label: '待推进', tone: 'slate', dot: 'offline', index, total };
  }

  function progressText(task) {
    const st = taskState(task);
    if (!st.total) return st.label;
    return `${st.label} (${st.index}/${st.total})`;
  }

  /* ------------------------------ 过滤 ------------------------------ */

  function filteredTasks() {
    const f = state.filters;
    const now = Date.now();
    const windowMs = f.range === 'today' ? 24 * 3600 * 1000 : f.range === '7d' ? 7 * 24 * 3600 * 1000 : 0;
    const kw = f.keyword.trim().toLowerCase();

    return state.tasks.filter((t) => {
      if (windowMs && f.status !== 'archived') {
        const at = t.updatedAt ? new Date(t.updatedAt).getTime() : 0;
        if (!at || now - at > windowMs) return false;
      }
      if (f.pipeline !== 'all' && String(t.pipelineId || '') !== f.pipeline) return false;
      const st = taskState(t);
      if (f.status === 'all') {
        // 归档是逻辑软删除：默认列表不展示；通过「已归档」筛选追溯。
        if (st.key === 'archived') return false;
      } else if (st.key !== f.status) {
        return false;
      }
      if (kw) {
        const hay = [t.id, t.name, t.pipelineName, t.currentStageName].join(' ').toLowerCase();
        if (hay.indexOf(kw) === -1) return false;
      }
      return true;
    });
  }

  /* ------------------------------ 渲染：顶部 ------------------------------ */

  function llmSnapshot() {
    return state.model || (WB.data && WB.data.llm) || {};
  }

  function agentBoundModel(agentKey) {
    const bindings = Array.isArray(llmSnapshot().bindings) ? llmSnapshot().bindings : [];
    const hit = bindings.find((b) => b.agentId === agentKey);
    return hit && hit.model ? hit.model : '';
  }

  /* 实际生效模型：有绑定用绑定，没有绑定回落全局默认。 */
  function effectiveAgentModel(agentKey) {
    return agentBoundModel(agentKey) || llmSnapshot().defaultModel || '';
  }

  function enabledModelOptions() {
    const snapshot = llmSnapshot();
    const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
    const on = new Set(providers.filter((p) => p.enabled).map((p) => p.code));
    return (Array.isArray(snapshot.models) ? snapshot.models : []).filter(
      (m) => m.enabled && (providers.length === 0 || on.has(m.providerCode))
    );
  }

  function modelLabel() {
    const llm = llmSnapshot();
    const app = (WB.data && WB.data.app) || {};
    const model = effectiveAgentModel('commander') || llm.defaultModel || app.globalModel || '';
    const meta = (llm.models || []).find((m) => m.modelId === model);
    const mode = String(llm.chatMode || (WB.data && WB.data.chatMode) || '').toLowerCase();
    let text = model || '未配置模型';
    if (model && meta && meta.name) {
      text = meta.name.indexOf(model) !== -1 ? meta.name : meta.name + ' · ' + model;
    }
    return {
      text,
      online: mode === 'live',
      mode,
      model,
    };
  }

  function modelMenuHtml() {
    const current = effectiveAgentModel('commander');
    const models = enabledModelOptions();
    return `<div class="cmd-model-menu" data-cmd-model-menu hidden>
      <div class="cmd-model-menu-head">切换指挥官当前模型</div>
      ${
        models.length
          ? models
              .map(
                (m) => `<button type="button" class="cmd-model-item${m.modelId === current ? ' is-on' : ''}"
                  data-cmd-pick-model="${esc(m.modelId)}">
                  <span class="cmd-model-item-main">
                    <b>${esc(m.name || m.modelId)}</b>
                    <em class="mono">${esc(m.modelId)}</em>
                  </span>
                  <span class="cmd-model-item-provider">${esc(m.providerCode)}</span>
                  ${m.modelId === current ? ui.icon('check', 13) : ''}
                </button>`
              )
              .join('')
          : `<div class="cmd-model-empty">系统还没有已接入的可用模型，请先在系统设置中配置。</div>`
      }
    </div>`;
  }

  function topHtml() {
    const model = modelLabel();
    return `<div class="cmd-top">
      <button type="button" class="cmd-back" data-cmd-back>${ui.icon('chevron-left', 15)}<span>返回名册</span></button>
      <span class="cmd-crumb">Agent 名册 / 指挥官</span>
      <span class="cmd-avatar">${ui.avatar({ id: 'commander', name: '指挥官', avatar: '../ico/commander.ico', photo: true, initial: '指' }, 'lg')}</span>
      <div class="cmd-ident">
        <div class="cmd-name">指挥官 <em>COMMANDER</em> ${ui.badge('运行中', { tone: 'green', dot: true })}</div>
        <div class="cmd-sub">团队调度与流水线推进：拆解目标、分派工序、跟踪进度</div>
      </div>
      <div class="cmd-model">
        <span class="cmd-model-label">当前模型</span>
        <b class="cmd-model-name">${esc(model.text)}</b>
        <i class="status-dot ${model.online ? 'online' : 'offline'}"></i>
        <div class="cmd-model-picker" data-cmd-model-picker>
          <button type="button" class="btn btn-ghost btn-sm cmd-model-btn" data-cmd-model-toggle title="选择当前 Agent 使用的模型">
            ${ui.icon('cpu', 13)}<span>模型选择</span>${ui.icon('chevron-down', 12)}
          </button>
          ${modelMenuHtml()}
        </div>
      </div>
      <div class="cmd-wins">
        <button type="button" class="cmd-win" data-cmd-win="minimize" title="最小化" aria-label="最小化">${ui.icon('minus', 13)}</button>
        <button type="button" class="cmd-win" data-cmd-win="maximize" title="最大化" aria-label="最大化">${ui.icon('maximize', 13)}</button>
        <button type="button" class="cmd-win is-close" data-cmd-win="close" title="关闭" aria-label="关闭">${ui.icon('close', 13)}</button>
      </div>
    </div>`;
  }

  /* ------------------------------ 渲染：左轨 ------------------------------ */

  function railCount(id) {
    if (id === 'workbench') return state.tasks.filter((t) => taskState(t).key !== 'archived').length;
    if (id === 'pipelines') return state.pipelines.length;
    if (id === 'memory') return state.memory ? (state.memory.memories || []).length + (state.memory.knowledge || []).length : 0;
    if (id === 'skills') {
      return (state.skills || []).length;
    }
    if (id === 'mcp') return state.mcpLoaded ? (state.mcpSelected || []).length : '';
    if (id === 'logs') return (state.auditLogs || []).length;
    return '';
  }

  function activeTasks() {
    return state.tasks
      .filter((t) => ['active', 'waiting', 'idle', 'paused'].includes(taskState(t).key))
      .slice(0, 5);
  }

  function railHtml() {
    const batches = state.panel === 'workbench' ? activeTasks() : [];
    return `<aside class="cmd-rail">${PANELS.map((p) => {
      const count = railCount(p.id);
      return `<button type="button" class="cmd-rail-item${state.panel === p.id ? ' is-on' : ''}" data-cmd-panel="${p.id}">
        ${ui.icon(p.icon, 15)}<span>${esc(p.label)}${p.id === 'workbench' ? ' (Active)' : ''}</span>
        ${count !== '' ? `<em class="cmd-rail-count">${esc(String(count))}</em>` : ''}
      </button>`;
    }).join('')}
      ${
        batches.length
          ? `<div class="cmd-batches">
              <div class="cmd-batches-title">进行中任务切换<span class="cmd-batches-sub">Active Tasks</span></div>
              ${batches
                .map((t) => {
                  const st = taskState(t);
                  const on = state.view === 'task' && state.detailTask && state.detailTask.id === t.id;
                  return `<button type="button" class="cmd-batch${on ? ' is-on' : ''}" data-cmd-batch="${esc(t.id)}">
                    <span class="cmd-batch-name">${esc(t.name)}</span>
                    <span class="cmd-batch-meta">${ui.badge(progressText(t), { tone: st.tone, dot: true })}</span>
                  </button>`;
                })
                .join('')}
            </div>`
          : ''
      }
      <div class="cmd-rail-user">${ui.userMenu(state.user)}</div>
    </aside>`;
  }

  /* ------------------------------ 渲染：工作台 ------------------------------ */

  function taskRowHtml(task) {
    const st = taskState(task);
    const id = esc(task.id);
    const actions = [`<button type="button" class="cmd-link" data-cmd-detail="${id}">详情</button>`];
    if (st.key === 'archived') {
      actions.push(`<button type="button" class="cmd-link" data-cmd-row-retro="${id}">复盘</button>`);
      actions.push(`<button type="button" class="cmd-link is-danger" data-cmd-row-delete="${id}">删除</button>`);
    } else if (st.key === 'done' || st.key === 'cancelled') {
      actions.push(`<button type="button" class="cmd-link" data-cmd-row-retro="${id}">复盘</button>`);
      actions.push(`<button type="button" class="cmd-link" data-cmd-row-archive="${id}">归档</button>`);
    } else if (st.key === 'paused') {
      actions.push(`<button type="button" class="cmd-link" data-cmd-row-resume="${id}">继续</button>`);
      actions.push(`<button type="button" class="cmd-link is-danger" data-cmd-row-cancel="${id}">终止</button>`);
    } else {
      actions.push(`<button type="button" class="cmd-link" data-cmd-row-pause="${id}">暂停</button>`);
      actions.push(`<button type="button" class="cmd-link is-danger" data-cmd-row-cancel="${id}">终止</button>`);
    }

    return `<tr data-cmd-task="${id}" title="双击进入任务执行详情">
      <td>
        <div class="cmd-task-name">${esc(task.name)}</div>
        <div class="cmd-task-id mono">${id}</div>
      </td>
      <td>${esc(task.pipelineName || '未匹配配方')}</td>
      <td class="mono">${esc(fmtTime(task.updatedAt, true))}</td>
      <td>${ui.badge(progressText(task), { tone: st.tone, dot: true })}</td>
      <td><div class="cmd-actions">${actions.join('')}</div></td>
    </tr>`;
  }

  function workbenchHtml() {
    const rows = filteredTasks();
    const pipelineOptions = [{ value: 'all', label: '全部配方' }].concat(
      state.pipelines.map((p) => ({ value: p.pipelineId, label: p.name }))
    );
    const recent = state.operations.slice(0, 8);

    return `<div class="cmd-panel-head">
        <div class="cmd-filters">
          <label class="cmd-search">${ui.icon('search', 14)}
            <input class="input" placeholder="搜索任务编号 / 名称…" data-cmd-kw value="${esc(state.filters.keyword)}" />
          </label>
          ${ui.select({
            options: [{ value: 'today', label: '时间：今日' }, { value: '7d', label: '时间：近 7 天' }, { value: 'all', label: '时间：全部' }],
            value: state.filters.range,
            attrs: 'data-cmd-range',
          })}
          ${ui.select({ options: pipelineOptions, value: state.filters.pipeline, attrs: 'data-cmd-pipeline' })}
          ${ui.select({ options: STATUS_FILTERS, value: state.filters.status, attrs: 'data-cmd-status' })}
        </div>
        ${ui.btn({ label: '新建任务', icon: 'plus', tone: 'primary', size: 'sm', attrs: 'data-cmd-new' })}
      </div>
      <div class="cmd-card">
        <div class="cmd-card-head"><span>任务列表</span><span class="tiny dim">双击行进任务执行详情</span></div>
        ${
          rows.length
            ? `<div class="cmd-table-wrap"><table class="cmd-table">
                <thead><tr><th>任务名</th><th>工作流名</th><th>时间</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>${rows.map(taskRowHtml).join('')}</tbody>
              </table></div>`
            : `<div class="cmd-empty">暂无符合条件的任务。点右上角「新建任务」按工作流创建。</div>`
        }
      </div>
      <div class="cmd-card">
        <div class="cmd-card-head"><span>最近轨迹</span><span class="tiny dim">来自操作账本（近 24h）</span></div>
        ${
          recent.length
            ? `<div class="cmd-traces">${recent
                .map(
                  (op) => `<div class="cmd-trace">
                    <span class="cmd-trace-time mono">${esc(fmtClock(op.createdAt))}</span>
                    <span class="cmd-trace-tool mono">${esc(op.scope || 'ledger')} · ${esc(op.operationId)}</span>
                    <span class="cmd-trace-note">${esc(op.status)}</span>
                    <span class="cmd-trace-dur mono">${esc(fmtClock(op.updatedAt))}</span>
                  </div>`
                )
                .join('')}</div>`
            : `<div class="cmd-empty">近 24 小时没有写操作记录。</div>`
        }
      </div>`;
  }

  /* ------------------------------ 任务详情页 ------------------------------ */

  function typeLabel(stage) {
    return stage.type === 'hitl_gate' ? '人机闸口' : '自动节点';
  }

  function detailCallout(stage) {
    const d = state.detail || {};
    const status = String(stage.status || 'pending').toLowerCase();
    const note = d.stageNote ? `<div class="cmd-step-note">${esc(d.stageNote)}</div>` : '';
    const buttons = [];

    if (status === 'waiting_human') {
      buttons.push(`<button type="button" class="btn btn-primary btn-sm" data-cmd-approve>通过审核</button>`);
      buttons.push(`<button type="button" class="btn btn-danger btn-sm" data-cmd-reject>驳回</button>`);
    } else if (status === 'cancelled') {
      buttons.push(`<span class="tiny dim">任务已终止，如需重做请返回列表新建任务。</span>`);
    } else if (status === 'paused') {
      buttons.push(`<button type="button" class="btn btn-primary btn-sm" data-cmd-resume>继续任务</button>`);
      buttons.push(`<span class="tiny dim">已暂停：后续工序停止分派，继续后从当前工序恢复。</span>`);
    } else if (status === 'completed') {
      if (!d.completed) {
        buttons.push(`<button type="button" class="btn btn-primary btn-sm" data-cmd-advance>推进下一站</button>`);
      }
    } else {
      buttons.push(`<button type="button" class="btn btn-primary btn-sm" data-cmd-advance>推进</button>`);
      buttons.push(`<button type="button" class="btn btn-ghost btn-sm" data-cmd-complete>手动完成本阶段</button>`);
    }
    if (status !== 'cancelled' && !d.completed) {
      buttons.push(`<button type="button" class="cmd-link is-danger" data-cmd-task-cancel>终止任务</button>`);
    }

    return `<div class="cmd-step-callout">
      <div class="cmd-step-callout-title">${ui.icon('alert', 14)}<span>${
        esc(d.currentStageName ? '当前工序：' + d.currentStageName : '当前工序')
      } · ${stageMeta(status).label}</span></div>
      ${note}
      <textarea class="input cmd-step-note-input" rows="2" placeholder="审核意见 / 完成说明（可选）" data-cmd-task-note></textarea>
      <div class="cmd-step-actions">${buttons.join('')}</div>
    </div>`;
  }

  function stepHtml(stage, index) {
    const d = state.detail || {};
    const current = stage.code === d.currentStage;
    const meta = stageMeta(stage.status);
    return `<div class="cmd-step${current ? ' is-current' : ''}">
      <span class="cmd-step-no">${index + 1}</span>
      <div class="cmd-step-main">
        <div class="cmd-step-title">
          <span>${esc(stage.name || stage.code)}</span>
          ${ui.badge(typeLabel(stage), { tone: stage.type === 'hitl_gate' ? 'amber' : 'slate' })}
          ${ui.badge(meta.label, { tone: meta.tone, dot: true })}
        </div>
        <div class="cmd-step-meta mono">${esc(stage.code)}${stage.agent ? ' · ' + esc(stage.agent) : ''}${
          stage.skill ? ' · ' + esc(stage.skill) : ''
        }${stage.autoRule ? ' · 口径 ' + esc(stage.autoRule) : ''}</div>
        ${current ? detailCallout(stage) : ''}
      </div>
    </div>`;
  }

  function detailTracesHtml() {
    const recent = state.operations.slice(0, 8);
    if (!recent.length) {
      return `<div class="cmd-empty">近 24 小时没有写操作记录（读操作不计入账本）。</div>`;
    }
    return `<div class="cmd-traces">${recent
      .map(
        (op) => `<div class="cmd-trace">
          <span class="cmd-trace-time mono">${esc(fmtClock(op.createdAt))}</span>
          <span class="cmd-trace-tool mono">${esc(op.scope || 'ledger')} · ${esc(op.operationId)}</span>
          <span class="cmd-trace-note">${esc(op.status)}</span>
          <span class="cmd-trace-dur mono">${esc(fmtClock(op.updatedAt))}</span>
        </div>`
      )
      .join('')}</div>`;
  }

  function detailHtml() {
    const d = state.detail;
    const task = state.detailTask || {};
    if (!d && state.detailLoading) {
      return `<div class="cmd-empty"><span class="spinner"></span> 正在读取任务详情…</div>`;
    }
    if (!d) {
      return `<div class="cmd-card">
        <div class="cmd-card-head"><span>任务详情</span></div>
        <div class="cmd-alert">${esc(state.detailError || '任务详情读取失败')}</div>
        <div class="cmd-step-actions" style="margin-top:10px">
          <button type="button" class="btn btn-ghost btn-sm" data-cmd-task-back>返回任务列表</button>
        </div>
      </div>`;
    }

    const progress = d.stageTotal ? `${d.stageIndex}/${d.stageTotal}` : '—';
    return `<div class="cmd-detail">
      <div class="cmd-detail-bar">
        <button type="button" class="cmd-back" data-cmd-task-back>${ui.icon('chevron-left', 15)}<span>返回任务列表</span></button>
        <span class="cmd-detail-crumb">运行台 / 任务详情：<b>${esc(task.name || d.projectNo)}</b>${
          d.pipelineName ? `（工作流：${esc(d.pipelineName)}）` : ''
        }</span>
        <div class="cmd-detail-right">
          ${
            !d.completed && String(d.stageStatus || '').toLowerCase() !== 'cancelled'
              ? ui.btn({ label: '停止任务', icon: 'power', tone: 'danger', size: 'sm', attrs: 'data-cmd-stop' })
              : ui.badge(d.completed ? '任务已完成' : '已终止', { tone: d.completed ? 'green' : 'rose', dot: true })
          }
        </div>
      </div>

      <div class="cmd-card cmd-task-head">
        <div>
          <div class="cmd-task-head-title">当前任务 · ${esc(task.name || d.projectNo)}</div>
          <div class="cmd-task-head-sub mono">任务编号 ${esc(d.projectNo || task.id || '')} · ${
            (d.stages || []).length
          } 道工序</div>
        </div>
        <div class="cmd-task-head-progress">进度 <b>${esc(progress)}</b> 工序</div>
      </div>

      <div class="cmd-card">
        <div class="cmd-card-head"><span>工序推进</span><span class="tiny dim">按工作流配方顺序执行</span></div>
        <div class="cmd-steps">${(d.stages || []).map(stepHtml).join('')}</div>
      </div>

      <div class="cmd-card">
        <div class="cmd-card-head"><span>最近轨迹</span><span class="tiny dim">全局操作账本（近 24h）</span></div>
        ${detailTracesHtml()}
      </div>
    </div>`;
  }

  async function openTask(projectNo) {
    const task = state.tasks.find((t) => t.id === projectNo);
    state.view = 'task';
    state.panel = 'workbench';
    state.detailTask = task || { id: projectNo, name: projectNo };
    state.detail = null;
    state.detailError = null;
    state.detailLoading = true;
    paint();
    await refreshDetail();
  }

  function backToList() {
    state.view = 'list';
    state.detail = null;
    state.detailError = null;
    paint();
  }

  async function refreshDetail(reloadList) {
    const id = state.detailTask && state.detailTask.id;
    if (!id) return;
    if (reloadList !== false) {
      await loadAll();
      const fresh = state.tasks.find((t) => t.id === id);
      if (fresh) state.detailTask = fresh;
    }
    const res = await request('GET', '/api/business/products/' + encodeURIComponent(id) + '/pipeline');
    state.detailLoading = false;
    if (!res.ok || !res.data) {
      state.detailError = '读取失败：' + (res.error || '服务未连接');
    } else {
      state.detail = res.data;
      state.detailError = null;
    }
    paint();
  }

  function detailNote() {
    const el = document.querySelector('[data-cmd-task-note]');
    return el ? String(el.value || '').trim() : '';
  }

  async function taskAction(kind) {
    const id = state.detailTask && state.detailTask.id;
    if (!id) return;
    const base = '/api/business/products/' + encodeURIComponent(id) + '/pipeline';
    const note = detailNote();
    let res;
    let okMessage = '';

    if (kind === 'advance') {
      res = await request('POST', base + '/advance', {});
      okMessage = '已推进';
    } else if (kind === 'complete') {
      res = await request('POST', base + '/complete', { note });
      okMessage = '本阶段已标记完成';
    } else if (kind === 'approve') {
      res = await request('POST', base + '/approve', { approved: true, note });
      okMessage = '审核已通过';
    } else if (kind === 'reject') {
      res = await request('POST', base + '/approve', { approved: false, note });
      okMessage = '已驳回';
    } else if (kind === 'pause') {
      res = await request('POST', base + '/pause', { note: note || '指挥官界面暂停任务' });
      okMessage = '任务已暂停';
    } else if (kind === 'resume') {
      res = await request('POST', base + '/resume', { note: note || '指挥官界面恢复任务' });
      okMessage = '任务已恢复';
    } else if (kind === 'cancel') {
      const ok = await ui.confirm({
        title: '停止任务？',
        desc: '任务将标记为已终止，后续不能继续推进；如需重做请返回列表新建任务。',
        ok: '停止任务',
        cancel: '取消',
        tone: 'danger',
      });
      if (!ok) return;
      res = await request('POST', base + '/cancel', { note: note || '指挥官界面停止任务' });
      okMessage = '任务已停止';
    } else {
      return;
    }

    if (!res.ok) {
      toast('操作失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast(okMessage, 'success');
    await refreshDetail();
  }

  async function listTaskAction(kind, projectNo) {
    const task = state.tasks.find((t) => t.id === projectNo);
    if (!task) return;
    const base = '/api/business/products/' + encodeURIComponent(projectNo) + '/pipeline';

    if (kind === 'cancel') {
      const ok = await ui.confirm({
        title: '终止任务（安全刹车）？',
        desc: '将向编排引擎发出取消信号，熔断当前工作流，中断后续工序分派并销毁下游排队中的工具调用句柄；任务进入终态「已终止」，不可再推进。',
        ok: '终止任务',
        cancel: '取消',
        tone: 'danger',
      });
      if (!ok) return;
    }

    const res = await request('POST', base + '/' + kind, {
      note: kind === 'pause'
        ? '指挥官界面暂停任务'
        : kind === 'resume'
          ? '指挥官界面恢复任务'
          : '指挥官界面安全终止任务',
    });
    if (!res.ok) {
      toast((kind === 'pause' ? '暂停失败：' : kind === 'resume' ? '恢复失败：' : '终止失败：') + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast(kind === 'pause' ? '任务已暂停，后续工序已停止分派' : kind === 'resume' ? '任务已恢复' : '任务已终止（终态）', 'success');
    await loadAll();
    paint();
  }

  async function archiveTask(projectNo) {
    const task = state.tasks.find((t) => t.id === projectNo);
    if (!task) return;
    const ok = await ui.confirm({
      title: '归档任务？',
      desc: '归档是逻辑软删除：只更新 status = archived，不删除任何历史。任务会从默认列表隐藏，可在顶部「状态筛选 → 已归档」中追溯。',
      ok: '归档',
      cancel: '取消',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await request('POST', '/api/business/products/' + encodeURIComponent(projectNo) + '/pipeline/archive', {});
    if (!res.ok) {
      toast('归档失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast('任务已归档，可在「已归档」筛选中查看', 'success');
    await loadAll();
    paint();
  }

  async function deleteArchivedTask(projectNo) {
    const task = state.tasks.find((t) => t.id === projectNo);
    if (!task) return;
    const ok = await ui.confirm({
      title: '彻底删除归档任务？',
      desc: '将永久删除该任务及其规格 / 上架 / 素材 / 寻源记录，不可恢复；审计轨迹会保留。若存在订单明细，系统会拒绝删除。',
      ok: '彻底删除',
      cancel: '取消',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await request('DELETE', '/api/business/products/' + encodeURIComponent(projectNo) + '/pipeline', null);
    if (!res.ok) {
      toast('删除失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast('归档任务已彻底删除', 'success');
    await loadAll();
    paint();
  }

  async function openRetro(projectNo) {
    const task = state.tasks.find((t) => t.id === projectNo) || { id: projectNo, name: projectNo };
    const [pipeRes, auditRes] = await Promise.all([
      request('GET', '/api/business/products/' + encodeURIComponent(projectNo) + '/pipeline'),
      request('GET', '/api/audit/logs?keyword=' + encodeURIComponent(projectNo) + '&limit=30'),
    ]);
    if (!pipeRes.ok || !pipeRes.data) {
      toast('复盘读取失败：' + (pipeRes.error || '服务未连接'), 'warn');
      return;
    }
    const d = pipeRes.data;
    const st = taskState(task);
    const stages = Array.isArray(d.stages) ? d.stages : [];
    const audits = auditRes.ok && Array.isArray(auditRes.data) ? auditRes.data : [];
    const progress = d.stageTotal ? `${d.stageIndex}/${d.stageTotal}` : '—';
    const meta = [
      ['任务编号', `<span class="mono">${esc(d.projectNo || projectNo)}</span>`],
      ['工作流', esc(d.pipelineName || '未匹配配方')],
      ['终态', ui.badge(st.label, { tone: st.tone, dot: true })],
      ['工序进度', esc(progress)],
      ['来源', esc(d.triggerSource || '—')],
      ['说明', esc(d.stageNote || '—')],
    ];
    const stageHtml = stages.map((s, i) => {
      const sm = stageMeta(s.status);
      return `<div class="cmd-retro-stage">
        <span class="cmd-retro-stage-no">${i + 1}</span>
        <span class="cmd-retro-stage-name">${esc(s.name || s.code)}</span>
        ${ui.badge(sm.label, { tone: sm.tone, dot: true })}
      </div>`;
    }).join('');
    const auditHtml = audits.length
      ? audits.slice(0, 12).map((a) => `<div class="cmd-retro-audit">
          <span class="mono">${esc(fmtTime(a.at, true))}</span>
          <span class="mono">${esc(a.action || '—')}</span>
          ${ui.badge(a.statusLabel || a.status || '—', { tone: a.statusTone || 'slate', dot: true })}
          <span class="cmd-retro-audit-text">${esc(String(a.argumentsJson || '').slice(0, 160))}</span>
        </div>`).join('')
      : '<div class="cmd-empty">暂无该任务的审计记录。</div>';

    ui.modal({
      title: '任务复盘 · ' + esc(task.name || d.projectNo),
      desc: '复盘基于真实工序状态与审计轨迹生成；归档任务同样可追溯。',
      body: `<div class="cmd-retro">
        ${ui.kv(meta, { cls: 'cmd-retro-kv' })}
        <div class="cmd-retro-title">工序轨迹</div>
        <div class="cmd-retro-stages">${stageHtml || '<div class="cmd-empty">暂无工序。</div>'}</div>
        <div class="cmd-retro-title">审计记录 <span>${audits.length} 条</span></div>
        <div class="cmd-retro-audits">${auditHtml}</div>
      </div>`,
      actions: ui.btn({ label: '关闭', tone: 'ghost', attrs: 'data-modal-close' }),
    });
  }

  /* ------------------------------ 渲染：其它分区 ------------------------------ */

  /* ------------------------------ Chat 面板（会话 / 附件 / 群聊） ------------------------------ */

  function cwModelInfo() {
    const m = modelLabel();
    return { text: m.text, live: m.live, mode: m.mode };
  }

  /* 会话预览去 Markdown 标记：列表/标题只需要一句话，不显示 ** / ## / 表格线。 */
  function cwPreview(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#>*`|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cwTitle() {
    const sessions = state.cwSessions || [];
    const idx = sessions.findIndex((s) => s.conversationId === state.cwConversationId);
    if (state.cwKind === 'group' && state.cwGroup) {
      const n = (state.cwGroup.participants || []).length;
      return `${idx >= 0 ? `#${idx + 1} ` : ''}[群聊·${n}人] ${state.cwGroup.title || '未命名会诊'}`;
    }
    if (idx >= 0) {
      return `#${idx + 1} ${cwPreview(sessions[idx].preview || '未命名会话') || '未命名会话'}`;
    }
    return '新对话';
  }

  /* 聊天气泡的轻量 Markdown：先转义，再只放开粗体/行内代码/标题/列表/表格。
     模型输出常带 Markdown，直接 esc 会满屏 ** 与 |，这里保持安全且可读。 */
  function mdInline(raw) {
    let s = esc(raw);
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    return s;
  }

  function mdTableCells(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  }

  function renderChatMarkdown(raw) {
    const lines = String(raw || '').split(/\r?\n/);
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const next = i + 1 < lines.length ? lines[i + 1] : '';
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(next) && next.indexOf('-') !== -1) {
        const head = mdTableCells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          rows.push(mdTableCells(lines[i]));
          i++;
        }
        out.push(
          `<table class="md-table"><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead>` +
            `<tbody>${rows
              .map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`)
              .join('')}</tbody></table>`
        );
        continue;
      }
      if (/^\s*#{1,4}\s+/.test(line)) {
        out.push(`<div class="md-h">${mdInline(line.replace(/^\s*#{1,4}\s+/, ''))}</div>`);
        i++;
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        out.push(`<div class="md-li">• ${mdInline(line.replace(/^\s*[-*]\s+/, ''))}</div>`);
        i++;
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        out.push(`<div class="md-li">${mdInline(line)}</div>`);
        i++;
        continue;
      }
      if (/^\s*---+\s*$/.test(line)) {
        out.push('<hr class="md-hr" />');
        i++;
        continue;
      }
      if (!line.trim()) {
        out.push('<div class="md-gap"></div>');
        i++;
        continue;
      }
      out.push(`<div class="md-p">${mdInline(line)}</div>`);
      i++;
    }
    return out.join('');
  }

  function cwMessageHtml(m) {
    if (m.role === 'group') {
      return `<div class="cw-group">
        <div class="cw-group-head">${ui.icon('users', 14)} 群聊会诊 · ${(m.items || []).length} 位 Agent</div>
        <div class="cw-group-prompt">指令：${esc(m.text)}</div>
        ${(m.items || [])
          .map(
            (item) => `<div class="cw-group-item">
              <div class="cw-group-agent">${esc(item.name)}${item.meta ? `<span>${esc(item.meta)}</span>` : ''}</div>
              <div class="cw-bubble cw-bubble--group">${esc(item.text)}</div>
            </div>`
          )
          .join('')}
      </div>`;
    }
    return `<div class="cmd-msg cmd-msg--${m.role === 'user' ? 'user' : 'agent'}">
      <div class="cmd-bubble">${m.role === 'user' ? esc(m.text) : renderChatMarkdown(m.text)}</div>
      ${m.meta ? `<div class="cmd-msg-meta">${esc(m.meta)}</div>` : ''}
    </div>`;
  }

  /* 群聊单条发言：用户右对齐；专员左对齐带身份色圆点；指挥官为融合总结卡（带采纳按钮）。 */
  function cwGroupMessageHtml(m, index) {
    if (m.role === 'user') {
      return `<div class="cmd-msg cmd-msg--user">
        <div class="cmd-bubble">${esc(m.text)}</div>
        ${m.meta ? `<div class="cmd-msg-meta">${esc(m.meta)}</div>` : ''}
      </div>`;
    }
    const host = m.role === 'commander';
    return `<div class="cw-speak${host ? ' is-host' : ''}">
      <div class="cw-speak-head">
        <i class="cw-dot" data-agent="${esc(m.role)}"></i>
        <b>${esc(m.name || agentShort(m.role))}</b>
        ${host ? '<em class="cw-host-tag">主持 · 收敛</em>' : ''}
        <span>${esc(m.meta || '')}</span>
      </div>
      <div class="cw-speak-bubble${m.meta === 'error' ? ' is-error' : ''}">${renderChatMarkdown(m.text)}</div>
      ${
        host && m.canAdopt
          ? `<button type="button" class="cw-adopt" data-cw-adopt="${index}">✅ 采纳群聊决议并推进工序 ➔</button>`
          : ''
      }
    </div>`;
  }

  function cwParticipantsHtml() {
    if (state.cwKind !== 'group' || !state.cwGroup) return '';
    const participants = state.cwGroup.participants || [];
    return `<div class="cw-participants" data-cw-participants>
      <span class="cw-participants-label">参会 Agent</span>
      ${participants
        .map((key) => {
          const host = key === 'commander';
          const on = host || groupMentioned(key);
          return `<button type="button" class="cw-participant${on ? ' is-on' : ''}${host ? ' is-host' : ''}"
            data-cw-participant="${esc(key)}" title="${host ? '指挥官固定主持并收敛' : '点击切换本轮是否发言'}">
            <i class="cw-dot" data-agent="${esc(key)}"></i>${esc(agentShort(key))}
            ${host ? '<em>主持</em>' : ''}
          </button>`;
        })
        .join('')}
      <button type="button" class="cw-invite" data-cw-invite>${ui.icon('plus', 12)} 邀请 / 移除专员</button>
    </div>`;
  }

  function cwMentionBarHtml() {
    if (state.cwKind !== 'group' || !state.cwGroup) return '';
    const specialists = groupSpecialists();
    if (!specialists.length) return '';
    const allOn = specialists.every((k) => groupMentioned(k));
    return `<div class="cw-mentions" data-cw-mentions>
      <button type="button" class="cw-mention${allOn ? ' is-on' : ''}" data-cw-mention="all">@全体</button>
      ${specialists
        .map(
          (key) => `<button type="button" class="cw-mention${groupMentioned(key) ? ' is-on' : ''}"
            data-cw-mention="${esc(key)}">@${esc(agentShort(key))}</button>`
        )
        .join('')}
      <span class="cw-mentions-hint">被 @ 的专员各发言 1 次 → 指挥官收敛总结 1 次</span>
    </div>`;
  }

  function cwLogHtml() {
    if (state.cwKind === 'group' && state.cwGroup) {
      const messages = state.cwGroup.messages || [];
      const intro = `<div class="cw-group-intro">
        <div class="cw-group-intro-title">${ui.icon('users', 15)} Agent 群聊协同会诊</div>
        <div class="tiny dim">${(state.cwGroup.participants || []).map(agentShort).join(' · ')}</div>
        <div class="tiny dim">输入诉求并 @ 专员；专员严格按各自人格与工具授权发言，最后由指挥官收敛。</div>
      </div>`;
      const body = messages.map(cwGroupMessageHtml).join('');
      const typing = state.busy
        ? `<div class="cw-typing"><span></span><span></span><span></span> 会诊进行中：专员依次发言，指挥官收敛…</div>`
        : '';
      return intro + body + typing;
    }
    if (!state.chat.length) {
      const quick = ((state.profile && state.profile.quickPrompts) || [])
        .map((q) => `<button type="button" class="cmd-quick" data-cmd-quick="${esc(q)}">${esc(q)}</button>`)
        .join('');
      return `<div class="cw-empty">
        <div class="tiny dim">向指挥官发送一条消息开始会话，或点左下角 [+] 挂载附件 / 拉起群聊。</div>
        ${quick ? `<div class="cmd-quick-list">${quick}</div>` : ''}
      </div>`;
    }
    return state.chat.map(cwMessageHtml).join('');
  }

  function cwFileSize(size) {
    const n = Number(size) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function cwAttachmentsHtml() {
    if (!state.cwAttachments.length) return '';
    return state.cwAttachments
      .map(
        (a, i) => `<span class="cw-file" title="${esc((a.mime || '') + ' · ' + cwFileSize(a.size))}">
          ${esc(a.name)}
          <span class="cw-file-size">${cwFileSize(a.size)}</span>
          <button type="button" class="cw-file-del" data-cw-att-del="${i}" title="移除附件">×</button>
        </span>`
      )
      .join('');
  }

  function cwArchivedCount() {
    return (state.cwSessions || []).filter((s) => s.archived).length;
  }

  function cwArchiveToggleHtml() {
    const count = cwArchivedCount();
    if (!count && !state.cwShowArchived) return '';
    return `<button type="button" class="cw-archive-toggle${state.cwShowArchived ? ' is-on' : ''}" data-cw-toggle-archive>
      ${ui.icon('box', 12)} ${state.cwShowArchived ? '隐藏归档' : '归档箱'} <b>${count}</b>
    </button>`;
  }

  function cwCurrentArchived() {
    const hit = (state.cwSessions || []).find((s) => s.conversationId === state.cwConversationId);
    return !!(hit && hit.archived);
  }

  function cwSessionsHtml() {
    const all = state.cwSessions || [];
    if (!state.cwSessionsLoaded) {
      return `<div class="cw-session-empty">正在读取会话…</div>`;
    }
    if (!all.length) {
      return `<div class="cw-session-empty">还没有历史会话。</div>`;
    }
    const sessions = state.cwShowArchived ? all : all.filter((s) => !s.archived);
    if (!sessions.length) {
      return `<div class="cw-session-empty">没有进行中的会话${cwArchivedCount() ? '，点下方「归档箱」查看已归档' : ''}。</div>`;
    }
    return sessions
      .map((s, i) => {
        const on = s.conversationId === state.cwConversationId;
        const group = s.kind === 'group';
        const archived = !!s.archived;
        const label = group
          ? `<b class="cw-session-group">[群聊·${(s.participants || []).length}人]</b> ${esc(s.title || '未命名会诊')}`
          : esc(cwPreview(s.preview || '未命名会话') || '未命名会话');
        return `<div class="cw-session${on ? ' is-on' : ''}${group ? ' is-group' : ''}${archived ? ' is-archived' : ''}">
          <button type="button" class="cw-session-main" data-cw-session="${esc(s.conversationId)}"
            title="${esc(s.conversationId)} · ${s.messageCount || 0} 条消息${archived ? ' · 已归档（只读）' : ''}">
            <span class="cw-session-idx">#${i + 1}</span>
            <span class="cw-session-text">${archived ? '<em class="cw-archived-tag">已归档</em>' : ''}${label}</span>
          </button>
          <span class="cw-session-actions">
            <button type="button" class="cw-session-act" data-cw-archive-session="${esc(s.conversationId)}"
              data-cw-archive-to="${archived ? '0' : '1'}" title="${archived ? '恢复会话' : '归档会话'}">
              ${ui.icon(archived ? 'refresh' : 'box', 12)}
            </button>
            <button type="button" class="cw-session-act is-danger" data-cw-delete-session="${esc(s.conversationId)}"
              title="删除会话">${ui.icon('trash', 12)}</button>
          </span>
        </div>`;
      })
      .join('');
  }

  function cwContextHtml() {
    const memory = state.cwMemory || { memories: [], knowledge: [] };
    const skills = (state.profile && state.profile.allowedTools) || [];
    const skillText = skills.includes('*') ? '全部' : String(skills.length);
    return `<div class="cw-context">
      <div class="cw-context-title">当前注入上下文</div>
      <div class="cw-context-line">长期记忆 <b>${(memory.memories || []).length}</b> 条 · 知识库 <b>${(memory.knowledge || []).length}</b> 篇</div>
      <div class="cw-context-line">挂载 Skill <b>${esc(skillText)}</b>${skills.includes('*') ? '' : ' 个'}</div>
    </div>`;
  }

  function chatHtml() {
    const model = cwModelInfo();
    const archived = cwCurrentArchived();
    return `<div class="cw">
      <aside class="cw-side">
        <button type="button" class="cw-new" data-cw-new>+ 新对话</button>
        <div class="cw-sessions" data-cw-sessions>${cwSessionsHtml()}</div>
        ${cwArchiveToggleHtml()}
        ${cwContextHtml()}
      </aside>
      <section class="cw-main">
        <div class="cw-head">
          <div class="cw-head-title">${esc(cwTitle())}</div>
          ${
            state.cwKind === 'group'
              ? ui.badge('群聊会诊', { tone: 'violet', dot: true })
              : ''
          }
          ${archived ? ui.badge('已归档', { tone: 'amber', dot: true }) : ''}
          ${ui.badge(model.live ? 'Live 真实模型（' + model.text + '）' : '离线模型', {
            tone: model.live ? 'green' : 'slate',
            dot: true,
          })}
          ${ui.btn({ label: '清空', icon: 'refresh', tone: 'ghost', size: 'sm', attrs: 'data-cw-clear' })}
          ${ui.btn({ label: '导出 Markdown', icon: 'download', tone: 'ghost', size: 'sm', attrs: 'data-cw-export' })}
        </div>
        ${
          archived
            ? `<div class="cw-archived-banner">此会话已归档（只读）。点左侧 <b>归档箱</b> 里的恢复按钮后可继续对话，或直接删除。</div>`
            : ''
        }
        ${archived ? '' : cwParticipantsHtml()}
        <div class="cw-log" data-cw-log>${cwLogHtml()}</div>
        ${archived ? '' : cwMentionBarHtml()}
        <div class="cw-attachments" data-cw-attachments>${cwAttachmentsHtml()}</div>
        <div class="cw-input-wrap">
          <button type="button" class="cw-plus" data-cw-plus title="更多"${archived ? ' disabled' : ''}>+</button>
          <div class="cw-plus-menu" data-cw-plus-menu hidden>
            <button type="button" class="cw-plus-item" data-cw-group>
              <span class="cw-plus-ico">👥</span>
              <span><b>拉起 Agent 群聊</b><em>多专员协同会诊</em></span>
            </button>
            <button type="button" class="cw-plus-item" data-cw-file="doc">
              <span class="cw-plus-ico">📎</span>
              <span><b>上传附件</b><em>Excel / CSV / PDF</em></span>
            </button>
            <button type="button" class="cw-plus-item" data-cw-file="media">
              <span class="cw-plus-ico">🖼️</span>
              <span><b>上传商品图 / 视频</b><em>图片、短视频素材</em></span>
            </button>
          </div>
          <input class="input cw-input" placeholder="${
            archived
              ? '已归档会话（只读）…'
              : state.cwKind === 'group'
                ? '输入会诊诉求，@ 专员发言…（Enter 发送）'
                : '输入您想发送给指挥官的指令或反馈…'
          }" data-cw-input autocomplete="off"${archived ? ' disabled' : ''} />
          <button type="button" class="cw-send" data-cw-send${state.busy || archived ? ' disabled' : ''}>发送 ↵</button>
        </div>
      </section>
    </div>`;
  }

  /* ------------------------------ 工作流管理（配方编排） ------------------------------ */

  const WF_SOURCE_LABEL = {
    douyin_compass: '抖音罗盘 MCP',
    jushuitan: '聚水潭 MCP',
    ai_autonomous: 'AI 选品',
  };

  const WF_AGENT_LABEL = {
    commander: 'Commander 指挥官',
    scout: 'Scout 选品',
    sourcing: 'Sourcing 供应链',
    creative: 'Creative 内容',
    publisher: 'Publisher 上架',
    analyst: 'Analyst 分析',
  };

  function wfSourceLabel(source) {
    return WF_SOURCE_LABEL[source] || source || '未声明';
  }

  function wfAgentLabel(agent) {
    return WF_AGENT_LABEL[agent] || agent || '未指定';
  }

  function clonePipeline(recipe) {
    return JSON.parse(JSON.stringify(recipe));
  }

  function wfDirty(mark) {
    if (mark !== undefined) state.wfDirty = !!mark;
    return state.wfDirty;
  }

  function ensureWfDraft() {
    if (state.wfDraft && state.pipelines.some((p) => p.pipelineId === state.wfSelectedId)) return;
    const ordered = state.pipelines.slice().sort((a, b) => {
      const ea = a.enabled === false ? 1 : 0;
      const eb = b.enabled === false ? 1 : 0;
      return ea - eb || String(a.pipelineId).localeCompare(String(b.pipelineId));
    });
    const first = ordered[0];
    if (!first) {
      state.wfSelectedId = null;
      state.wfDraft = null;
      wfDirty(false);
      return;
    }
    state.wfSelectedId = first.pipelineId;
    state.wfDraft = clonePipeline(first);
    wfDirty(false);
  }

  function wfFiltered() {
    const kw = String(state.wfSearch || '').trim().toLowerCase();
    const source = state.wfSource || 'all';
    return state.pipelines
      .filter((p) => {
        if (source !== 'all' && String(p.triggerSource || '') !== source) return false;
        if (kw && (p.name + ' ' + p.pipelineId).toLowerCase().indexOf(kw) === -1) return false;
        return true;
      })
      .sort((a, b) => {
        const ea = a.enabled === false ? 1 : 0;
        const eb = b.enabled === false ? 1 : 0;
        return ea - eb || String(a.pipelineId).localeCompare(String(b.pipelineId));
      });
  }

  function wfStageCard(stage, index) {
    const isGate = String(stage.type || '').toLowerCase() === 'hitl_gate';
    const meta = [
      'Agent: ' + wfAgentLabel(stage.agent),
      stage.skill ? 'Skill: ' + stage.skill : '',
      stage.mode ? '模式: ' + stage.mode : '',
    ].filter(Boolean).join(' | ');

    return `<div class="wf-stage${isGate ? ' is-gate' : ''}" data-wf-stage="${index}" draggable="true">
      <span class="wf-grip" title="拖拽调整顺序">⋮⋮</span>
      <div class="wf-stage-main">
        <div class="wf-stage-title">
          <span class="wf-stage-no">${index + 1}</span>
          <b>${esc(stage.name || stage.code)}</b>
          <span class="wf-stage-code mono">${esc(stage.code)}</span>
          ${isGate ? ui.badge('人机闸口 HITL', { tone: 'amber', dot: true }) : ui.badge('自动节点', { tone: 'slate' })}
        </div>
        ${isGate ? '' : `<div class="wf-stage-meta">${esc(meta)}</div>`}
      </div>
      <div class="wf-stage-actions">
        <button type="button" class="wf-stage-edit" data-wf-edit="${index}">配置</button>
        <button type="button" class="wf-stage-del" data-wf-stage-del="${index}" title="删除该工序节点" draggable="false">${ui.icon('trash', 13)}</button>
      </div>
      ${
        isGate
          ? `<div class="wf-gate-row">
              <span class="wf-gate-rule">规则: ${esc(stage.autoRule || '未声明自动初筛规则')}</span>
              <div class="wf-gate-switch" title="关闭后符合规则的任务将自动放行">
                <span>需人工确认</span>
                ${ui.switchControl({ checked: stage.requireHuman !== false, attrs: `data-wf-gate="${index}"` })}
              </div>
            </div>`
          : ''
      }
    </div>`;
  }

  function wfListHtml() {
    const rows = wfFiltered();
    if (!rows.length) {
      return `<div class="cmd-empty">没有匹配的工作流配方。</div>`;
    }
    return rows
      .map((p) => {
        const on = p.pipelineId === state.wfSelectedId;
        return `<button type="button" class="wf-card${on ? ' is-on' : ''}" data-wf-select="${esc(p.pipelineId)}">
          <div class="wf-card-head">
            <span class="wf-card-name">${esc(p.name)}</span>
            ${ui.badge(p.enabled === false ? '已停用' : '启用中', { tone: p.enabled === false ? 'slate' : 'green', dot: true })}
          </div>
          <div class="wf-card-id mono">${esc(p.pipelineId)}</div>
          <div class="wf-card-sum">触发源: ${esc(wfSourceLabel(p.triggerSource))} | ${p.stageCount} 道工序</div>
          ${p.description ? `<div class="wf-card-desc">${esc(p.description)}</div>` : ''}
        </button>`;
      })
      .join('');
  }

  function wfEditorHtml() {
    const d = state.wfDraft;
    if (!d) {
      return `<div class="cmd-card"><div class="cmd-empty">左侧还没有工作流配方，点右上角「新建工作流配方」创建。</div></div>`;
    }
    return `<div class="wf-editor">
      <div class="wf-editor-head">
        <div class="wf-editor-title">
          <b>工序节点编排器 · ${esc(d.name)}</b>
          <span class="mono">${esc(d.pipelineId)}</span>
        </div>
        <label class="wf-enable" title="停用后该配方不参与来源解析">
          <span>启用配方</span>
          ${ui.switchControl({ checked: d.enabled !== false, attrs: 'data-wf-enabled' })}
        </label>
      </div>
      <div class="wf-stages" data-wf-stages>
        ${(d.stages || []).map(wfStageCard).join('') ||
          '<div class="cmd-empty">还没有工序，点左下角「插入工序节点」开始编排。</div>'}
      </div>
      <div class="wf-foot">
        <div class="wf-foot-left">
          ${ui.btn({ label: '插入工序节点', icon: 'plus', tone: 'ghost', size: 'sm', attrs: 'data-wf-insert' })}
          ${ui.btn({ label: '预览 YAML 配方', icon: 'eye', tone: 'ghost', size: 'sm', attrs: 'data-wf-preview' })}
        </div>
        <div class="wf-foot-right">
          ${ui.btn({ label: '保存工作流', icon: 'check', tone: 'primary', size: 'sm', attrs: 'data-wf-save' })}
          ${ui.btn({ label: '删除', icon: 'trash', tone: 'danger', size: 'sm', attrs: 'data-wf-delete' })}
        </div>
      </div>
    </div>`;
  }

  function pipelinesHtml() {
    ensureWfDraft();
    const sourceOptions = [{ value: 'all', label: '触发来源: 全部' }];
    const seen = new Set();
    state.pipelines.forEach((p) => {
      const s = String(p.triggerSource || '');
      if (!s || seen.has(s)) return;
      seen.add(s);
      sourceOptions.push({ value: s, label: '触发来源: ' + wfSourceLabel(s) });
    });

    return `<div class="wf-page">
      <div class="wf-top">
        <div class="wf-top-left">
          <span class="wf-title">工作流管理</span>
          <label class="cmd-search wf-search">${ui.icon('search', 14)}
            <input class="input" placeholder="搜索工作流名称 / ID…" data-wf-search value="${esc(state.wfSearch || '')}" />
          </label>
          ${ui.select({ options: sourceOptions, value: state.wfSource || 'all', attrs: 'data-wf-source' })}
        </div>
        <div class="wf-top-right">
          ${ui.btn({ label: '导入/导出 YAML', icon: 'upload', tone: 'ghost', size: 'sm', attrs: 'data-wf-yaml' })}
          ${ui.btn({ label: '新建工作流配方', icon: 'plus', tone: 'primary', size: 'sm', attrs: 'data-wf-new' })}
        </div>
      </div>
      <div class="wf-body">
        <aside class="wf-list">
          <div class="wf-list-head">工作流配方列表<span class="cmd-count">${wfFiltered().length}</span></div>
          <div class="wf-list-body">${wfListHtml()}</div>
        </aside>
        <section class="wf-right">${wfEditorHtml()}</section>
      </div>
    </div>`;
  }

  /* ------------------------------ 工序节点弹窗 ------------------------------ */

  function openStageModal(mode, index) {
    const d = state.wfDraft;
    if (!d) return;
    const editing = mode === 'edit';
    const stage = editing
      ? d.stages[index]
      : { code: '', name: '', type: 'auto', agent: 'scout', skill: '', mode: '', panel: '', autoRule: '', requireHuman: true };

    const positionOptions = [{ value: String(d.stages.length), label: '插入到末尾' }].concat(
      (d.stages || []).map((s, i) => ({ value: String(i + 1), label: `在第 ${i + 1} 步 [${s.name || s.code}] 之后` }))
    );
    const agentOptions = (state.wfAgents || []).map((a) => ({
      value: a.key,
      label: wfAgentLabel(a.key) + '（' + (a.displayName || a.key) + '）',
    }));
    if (!agentOptions.length) {
      Object.keys(WF_AGENT_LABEL).forEach((k) => agentOptions.push({ value: k, label: WF_AGENT_LABEL[k] }));
    }

    const overlay = ui.modal({
      title: editing ? '配置工序节点' : '插入 / 配置工序节点（Insert Stage Node）',
      desc: editing
        ? '修改后需点「保存工作流」才会写入 YAML 配方。'
        : '按顺序插入工序：自动节点交给 Agent 执行，人机闸口在执行时挂起等待人工确认。',
      body: `<div class="wf-form">
        ${editing ? '' : `<label class="field"><span class="field-label">插入位置</span>${ui.select({ options: positionOptions, value: String(d.stages.length), attrs: 'data-wf-pos' })}</label>`}
        <div class="field">
          <span class="field-label">节点类型</span>
          <div class="wf-type-row">
            <button type="button" class="wf-type${stage.type !== 'hitl_gate' ? ' is-on' : ''}" data-wf-type="auto">🤖 Agent 自动执行节点</button>
            <button type="button" class="wf-type${stage.type === 'hitl_gate' ? ' is-on' : ''}" data-wf-type="hitl_gate">🟠 人机审核闸口（HITL Gate）</button>
          </div>
          <input type="hidden" data-f="type" value="${stage.type === 'hitl_gate' ? 'hitl_gate' : 'auto'}" />
        </div>
        <div class="wf-form-row">
          <label class="field"><span class="field-label">工序名称</span>${ui.input({ value: stage.name || '', placeholder: '如：推入店铺草稿箱', attrs: 'data-f="name"' })}</label>
          <label class="field"><span class="field-label">工序编码</span>${ui.input({ value: stage.code || '', placeholder: '如：push_shop_draft', attrs: 'data-f="code"' })}</label>
        </div>
        <label class="field"><span class="field-label">指派负责 Agent</span>${ui.select({ options: agentOptions, value: stage.agent || 'scout', attrs: 'data-f="agent"' })}</label>
        <label class="field"><span class="field-label">绑定 Skill / MCP 能力</span>${ui.input({ value: stage.skill || '', placeholder: '如：shop_draft_skill（可留空，执行时按 Agent 授权工具）', attrs: 'data-f="skill"' })}</label>
        <div class="wf-form-row">
          <label class="field"><span class="field-label">执行模式（可空）</span>${ui.input({ value: stage.mode || '', placeholder: '如：listing_0 / direct_publish', attrs: 'data-f="mode"' })}</label>
          <label class="field"><span class="field-label">右侧面板（可空）</span>${ui.select({
            options: [
              { value: '', label: '默认' },
              { value: 'qualification', label: '资格/准入审核' },
              { value: 'media_compare', label: '素材对比' },
            ],
            value: stage.panel || '',
            attrs: 'data-f="panel"',
          })}</label>
        </div>
        <div class="wf-gate-fields" data-wf-gate-fields${stage.type === 'hitl_gate' ? '' : ' hidden'}>
          <label class="field"><span class="field-label">自动初筛规则（展示给人工）</span>${ui.input({ value: stage.autoRule || '', placeholder: '如：毛利率≥35% 且 工厂分≥4.5', attrs: 'data-f="autoRule"' })}</label>
          <label class="field wf-inline-field"><span class="field-label">需人工确认</span>
            ${ui.switchControl({ checked: stage.requireHuman !== false, attrs: 'data-f="requireHuman"' })}
            <span class="tiny dim">关闭后符合规则的节点自动放行，不挂起</span>
          </label>
        </div>
      </div>`,
      actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}
        ${editing ? ui.btn({ label: '从配方移除', tone: 'ghost', attrs: 'data-wf-remove', cls: 'mcp-act--danger' }) : ''}
        ${ui.btn({ label: editing ? '保存节点' : '确认插入节点', tone: 'primary', attrs: 'data-wf-stage-ok' })}`,
    });

    overlay.addEventListener('click', (e) => {
      const typeBtn = e.target.closest('[data-wf-type]');
      if (typeBtn) {
        const type = typeBtn.dataset.wfType;
        const hidden = overlay.querySelector('[data-f="type"]');
        if (hidden) hidden.value = type;
        overlay.querySelectorAll('[data-wf-type]').forEach((b) => b.classList.toggle('is-on', b === typeBtn));
        const gateFields = overlay.querySelector('[data-wf-gate-fields]');
        if (gateFields) gateFields.hidden = type !== 'hitl_gate';
        return;
      }

      if (e.target.closest('[data-wf-remove]')) {
        overlay.close();
        d.stages.splice(index, 1);
        wfDirty(true);
        paint();
        return;
      }

      if (!e.target.closest('[data-wf-stage-ok]')) return;

      const read = (k) => {
        const el = overlay.querySelector('[data-f="' + k + '"]');
        return el ? String(el.value || '').trim() : '';
      };
      const type = read('type') || 'auto';
      const name = read('name');
      const code = (read('code') || '').toLowerCase();
      if (!name || !code) {
        toast('工序名称与编码不能为空', 'warn');
        return;
      }
      if (!/^[a-z][a-z0-9_]{1,63}$/.test(code)) {
        toast('工序编码只允许小写字母开头、字母/数字/下划线（如 push_shop_draft）', 'warn');
        return;
      }
      if (d.stages.some((s, i) => s.code === code && i !== index)) {
        toast('工序编码重复：' + code, 'warn');
        return;
      }

      const requireEl = overlay.querySelector('[data-f="requireHuman"]');
      const next = {
        code,
        name,
        type,
        agent: read('agent') || null,
        skill: read('skill') || null,
        mode: read('mode') || null,
        panel: read('panel') || null,
        autoRule: type === 'hitl_gate' ? read('autoRule') || null : null,
        requireHuman: type === 'hitl_gate' ? (requireEl ? !!requireEl.checked : true) : true,
        next: null,
      };

      if (editing) {
        d.stages[index] = next;
      } else {
        const posEl = overlay.querySelector('[data-wf-pos]');
        const pos = Math.max(0, Math.min(d.stages.length, Number(posEl ? posEl.value : d.stages.length) || 0));
        d.stages.splice(pos, 0, next);
      }
      wfDirty(true);
      overlay.close();
      paint();
    });
  }

  /* ------------------------------ YAML / 新建 弹窗 ------------------------------ */

  async function openYamlModal() {
    if (!state.wfDraft) return;
    const exported = await request('GET', '/api/pipelines/' + encodeURIComponent(state.wfDraft.pipelineId) + '/yaml');
    const yamlText = exported.ok && exported.data ? exported.data.yaml || '' : '';

    const overlay = ui.modal({
      title: '导入 / 导出 YAML 配方',
      desc: '直接对接后端 pipelines/*.yaml：导出当前配方文本，或粘贴 YAML 导入（同 ID 覆盖）。',
      body: `<div class="wf-yaml-block">
        <div class="wf-yaml-title">导出当前配方</div>
        <textarea class="input wf-yaml-text" rows="10" readonly data-wf-yaml-out>${esc(yamlText)}</textarea>
        <div class="wf-yaml-actions">
          ${ui.btn({ label: '复制', icon: 'copy', tone: 'ghost', size: 'sm', attrs: 'data-wf-yaml-copy' })}
          ${ui.btn({ label: '下载 .yaml', icon: 'download', tone: 'ghost', size: 'sm', attrs: 'data-wf-yaml-download' })}
        </div>
      </div>
      <div class="wf-yaml-block">
        <div class="wf-yaml-title">导入 YAML（保存后立即生效）</div>
        <textarea class="input wf-yaml-text" rows="8" placeholder="粘贴 pipeline_id / stages …" data-wf-yaml-in></textarea>
        <div class="wf-yaml-actions">
          ${ui.btn({ label: '导入并保存', icon: 'upload', tone: 'primary', size: 'sm', attrs: 'data-wf-yaml-import' })}
        </div>
      </div>`,
      actions: `${ui.btn({ label: '关闭', tone: 'ghost', attrs: 'data-modal-close' })}`,
    });

    overlay.addEventListener('click', async (e) => {
      if (e.target.closest('[data-wf-yaml-copy]')) {
        try {
          await navigator.clipboard.writeText(yamlText);
          toast('YAML 已复制', 'success');
        } catch (_) {
          toast('复制失败，请手动选择文本', 'warn');
        }
        return;
      }
      if (e.target.closest('[data-wf-yaml-download]')) {
        downloadText(state.wfDraft.pipelineId + '.yaml', yamlText, 'text/yaml;charset=utf-8');
        return;
      }
      if (e.target.closest('[data-wf-yaml-import]')) {
        const input = overlay.querySelector('[data-wf-yaml-in]');
        const yaml = input ? String(input.value || '') : '';
        if (!yaml.trim()) {
          toast('请粘贴 YAML 内容', 'warn');
          return;
        }
        const res = await request('POST', '/api/pipelines/import', { yaml });
        if (!res.ok) {
          toast('导入失败：' + (res.error || '服务未连接'), 'warn');
          return;
        }
        overlay.close();
        toast('YAML 已导入：' + (res.data && res.data.pipelineId), 'success');
        await loadAll();
        state.wfSelectedId = res.data && res.data.pipelineId;
        state.wfDraft = res.data ? clonePipeline(res.data) : null;
        wfDirty(false);
        paint();
      }
    });
  }

  async function openPreviewModal() {
    if (!state.wfDraft) return;
    const res = await request('POST', '/api/pipelines/preview', state.wfDraft);
    if (!res.ok) {
      toast('生成失败：' + (res.error || '配方校验未通过'), 'warn');
      return;
    }
    const yaml = (res.data && res.data.yaml) || '';
    const overlay = ui.modal({
      title: '预览 YAML 配方',
      desc: '这是「保存工作流」会写入 pipelines/*.yaml 的最终内容（next 指针由服务端按顺序生成）。',
      body: `<textarea class="input wf-yaml-text" rows="16" readonly data-wf-preview-out>${esc(yaml)}</textarea>`,
      actions: `${ui.btn({ label: '复制', icon: 'copy', tone: 'ghost', attrs: 'data-wf-preview-copy' })}
        ${ui.btn({ label: '关闭', tone: 'ghost', attrs: 'data-modal-close' })}`,
    });
    overlay.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-wf-preview-copy]')) return;
      try {
        await navigator.clipboard.writeText(yaml);
        toast('YAML 已复制', 'success');
      } catch (_) {
        toast('复制失败，请手动选择文本', 'warn');
      }
    });
  }

  function downloadText(fileName, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function openNewWorkflowModal() {
    const overlay = ui.modal({
      title: '新建工作流配方',
      desc: '创建后写入 pipelines/<pipeline_id>.yaml，并带一个默认「选品抓取」工序，可在右侧继续编排。',
      body: `<div class="wf-form">
        <label class="field"><span class="field-label">配方名称</span>${ui.input({ placeholder: '如：小红书种草转化流', attrs: 'data-f="name"' })}</label>
        <label class="field"><span class="field-label">配方 ID（小写字母/数字/._-）</span>${ui.input({ placeholder: '如：xhs_seed_flow', attrs: 'data-f="id"' })}</label>
        <label class="field"><span class="field-label">触发来源</span>${ui.input({ value: 'douyin_compass', placeholder: '如：douyin_compass / jushuitan / ai_autonomous', attrs: 'data-f="source"' })}</label>
        <label class="field"><span class="field-label">说明（可空）</span>${ui.input({ placeholder: '一句话描述这条流水线', attrs: 'data-f="desc"' })}</label>
      </div>`,
      actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}
        ${ui.btn({ label: '创建配方', tone: 'primary', attrs: 'data-wf-new-ok' })}`,
    });

    overlay.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-wf-new-ok]')) return;
      const val = (k) => {
        const el = overlay.querySelector('[data-f="' + k + '"]');
        return el ? String(el.value || '').trim() : '';
      };
      const name = val('name');
      const id = val('id').toLowerCase();
      const source = val('source').toLowerCase();
      if (!name || !id || !source) {
        toast('名称、ID、触发来源都不能为空', 'warn');
        return;
      }
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
        toast('配方 ID 只允许小写字母/数字/._-', 'warn');
        return;
      }

      const res = await request('POST', '/api/pipelines', {
        pipelineId: id,
        name,
        triggerSource: source,
        description: val('desc') || null,
        enabled: true,
        stages: [
          { code: 'scout_ingest', name: '选品抓取', type: 'auto', agent: 'scout', skill: 'compass_fetch_skill', requireHuman: true },
        ],
      });
      if (!res.ok) {
        toast('创建失败：' + (res.error || '服务未连接'), 'warn');
        return;
      }
      overlay.close();
      toast('配方已创建：' + id, 'success');
      await loadAll();
      state.wfSelectedId = id;
      state.wfDraft = res.data ? clonePipeline(res.data) : null;
      wfDirty(false);
      paint();
    });
  }

  async function saveWorkflow() {
    const d = state.wfDraft;
    if (!d) return;
    if (!(d.stages || []).length) {
      toast('至少需要一个工序节点', 'warn');
      return;
    }
    const body = {
      pipelineId: d.pipelineId,
      name: d.name,
      triggerSource: d.triggerSource,
      description: d.description || null,
      enabled: d.enabled !== false,
      stages: d.stages.map((s) => ({
        code: s.code,
        name: s.name || null,
        type: s.type || 'auto',
        agent: s.agent || null,
        skill: s.skill || null,
        mode: s.mode || null,
        panel: s.panel || null,
        autoRule: s.autoRule || null,
        requireHuman: s.requireHuman !== false,
      })),
    };
    const res = await request('PUT', '/api/pipelines/' + encodeURIComponent(d.pipelineId), body);
    if (!res.ok) {
      toast('保存失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast('工作流已保存并生效', 'success');
    await loadAll();
    state.wfDraft = res.data ? clonePipeline(res.data) : null;
    wfDirty(false);
    paint();
  }

  async function deleteWorkflow() {
    const d = state.wfDraft;
    if (!d) return;
    const ok = await ui.confirm({
      title: '删除工作流配方？',
      desc: `「${d.name}」将从 pipelines/${d.pipelineId}.yaml 删除；仍被任务引用时后端会拒绝。`,
      ok: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await request('DELETE', '/api/pipelines/' + encodeURIComponent(d.pipelineId));
    if (!res.ok) {
      toast('删除失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast('工作流配方已删除', 'success');
    state.wfSelectedId = null;
    state.wfDraft = null;
    wfDirty(false);
    await loadAll();
    ensureWfDraft();
    paint();
  }

  async function selectWorkflow(id) {
    if (id === state.wfSelectedId) return;
    if (wfDirty()) {
      const drop = await ui.confirm({
        title: '放弃未保存的修改？',
        desc: '切换配方会丢失当前未保存的编排修改。',
        ok: '放弃修改',
        tone: 'danger',
      });
      if (!drop) return;
    }
    const recipe = state.pipelines.find((p) => p.pipelineId === id);
    state.wfSelectedId = id;
    state.wfDraft = recipe ? clonePipeline(recipe) : null;
    wfDirty(false);
    paint();
  }

  const MEM_SOURCE_LABEL = {
    manual: '手动录入',
    selflearn: '自学习',
    reflection: '复盘归纳',
    rule: '规则导入',
  };

  const MEM_STATUS = {
    pending: { label: '待确认', tone: 'amber', dot: true },
    verified: { label: '已生效', tone: 'green', dot: true },
    active: { label: '已生效', tone: 'green', dot: true },
    archived: { label: '已归档', tone: 'slate', dot: true },
    rejected: { label: '已驳回', tone: 'rose', dot: true },
    expired: { label: '已过期', tone: 'slate', dot: true },
  };

  function memNo(id) {
    return String(id).padStart(3, '0');
  }

  function memTagsOf(tags) {
    const parts = String(tags || '')
      .split(/[\s,，#;；]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    return parts.length ? [...new Set(parts)] : ['全局'];
  }

  function memTagChips(tags) {
    return memTagsOf(tags)
      .map((t) => `<span class="cmd-mem-tag">#${esc(t)}</span>`)
      .join('');
  }

  function memStatusBadge(status) {
    const meta = MEM_STATUS[String(status || '').toLowerCase()] || { label: status || '未知', tone: 'slate', dot: true };
    return ui.badge(meta.label, { tone: meta.tone, dot: meta.dot });
  }

  function memSourceLabel(sourceType) {
    return MEM_SOURCE_LABEL[String(sourceType || '').toLowerCase()] || sourceType || '未知来源';
  }

  function memSyncText(m) {
    const keys = m.syncAgentKeys || [];
    if (!keys.length) return '仅本 Agent';
    return '同步至: ' + keys.map((k) => allAgentLabel(k)).join('、');
  }

  function memExpiryText(m) {
    if (!m.expiresAt) return '永久';
    const at = new Date(m.expiresAt);
    if (isNaN(at.getTime())) return '永久';
    const days = Math.ceil((at.getTime() - Date.now()) / 86400000);
    return days > 0 ? days + '天有效' : '已过期';
  }

  function memLifeText(m) {
    if (m.sampleCount != null) return '样本 ' + m.sampleCount + ' 项';
    return '已命中 ' + Number(m.hitCount || 0) + ' 次';
  }

  function memTagOptions() {
    const set = new Set();
    ((state.memory && state.memory.memories) || []).forEach((m) => memTagsOf(m.tags).forEach((t) => set.add(t)));
    return [{ value: 'all', label: '适用标签：全部' }].concat(
      [...set].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((t) => ({ value: t, label: '#' + t }))
    );
  }

  function memStatusOptions() {
    return [
      { value: 'all', label: '状态：全部' },
      { value: 'pending', label: '状态：待人工确认' },
      { value: 'verified', label: '状态：已生效' },
      { value: 'archived', label: '状态：已归档' },
      { value: 'rejected', label: '状态：已驳回' },
    ];
  }

  function memFilteredMemories() {
    const memories = (state.memory && state.memory.memories) || [];
    const q = String(state.memSearch || '').trim().toLowerCase();
    const tag = state.memTag;
    const status = state.memStatus;
    return memories.filter((m) => {
      const st = String(m.status || '').toLowerCase();
      if (status !== 'all' && st !== status) return false;
      if (tag !== 'all' && memTagsOf(m.tags).indexOf(tag) === -1) return false;
      if (q) {
        const hay = [m.subject, m.metric, m.valueText, m.tags, m.sourceType].join(' ').toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function memRowHtml(m) {
    const status = String(m.status || '').toLowerCase();
    const pending = status === 'pending';
    const conflict = m.conflict;
    const actions = [];
    if (status !== 'archived' && status !== 'rejected' && status !== 'deleted') {
      actions.push(`<button type="button" class="cmd-mem-act" data-cmd-mem-edit="${m.id}">编辑</button>`);
    }
    if (pending) {
      actions.push(
        `<button type="button" class="cmd-mem-act is-primary" data-cmd-mem-confirm="${m.id}">${
          conflict ? '确认并替换' : '确认生效'
        }</button>`
      );
      actions.push(`<button type="button" class="cmd-mem-act" data-cmd-mem-reject="${m.id}">驳回</button>`);
    } else if (status === 'verified' || status === 'active') {
      actions.push(`<button type="button" class="cmd-mem-act" data-cmd-mem-archive="${m.id}">归档</button>`);
    }
    actions.push(`<button type="button" class="cmd-mem-act is-danger" data-cmd-mem-delete="${m.id}">删除</button>`);

    return `<div class="cmd-mem-row${pending ? ' is-pending' : ''}">
      <div class="cmd-mem-cell">
        <div class="cmd-mem-subject">${esc(m.subject)}${m.metric ? `<em>${esc(m.metric)}</em>` : ''}</div>
        <div class="cmd-mem-tags">${memTagChips(m.tags)}</div>
      </div>
      <div class="cmd-mem-cell cmd-mem-rule">
        <div class="cmd-mem-value">${esc(m.valueText)}</div>
        ${
          conflict
            ? `<div class="cmd-mem-conflict">⚡ 确认后将自动归档旧规则 #${memNo(conflict.id)} [${
                esc(conflict.metric || conflict.subject)
              }]</div>`
            : ''
        }
      </div>
      <div class="cmd-mem-cell">
        <div>${esc(memSourceLabel(m.sourceType))}</div>
        <div class="cmd-mem-sub">${esc(memSyncText(m))}</div>
      </div>
      <div class="cmd-mem-cell">
        <div>${esc(memLifeText(m))}</div>
        <div class="cmd-mem-sub">${esc(memExpiryText(m))}</div>
      </div>
      <div class="cmd-mem-cell">
        ${memStatusBadge(m.status)}
        ${m.verifiedBy ? `<div class="cmd-mem-sub">${esc(m.verifiedBy)}</div>` : ''}
      </div>
      <div class="cmd-mem-actions">${actions.join('')}</div>
    </div>`;
  }

  function memTableHtml() {
    const rows = memFilteredMemories();
    return `<div class="cmd-mem-table">
      <div class="cmd-mem-thead">
        <span>主题 / 适用标签</span><span>规则事实内容</span><span>来源 / 作用对象</span>
        <span>命中 / 有效期</span><span>状态</span><span>操作</span>
      </div>
      ${
        rows.length
          ? rows.map(memRowHtml).join('')
          : `<div class="cmd-mem-empty">没有符合条件的规则。可点右上角「提炼近期经验」或「手动新增记忆」。</div>`
      }
    </div>`;
  }

  function memTeamCategoryOf(m) {
    return String(m.subject || '').split('·')[0].trim();
  }

  function memTeamCategories() {
    const set = new Set();
    (state.memTeam || []).forEach((m) => {
      const category = memTeamCategoryOf(m);
      if (category) set.add(category);
    });
    return [{ value: 'all', label: '分类：全部' }].concat(
      [...set].map((c) => ({ value: c, label: '分类：' + c }))
    );
  }

  function memTeamScopeOptions() {
    return [
      { value: 'all', label: '共享范围：全部' },
      { value: 'allAgents', label: '共享范围：全员共享' },
      { value: 'targeted', label: '共享范围：指定 Agent' },
    ];
  }

  function memEnabledAgentCount() {
    return ((state.wfAgents || []).filter((a) => a.enabled !== false)).length || 6;
  }

  function memTeamIsAll(m) {
    return (m.syncAgentKeys || []).length >= memEnabledAgentCount() - 1;
  }

  function memTeamSourceText(m) {
    const sourceType = String(m.sourceType || '').toLowerCase();
    const ref = String(m.sourceRef || '');
    let label = MEM_SOURCE_LABEL[sourceType] || sourceType || '未知来源';
    if (sourceType === 'selflearn') {
      if (ref.indexOf('approval') !== -1) label = '人工驳回沉淀';
      else if (ref.indexOf('wechat-audit') !== -1) label = '微信审核驳回';
      else if (ref.indexOf('return-rate') !== -1) label = '售后归因';
    } else if (sourceType === 'manual') {
      label = '管理员设定';
    }
    return { agent: m.agentName || m.agentKey, label };
  }

  function memTeamFiltered() {
    const q = String(state.memTeamSearch || '').trim().toLowerCase();
    return (state.memTeam || []).filter((m) => {
      const all = memTeamIsAll(m);
      if (state.memTeamScope === 'allAgents' && !all) return false;
      if (state.memTeamScope === 'targeted' && all) return false;
      if (state.memTeamCategory !== 'all' && memTeamCategoryOf(m) !== state.memTeamCategory) return false;
      if (q) {
        const hay = [m.subject, m.metric, m.valueText, m.tags, m.agentName, m.agentKey, memTeamSourceText(m).label]
          .join(' ')
          .toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function memTeamHtml() {
    const rows = memTeamFiltered();
    if (!rows.length) {
      return `<div class="cmd-mem-empty">${
        (state.memTeam || []).length
          ? '没有符合筛选条件的共享规则。'
          : '还没有跨 Agent 共享的规则。可在确认候选时勾选「同步至」，或点右上角「一键广播同步至全员」。'
      }</div>`;
    }
    return `<div class="cmd-mem-team">
      <div class="cmd-mem-team-head">
        <span>共享维度 / 标签</span><span>全局规则事实（全团队强制遵守）</span><span>生效 Agent 范围</span>
        <span>贡献来源</span><span>命中次数</span><span>操作</span>
      </div>
      ${rows
        .map((m) => {
          const all = memTeamIsAll(m);
          const source = memTeamSourceText(m);
          const scope = all
            ? `🌐 全员共享<div class="cmd-mem-sub">${(m.syncAgentKeys || []).map((k) => allAgentLabel(k)).join(' / ')}</div>`
            : (m.syncAgentKeys || []).map((k) => allAgentLabel(k)).join(' · ') || '—';
          return `<div class="cmd-mem-team-row${all ? ' is-all' : ''}">
            <div>
              <div class="cmd-mem-team-subject">${esc(m.subject)}${m.metric ? `<em>${esc(m.metric)}</em>` : ''}</div>
              <div class="cmd-mem-tags">${memTagChips(m.tags)}</div>
            </div>
            <div class="cmd-mem-team-rule">${esc(m.valueText)}</div>
            <div class="cmd-mem-team-scope">${scope}</div>
            <div>${esc(source.agent)}<div class="cmd-mem-sub">${esc(source.label)}</div></div>
            <div>已命中 <b>${Number(m.hitCount || 0)}</b> 次<div class="cmd-mem-sub">${esc(
              m.expiresAt ? '有有效期' : '永久'
            )}</div></div>
            <div class="cmd-mem-actions">
              <button type="button" class="cmd-mem-act" data-cmd-team-edit="${m.id}">编辑</button>
              <button type="button" class="cmd-mem-act" data-cmd-team-scope="${m.id}">作用范围</button>
              <button type="button" class="cmd-mem-act is-danger" data-cmd-team-unshare="${m.id}">下线</button>
            </div>
          </div>`;
        })
        .join('')}
    </div>`;
  }

  function memTeamOverviewHtml() {
    const rows = state.memTeamOverview || [];
    return `<aside class="cmd-mem-preview cmd-mem-overview">
      <div class="cmd-mem-preview-title">团队共享注入总览<span>Team Injection Overview</span></div>
      ${
        rows.length
          ? rows
              .map(
                (a) => `<div class="cmd-mem-agent">
                  <div class="cmd-mem-agent-head">
                    <i class="cw-dot" data-agent="${esc(a.agentKey)}"></i>
                    <b>${esc(a.agentName)}</b>
                    <em>${Number(a.coverage || 0)}%</em>
                  </div>
                  <div class="cmd-mem-bar"><i style="width:${Math.min(100, Number(a.coverage) || 0)}%"></i></div>
                  <div class="cmd-mem-agent-sub">共享 ${a.sharedRules}/${a.totalRules} 条 · 命中 ${a.hitCount} 次</div>
                </div>`
              )
              .join('')
          : `<div class="cmd-mem-empty">暂无团队共享规则。</div>`
      }
    </aside>`;
  }

  function memKnowledgeTagOptions() {
    const set = new Set();
    ((state.memory && state.memory.knowledge) || []).forEach((k) =>
      memTagsOf(k.tags).forEach((t) => set.add(t))
    );
    return [{ value: 'all', label: '标签：全部' }].concat(
      [...set].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((t) => ({ value: t, label: '#' + t }))
    );
  }

  function memKnowledgeFiltered() {
    const docs = (state.memory && state.memory.knowledge) || [];
    const q = String(state.memKnowledgeSearch || '').trim().toLowerCase();
    return docs.filter((k) => {
      if (state.memKnowledgeStatus === 'enabled' && k.enabled === false) return false;
      if (state.memKnowledgeStatus === 'disabled' && k.enabled !== false) return false;
      if (state.memKnowledgeTag !== 'all' && memTagsOf(k.tags).indexOf(state.memKnowledgeTag) === -1) return false;
      if (q) {
        const hay = [k.title, k.tags, k.content].join(' ').toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function memKnowledgeDraftFrom(doc) {
    return {
      id: doc ? doc.id : 'new',
      title: doc ? doc.title : '',
      tags: doc ? memTagsOf(doc.tags) : ['全局'],
      content: doc ? doc.content : '',
      enabled: doc ? doc.enabled !== false : true,
    };
  }

  function memKnTagEditorHtml() {
    const draft = state.memKnowledgeDraft;
    const tags = draft ? draft.tags : [];
    return `${tags
      .map(
        (t, i) => `<span class="cmd-kn-tag">#${esc(t)}<button type="button" data-cmd-kn-tag-del="${i}" title="移除标签">×</button></span>`
      )
      .join('')}<input class="cmd-kn-tag-input" placeholder="+ 添加标签" data-cmd-kn-tag-input autocomplete="off" />`;
  }

  function memKnowledgeRowsHtml() {
    const rows = memKnowledgeFiltered();
    if (!rows.length) {
      return `<div class="cmd-mem-empty">${
        ((state.memory && state.memory.knowledge) || []).length
          ? '没有符合筛选条件的知识条目。'
          : '知识库为空。可导入 .md/.txt 或新建知识条目。'
      }</div>`;
    }
    const selected = state.memKnowledgeDraft && state.memKnowledgeDraft.id;
    return rows
      .map(
        (k) => `<div class="cmd-kn-row${selected === k.id ? ' is-on' : ''}">
          <button type="button" class="cmd-kn-main" data-cmd-kn-select="${k.id}">
            <span class="cmd-kn-icon">📄</span>
            <span class="cmd-kn-info">
              <b class="cmd-kn-title">《${esc(k.title)}》</b>
              <span class="cmd-mem-tags">${memTagChips(k.tags)}</span>
            </span>
          </button>
          <div class="cmd-kn-tags-cell">${
            memTagsOf(k.tags)[0] ? `<span class="cmd-mem-tag">#${esc(memTagsOf(k.tags)[0])}</span>` : ''
          }</div>
          <div class="cmd-kn-chars">${Number(k.chars || 0).toLocaleString()} 字</div>
          <button type="button" class="cmd-kn-status${k.enabled === false ? ' is-off' : ''}"
            data-cmd-kn-toggle="${k.id}" title="${k.enabled === false ? '点击启用' : '点击停用'}">
            ${k.enabled === false ? '停用' : '启用'}
          </button>
        </div>`
      )
      .join('');
  }

  function memKnowledgeHtml() {
    return `<div class="cmd-kn-card">
      <div class="cmd-kn-card-head">
        <span>本地知识库文档列表<span class="cmd-kn-card-sub">（关键词精准检索，不接向量库）</span></span>
        <button type="button" class="cmd-mem-learn" data-cmd-mem-learn>✨ 提炼近期经验（自学习）</button>
      </div>
      <div class="cmd-mem-filters cmd-kn-filters">
        <label class="cmd-mem-search">${ui.icon('search', 14)}
          <input class="input" placeholder="检索文件名 / 内容…" data-cmd-kn-search value="${esc(state.memKnowledgeSearch)}" />
        </label>
        ${ui.select({ options: memKnowledgeTagOptions(), value: state.memKnowledgeTag, attrs: 'data-cmd-kn-tag-filter' })}
        ${ui.select({
          options: [
            { value: 'all', label: '状态：全部' },
            { value: 'enabled', label: '状态：启用' },
            { value: 'disabled', label: '状态：停用' },
          ],
          value: state.memKnowledgeStatus,
          attrs: 'data-cmd-kn-status',
        })}
      </div>
      <div class="cmd-kn-list">${memKnowledgeRowsHtml()}</div>
    </div>`;
  }

  function memKnowledgeDetailHtml() {
    const draft = state.memKnowledgeDraft;
    if (!draft) {
      return `<aside class="cmd-mem-preview cmd-kn-detail">
        <div class="cmd-mem-preview-title">知识条目详情与编辑</div>
        <div class="cmd-mem-empty">选择左侧文档查看 / 编辑，或点「+ 新建知识条目」。</div>
      </aside>`;
    }
    const max = ((state.memory && state.memory.settings && state.memory.settings.maxKnowledgeChars) || 4000);
    const chars = String(draft.content || '').length;
    return `<aside class="cmd-mem-preview cmd-kn-detail">
      <div class="cmd-mem-preview-title">知识条目详情与编辑<span>${draft.id === 'new' ? '新建条目' : '《' + esc(draft.title || '未命名') + '》'}</span></div>
      <label class="field"><span class="field-label">文档标题</span>
        ${ui.input({ placeholder: '如：冬季保温杯选品与材质国标鉴别指南', value: draft.title, attrs: 'data-cmd-kn-title-input' })}
      </label>
      <div class="field"><span class="field-label">检索触发标签 (Tags)</span>
        <div class="cmd-kn-tag-editor" data-cmd-kn-tag-editor>${memKnTagEditorHtml()}</div>
      </div>
      <div class="cmd-kn-char-stat">字符统计：<b data-cmd-kn-char-count>${chars.toLocaleString()}</b> / ${max.toLocaleString()} 字</div>
      <textarea class="cmd-kn-editor" data-cmd-kn-content placeholder="录入类目规则 / 平台政策 / 鉴别指南 / 话术模板…">${esc(
        draft.content
      )}</textarea>
      <div class="cmd-kn-detail-actions">
        ${draft.id !== 'new' ? `<button type="button" class="cmd-mem-act is-danger" data-cmd-kn-delete="${draft.id}">删除条目</button>` : ''}
        <button type="button" class="cmd-mem-act" data-cmd-kn-cancel>取消</button>
        <button type="button" class="cmd-mem-act is-primary" data-cmd-kn-save>${draft.id === 'new' ? '新建并启用' : '保存修改'}</button>
      </div>
    </aside>`;
  }

  function memBudgetHtml(label, chars, max) {
    const limit = Math.max(1, Number(max) || 1);
    const pct = Math.min(100, Math.round((Number(chars) || 0) / limit * 100));
    return `<div class="cmd-mem-budget">
      <div class="cmd-mem-budget-head"><span>${esc(label)}</span><b>${Number(chars) || 0} / ${limit} 字 (${pct}%)</b></div>
      <div class="cmd-mem-bar"><i style="width:${pct}%"></i></div>
    </div>`;
  }

  function memPreviewHtml() {
    const settings = (state.memory && state.memory.settings) || {};
    const preview = state.memPreview;
    const maxMemory = (preview && preview.maxMemoryChars) || settings.maxMemoryChars || 4000;
    const maxKnowledge = (preview && preview.maxKnowledgeChars) || settings.maxKnowledgeChars || 4000;
    const categories = [{ value: 'all', label: '类目：全部' }].concat(
      ((state.memScopes && state.memScopes.categories) || []).map((c) => ({ value: c, label: '类目：' + c }))
    );
    const channels = [{ value: 'all', label: '渠道：全部' }].concat(
      ((state.memScopes && state.memScopes.channels) || []).map((c) => ({ value: c.code, label: '渠道：' + c.label }))
    );
    return `<aside class="cmd-mem-preview">
      <div class="cmd-mem-preview-title">上下文预算与注入白盒预览<span>Context Injection Preview</span></div>
      ${memBudgetHtml('长期记忆字符预算', preview && preview.memoryChars, maxMemory)}
      ${memBudgetHtml('知识库字符预算', preview && preview.knowledgeChars, maxKnowledge)}
      <div class="cmd-mem-sim">
        <div class="cmd-mem-sim-title">🎯 模拟任务场景测试</div>
        <div class="cmd-mem-sim-row">
          ${ui.select({ options: categories, value: state.memSimCategory, attrs: 'data-cmd-mem-category' })}
          ${ui.select({ options: channels, value: state.memSimChannel, attrs: 'data-cmd-mem-channel' })}
        </div>
      </div>
      <div class="cmd-mem-layer-head">System Prompt Layer 3 · 命中规则</div>
      <pre class="cmd-mem-layer">${
        state.memPreviewLoading ? '正在演算…' : esc((preview && preview.layerText) || '（暂无预览）')
      }</pre>
      <div class="cmd-mem-layer-foot">命中 <b>${(preview && preview.rules && preview.rules.length) || 0}</b> 条 · 共 ${
        (preview && preview.totalChars) || 0
      } 字${preview && preview.truncated ? ' · 已截断' : ''}</div>
      <label class="cmd-mem-l1">
        <span>开启 L1 显式记忆提取 (/remember)</span>
        <input type="checkbox" data-cmd-mem-l1${settings.enableL1Extraction === false ? '' : ' checked'} />
      </label>
    </aside>`;
  }

  function memoryHtml() {
    if (!state.memory) return `<div class="cmd-empty">正在读取记忆…</div>`;
    const memories = state.memory.memories || [];
    const docs = state.memory.knowledge || [];
    const tab = state.memTab || 'agent';
    const tabs = [
      { id: 'agent', label: '本Agent规则记忆', count: memories.length },
      { id: 'team', label: '团队共享记忆', count: (state.memTeam || []).length },
      { id: 'knowledge', label: '本地知识库 SOP', count: docs.length },
    ];
    return `<div class="cmd-memory">
      <section class="cmd-mem-main">
        <div class="cmd-mem-toolbar">
          <div class="cmd-mem-tabs">${tabs
            .map(
              (t) => `<button type="button" class="cmd-mem-tab${tab === t.id ? ' is-on' : ''}" data-cmd-mem-tab="${t.id}">
                ${esc(t.label)}<b>${t.count}</b>
              </button>`
            )
            .join('')}</div>
          <div class="cmd-mem-tools">
            ${
              tab === 'knowledge'
                ? `<button type="button" class="cmd-mem-import" data-cmd-kn-import>
                     ${ui.icon('upload', 13)} 导入文档 (.md/.txt)
                   </button>
                   <button type="button" class="cmd-mem-add" data-cmd-mem-add-knowledge>+ 新建知识条目</button>`
                : tab === 'team'
                  ? `<button type="button" class="cmd-mem-broadcast" data-cmd-team-broadcast>
                       ${ui.icon('globe', 13)} 一键广播同步至全员
                     </button>
                     <button type="button" class="cmd-mem-add" data-cmd-mem-add-shared>+ 手动新增记忆</button>`
                  : `<button type="button" class="cmd-mem-learn" data-cmd-mem-learn${
                      state.memLearning ? ' disabled' : ''
                    }>✨ ${state.memLearning ? '正在扫描…' : '提炼近期经验 (自学习)'}</button>
                     <button type="button" class="cmd-mem-add" data-cmd-mem-add>+ 手动新增记忆</button>`
            }
          </div>
        </div>
        ${
          tab === 'agent'
            ? `<div class="cmd-mem-filters">
                <label class="cmd-mem-search">${ui.icon('search', 14)}
                  <input class="input" placeholder="搜索规则主题 / 内容…" data-cmd-mem-search value="${esc(state.memSearch)}" />
                </label>
                ${ui.select({ options: memTagOptions(), value: state.memTag, attrs: 'data-cmd-mem-tag' })}
                ${ui.select({ options: memStatusOptions(), value: state.memStatus, attrs: 'data-cmd-mem-status' })}
              </div>`
            : tab === 'team'
              ? `<div class="cmd-mem-filters">
                  <label class="cmd-mem-search">${ui.icon('search', 14)}
                    <input class="input" placeholder="搜索共享规则 / 黑名单…" data-cmd-team-search value="${esc(state.memTeamSearch)}" />
                  </label>
                  ${ui.select({ options: memTeamScopeOptions(), value: state.memTeamScope, attrs: 'data-cmd-team-scope' })}
                  ${ui.select({ options: memTeamCategories(), value: state.memTeamCategory, attrs: 'data-cmd-team-category' })}
                </div>`
              : ''
        }
        <div class="cmd-mem-table-card">
          ${tab === 'agent' ? memTableHtml() : tab === 'team' ? memTeamHtml() : memKnowledgeHtml()}
        </div>
      </section>
      ${tab === 'team' ? memTeamOverviewHtml() : tab === 'knowledge' ? memKnowledgeDetailHtml() : memPreviewHtml()}
    </div>`;
  }

  /* ------------------------------ Skill 技能（SOP 装配台） ------------------------------ */

  function skillClone(skill) {
    return skill ? JSON.parse(JSON.stringify(skill)) : null;
  }

  function skillTriggerModes(mode) {
    const parts = String(mode || '')
      .toLowerCase()
      .split(/[,\uFF0C+\s|]+/)
      .filter(Boolean);
    const chat = parts.length === 0 || parts.indexOf('chat') !== -1 || parts.indexOf('both') !== -1;
    const auto = parts.indexOf('auto') !== -1 || parts.indexOf('both') !== -1;
    const modes = [];
    if (chat) modes.push('chat');
    if (auto) modes.push('auto');
    return modes.length ? modes : ['chat'];
  }

  function skillTriggerText(mode) {
    const modes = skillTriggerModes(mode);
    if (modes.length === 2) return 'Chat + 自动管线';
    return modes[0] === 'auto' ? '自动管线触发' : 'Chat 调用';
  }

  function skillFiltered() {
    const q = String(state.skillSearch || '').trim().toLowerCase();
    return (state.skills || []).filter((s) => {
      if (!q) return true;
      return [s.code, s.name, s.description].join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }

  function skillCardHtml(skill) {
    const on = state.skillSelectedCode === skill.code;
    return `<button type="button" class="cmd-skill-card${on ? ' is-on' : ''}" data-skill-select="${esc(skill.code)}">
      <div class="cmd-skill-card-head">
        <b>${esc(skill.name)}</b>
        ${ui.badge(skill.enabled ? '已启用' : '已停用', { tone: skill.enabled ? 'green' : 'slate', dot: true })}
      </div>
      <div class="cmd-skill-card-code mono">code: ${esc(skill.code)}${on ? ' · SELECTED' : ''}</div>
      <div class="cmd-skill-card-meta">负责 Agent: ${esc(allAgentLabel(skill.agent))}</div>
      <div class="cmd-skill-card-foot">${ui.icon('plug', 12)} ${(skill.allowedTools || []).length} 个工具 · ${esc(
        skillTriggerText(skill.triggerMode)
      )}</div>
    </button>`;
  }

  function skillListHtml() {
    const rows = skillFiltered();
    return `<aside class="cmd-skill-side">
      <div class="cmd-skill-side-head">
        <span>✨ 技能列表 (Skills) <b>${(state.skills || []).length}</b></span>
        <button type="button" class="cmd-skill-new" data-skill-new title="新建 Skill">+</button>
      </div>
      <div class="cmd-skill-filters">
        <label class="cmd-mem-search">${ui.icon('search', 14)}
          <input class="input" placeholder="搜索技能名称 / 标识…" data-skill-search value="${esc(state.skillSearch)}" />
        </label>
        <div class="cmd-skill-scope">仅显示 <b>${esc(allAgentLabel(state.skillAgentKey))}</b> 自己的 Skill</div>
      </div>
      ${
        (state.skillIssues || []).length
          ? `<div class="cmd-skill-issues">${state.skillIssues
              .map((i) => `<div>⚠️ ${esc(i.message)}</div>`)
              .join('')}</div>`
          : ''
      }
      <div class="cmd-skill-list">
        ${
          rows.length
            ? rows.map(skillCardHtml).join('')
            : `<div class="cmd-mem-empty">没有匹配的 Skill。点右上角 + 新建。</div>`
        }
      </div>
      <button type="button" class="cmd-skill-new-btn" data-skill-new>+ 新建 Skill 技能</button>
    </aside>`;
  }

  function skillToolGroups() {
    const groups = new Map();
    (state.skillTools || []).forEach((tool) => {
      const key = tool.serverId || 'unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(tool);
    });
    const catalog = new Set((state.skillTools || []).map((t) => t.canonical));
    const missing = ((state.skillDraft && state.skillDraft.allowedTools) || []).filter((t) => !catalog.has(t));
    return { groups, missing };
  }

  function skillToolsHtml() {
    const { groups, missing } = skillToolGroups();
    const selected = new Set((state.skillDraft && state.skillDraft.allowedTools) || []);
    const expanded = new Set(state.skillExpandedServers || []);

    const renderTool = (tool) => `<label class="cmd-skill-tool">
      <input type="checkbox" data-skill-tool="${esc(tool.canonical)}"${selected.has(tool.canonical) ? ' checked' : ''} />
      <span class="cmd-skill-tool-main">
        <code>${esc(tool.canonical)}</code>
        <em>${esc(tool.description || '')}</em>
      </span>
      ${ui.badge(tool.declaredRisk || '未声明', { tone: tool.declaredRisk === 'read' ? 'green' : 'amber' })}
    </label>`;

    const renderGroup = (serverId, title, tools, isMissing) => {
      const selectedCount = tools.filter((t) => selected.has(t.canonical)).length;
      const allChecked = tools.length > 0 && selectedCount === tools.length;
      const isCollapsed = !expanded.has(serverId);
      return `<div class="cmd-skill-tool-group${isMissing ? ' is-missing' : ''}">
        <div class="cmd-skill-tool-group-head">
          <button type="button" class="cmd-skill-group-toggle" data-skill-group-toggle="${esc(serverId)}"
            title="${isCollapsed ? '展开' : '收起'}">${isCollapsed ? '▸' : '▾'}</button>
          <span class="mono">${esc(title)}</span>
          <span class="cmd-skill-group-count" data-skill-group-count="${esc(serverId)}">${selectedCount}/${tools.length}</span>
          <label class="cmd-skill-group-all">
            <input type="checkbox" data-skill-group-all="${esc(serverId)}"${allChecked ? ' checked' : ''} />
            全选
          </label>
        </div>
        <div class="cmd-skill-tool-group-body" data-skill-group-body="${esc(serverId)}"${isCollapsed ? ' hidden' : ''}>
          ${tools.map(renderTool).join('')}
        </div>
      </div>`;
    };

    const parts = [];
    for (const [serverId, tools] of groups) {
      parts.push(renderGroup(serverId, serverId, tools, false));
    }
    if (missing.length) {
      parts.push(
        renderGroup(
          '__missing__',
          '未连接工具',
          missing.map((canonical) => ({
            canonical,
            description: '当前服务未连接或工具已下线',
            declaredRisk: null,
          })),
          true
        )
      );
    }
    return parts.length ? parts.join('') : `<div class="cmd-mem-empty">暂无可用工具（MCP 服务未连接）。</div>`;
  }

  /** 一级分组全选框的选中/半选态与计数同步。 */
  function syncSkillToolGroup(serverId) {
    const root = document.querySelector('.cmd-page');
    if (!root) return;
    const body = root.querySelector(`[data-skill-group-body="${serverId}"]`);
    const master = root.querySelector(`[data-skill-group-all="${serverId}"]`);
    const count = root.querySelector(`[data-skill-group-count="${serverId}"]`);
    if (!body || !master) return;
    const boxes = [...body.querySelectorAll('[data-skill-tool]')];
    const checked = boxes.filter((b) => b.checked).length;
    master.checked = boxes.length > 0 && checked === boxes.length;
    master.indeterminate = checked > 0 && checked < boxes.length;
    if (count) count.textContent = checked + '/' + boxes.length;
  }

  function wireSkillToolGroups() {
    document.querySelectorAll('[data-skill-group-all]').forEach((el) => {
      syncSkillToolGroup(el.dataset.skillGroupAll);
    });
  }

  function skillVisualHtml() {
    const d = state.skillDraft;
    const isNew = !state.skillSelectedCode;
    return `<div class="cmd-skill-form">
      <div class="cmd-skill-section">
        <div class="cmd-skill-section-title">基本信息 <span>(Basic Info)</span></div>
        <div class="cmd-skill-grid3">
          <label class="field"><span class="field-label">技能名称 (Name)</span>
            ${ui.input({ value: d.name, placeholder: '如：寻源议价', attrs: 'data-skill-name' })}
          </label>
          <label class="field"><span class="field-label">唯一标识 (ID)</span>
            ${ui.input({
              value: d.code,
              placeholder: 'price-negotiation-sop',
              attrs: 'data-skill-code' + (isNew ? '' : ' disabled'),
            })}
          </label>
          <label class="field"><span class="field-label">执行 Agent (Execution Agent)</span>
            <span class="cmd-skill-agent-fixed"><i class="cw-dot" data-agent="${esc(d.agent)}"></i>${esc(
              allAgentLabel(d.agent)
            )}<em>仅本 Agent</em></span>
          </label>
        </div>
        <label class="field"><span class="field-label">描述 (Description)</span>
          ${ui.input({ value: d.description || '', placeholder: '一句话说明这个 SOP 的用途', attrs: 'data-skill-description' })}
        </label>
        <label class="cmd-mem-confirm-line">
          <input type="checkbox" data-skill-enabled${d.enabled ? ' checked' : ''} />
          <span>启用该 Skill（停用后不可被 Agent 调用，文件仍保留）</span>
        </label>
      </div>

      <div class="cmd-skill-section">
        <div class="cmd-skill-section-title">精准挂载 MCP 工具 <span>(Scope by Skill · 只暴露勾选接口)</span></div>
        <div class="cmd-skill-tool-note">已选 <b data-skill-tool-count>${(d.allowedTools || []).length}</b> 个；大模型执行该技能时只能看到这些工具。</div>
        <div class="cmd-skill-tools">${skillToolsHtml()}</div>
      </div>

      <div class="cmd-skill-section">
        <div class="cmd-skill-section-title">触发模式 <span>(Trigger Mode)</span></div>
        <div class="cmd-skill-trigger">
          <button type="button" class="cmd-skill-trigger-btn${
            skillTriggerModes(d.triggerMode).indexOf('chat') !== -1 ? ' is-on' : ''
          }" data-skill-trigger="chat">
            💬 Chat 调用 (/skill)
          </button>
          <button type="button" class="cmd-skill-trigger-btn${
            skillTriggerModes(d.triggerMode).indexOf('auto') !== -1 ? ' is-on' : ''
          }" data-skill-trigger="auto">
            🤖 自动管线触发 (Auto)
          </button>
        </div>
      </div>

      <div class="cmd-skill-section">
        <div class="cmd-skill-section-title">SOP 核心作业指令 <span>(Prompt)</span></div>
        <textarea class="input cmd-skill-prompt" rows="9" data-skill-prompt placeholder="写入该 Skill 的标准化作业流程、边界约束与输出格式…">${esc(
          d.prompt || ''
        )}</textarea>
      </div>

      <div class="cmd-skill-section">
        <div class="cmd-skill-section-title">运行参数 <span>(Runtime Params)</span></div>
        <div class="cmd-skill-params">
          <label class="field"><span class="field-label">温度 (Temperature)</span>
            <div class="cmd-skill-range">${ui.input({
              type: 'range',
              value: String(d.temperature ?? 0.7),
              attrs: 'min="0" max="1" step="0.1" data-skill-temp',
            })}<b data-skill-temp-val>${Number(d.temperature ?? 0.7).toFixed(1)}</b></div>
          </label>
          <label class="field"><span class="field-label">最大 Token</span>
            ${ui.input({ type: 'number', value: String(d.maxOutputTokens || 2048), attrs: 'min="128" max="32000" data-skill-max-tokens' })}
          </label>
          <label class="field"><span class="field-label">重试策略 (Retry)</span>
            ${ui.input({ type: 'number', value: String(d.retry ?? 2), attrs: 'min="0" max="5" data-skill-retry' })}
          </label>
        </div>
      </div>
    </div>`;
  }

  function skillYamlHighlight(yaml) {
    return String(yaml || '')
      .split(/\r?\n/)
      .map((line) => {
        if (/^\s*#/.test(line)) {
          return `<span class="cmd-yaml-comment">${esc(line)}</span>`;
        }
        const m = line.match(/^(\s*)([A-Za-z0-9_-]+)(:)(.*)$/);
        if (m) {
          const rest = m[4];
          const value = rest.trim();
          let restHtml = esc(rest);
          if (value === 'true' || value === 'false') {
            restHtml = `<span class="cmd-yaml-bool">${esc(rest)}</span>`;
          } else if (value.length) {
            restHtml = `<span class="cmd-yaml-value">${esc(rest)}</span>`;
          }
          return `${esc(m[1])}<span class="cmd-yaml-key">${esc(m[2])}</span>${esc(m[3])}${restHtml}`;
        }
        if (/^\s*-/.test(line)) {
          return `<span class="cmd-yaml-list">${esc(line)}</span>`;
        }
        return esc(line);
      })
      .join('\n');
  }

  function skillYamlHtml() {
    return `<div class="cmd-skill-yaml-wrap">
      <div class="cmd-skill-yaml-head">
        <span>skills/${esc((state.skillDraft && state.skillDraft.code) || 'new')}.yaml</span>
        <span class="tiny dim">可直接编辑 YAML；保存时按源码落盘并热加载</span>
      </div>
      ${state.skillYamlError ? `<div class="cmd-alert">${esc(state.skillYamlError)}</div>` : ''}
      <div class="cmd-skill-code">
        <pre class="cmd-skill-highlight" data-skill-highlight>${skillYamlHighlight(state.skillYaml)}</pre>
        <textarea class="cmd-skill-yaml" data-skill-yaml spellcheck="false">${esc(state.skillYaml)}</textarea>
      </div>
    </div>`;
  }

  function skillEditorHtml() {
    const d = state.skillDraft;
    if (!d) {
      return `<section class="cmd-skill-editor"><div class="cmd-mem-empty">从左侧选择一个 Skill，或新建技能开始配置。</div></section>`;
    }
    const isNew = !state.skillSelectedCode;
    return `<section class="cmd-skill-editor">
      <div class="cmd-skill-editor-head">
        <div class="cmd-skill-editor-title">
          <span>⚙️ 技能配置 / Skill Configuration — ${esc(d.name || '新建技能')}</span>
          <em class="mono">${esc(d.code || 'new-skill')}</em>
        </div>
        <div class="cmd-skill-editor-status">
          ${ui.badge(d.enabled ? '已启用' : '已停用', { tone: d.enabled ? 'green' : 'slate', dot: true })}
          <span class="cmd-skill-owner"><i class="cw-dot" data-agent="${esc(d.agent)}"></i>${esc(allAgentLabel(d.agent))}</span>
        </div>
      </div>
      <div class="cmd-skill-tabs">
        <button type="button" class="cmd-skill-tab${state.skillTab === 'visual' ? ' is-on' : ''}" data-skill-tab="visual">🎛️ 可视化装配</button>
        <button type="button" class="cmd-skill-tab${state.skillTab === 'yaml' ? ' is-on' : ''}" data-skill-tab="yaml">📄 YAML 源码</button>
      </div>
      <div class="cmd-skill-body">${state.skillTab === 'yaml' ? skillYamlHtml() : skillVisualHtml()}</div>
      <div class="cmd-skill-foot">
        <button type="button" class="cmd-mem-act is-danger" data-skill-delete>🗑️ 删除技能</button>
        <div class="cmd-skill-foot-right">
          <button type="button" class="cmd-mem-act" data-skill-toggle>${d.enabled ? '停用' : '启用'}</button>
          <button type="button" class="cmd-skill-save" data-skill-save${state.skillSaving ? ' disabled' : ''}>
            💾 ${state.skillSaving ? '保存中…' : '保存并热重载'}
          </button>
        </div>
      </div>
    </section>`;
  }

  function skillsHtml() {
    if (!(state.skills || []).length && !state.skillDraft && !(state.skillIssues || []).length) {
      if (!state.skillLoaded) return `<div class="cmd-empty">正在读取 Skill 目录…</div>`;
    }
    return `<div class="cmd-skills">${skillListHtml()}${skillEditorHtml()}</div>`;
  }

  /* ------------------------------ MCP 工具切片与授权 ------------------------------ */

  const MCP_TOKEN_BUDGET = 4000;

  function mcpAgentKey() {
    return (state.profile && state.profile.key) || 'commander';
  }

  function mcpAgentLabel() {
    return (state.profile && (state.profile.displayName || state.profile.name)) || '指挥官';
  }

  function mcpCurrentServer() {
    return (state.mcpServers || []).find((s) => s.id === state.mcpServerId) || null;
  }

  function mcpServerTools(serverId) {
    return (state.mcpTools || []).filter((t) => String(t.serverId || '') === String(serverId || ''));
  }

  function mcpServerMeta(server) {
    const s = String((server && server.state) || '').toLowerCase();
    if (s === 'connected') return { label: '运行正常', tone: 'green', dot: 'online' };
    if (s === 'connecting') return { label: '握手中', tone: 'cyan', dot: 'busy' };
    if (s === 'disabled') return { label: '未启用', tone: 'slate', dot: 'idle' };
    if (s === 'error') return { label: '异常 / 断连', tone: 'rose', dot: 'offline' };
    return { label: '离线', tone: 'slate', dot: 'offline' };
  }

  function mcpDeriveSelection(serverId) {
    const slice = state.mcpSlices ? state.mcpSlices[serverId] : null;
    if (Array.isArray(slice)) return slice.slice();
    const names = mcpServerTools(serverId).map((t) => t.name);
    const allowed = (state.profile && state.profile.allowedTools) || [];
    if (allowed.indexOf('*') !== -1 || allowed.indexOf(serverId + '.*') !== -1) return names;
    return names.filter((name) => allowed.indexOf(serverId + '.' + name) !== -1);
  }

  function mcpToolToken(tool) {
    const raw = [tool.name || '', tool.description || '', tool.inputSchemaJson || ''].join('\n');
    return Math.max(1, Math.ceil(raw.length / 4));
  }

  function mcpSelectedToken() {
    const selected = new Set(state.mcpSelected || []);
    return mcpServerTools(state.mcpServerId).reduce((sum, tool) => {
      return selected.has(tool.name) ? sum + mcpToolToken(tool) : sum;
    }, 0);
  }

  function mcpBudgetTone(tokens) {
    const pct = tokens / MCP_TOKEN_BUDGET;
    if (pct >= 0.9) return 'is-red';
    if (pct >= 0.7) return 'is-amber';
    return 'is-green';
  }

  function mcpBudgetPct(tokens) {
    return Math.max(0, Math.min(100, Math.round((tokens / MCP_TOKEN_BUDGET) * 100)));
  }

  function mcpRiskTag(tool) {
    const risk = String(tool.declaredRisk || '').toLowerCase();
    if (risk === 'read') return { label: '只读 Read', cls: 'is-read' };
    if (risk === 'write') return { label: '写入 Write', cls: 'is-write' };
    if (risk === 'irreversible') return { label: '不可逆', cls: 'is-danger' };
    return { label: '未声明', cls: 'is-dim' };
  }

  function mcpKindTag(tool) {
    const name = String(tool.name || '').toLowerCase();
    if (name.startsWith('meta.') || /(search|compare|filter|rank|recommend|analyz|fetch|describe|categor|suggest)/.test(name)) {
      return '语义工具 / Semantic Facade';
    }
    return '原子接口';
  }

  function mcpServerCardHtml(server) {
    const meta = mcpServerMeta(server);
    const on = server.id === state.mcpServerId;
    return `<button type="button" class="cmd-slice-server${on ? ' is-on' : ''}" data-mcp-server="${esc(server.id)}">
      <div class="cmd-slice-server-name">
        <span>${esc(server.name || server.id)}</span>
        ${server.builtin ? '<i class="cmd-slice-builtin">内置</i>' : ''}
      </div>
      <div class="cmd-slice-server-state">
        <i class="cw-dot" data-state="${esc(meta.dot)}"></i>${esc(meta.label)}
      </div>
      <div class="cmd-slice-server-url mono">${esc(server.url || '未配置 Endpoint')}</div>
    </button>`;
  }

  function mcpServerItemsHtml() {
    if (state.mcpLoading && !state.mcpLoaded) return `<div class="cmd-mem-empty">正在读取服务…</div>`;
    const kw = String(state.mcpSearch || '').trim().toLowerCase();
    const rows = (state.mcpServers || []).filter((s) => {
      return !kw || [s.name, s.id, s.url].join(' ').toLowerCase().indexOf(kw) !== -1;
    });
    if (!rows.length) {
      return `<div class="cmd-mem-empty">${state.mcpServers.length ? '没有匹配的服务。' : '还没有接入 MCP 服务。'}</div>`;
    }
    return rows.map(mcpServerCardHtml).join('');
  }

  function mcpServerListHtml() {
    return `<aside class="cmd-slice-side">
      <div class="cmd-slice-side-head">
        <div class="cmd-slice-side-title">${ui.icon('server', 14)}<span>全局 MCP 服务 <em>(Global MCP Servers)</em></span></div>
        <button type="button" class="cmd-slice-new" data-mcp-new title="打开主界面 MCP 插件管理">${ui.icon('plus', 12)} 接入新服务</button>
      </div>
      <label class="cmd-slice-search">${ui.icon('search', 13)}
        <input class="input" placeholder="搜索服务..." data-mcp-search value="${esc(state.mcpSearch)}" autocomplete="off" />
      </label>
      <div class="cmd-slice-server-list" data-mcp-server-list>${mcpServerItemsHtml()}</div>
    </aside>`;
  }

  function mcpToolRowHtml(tool) {
    const checked = (state.mcpSelected || []).indexOf(tool.name) !== -1;
    const risk = mcpRiskTag(tool);
    return `<label class="cmd-slice-tool${checked ? ' is-on' : ''}" data-mcp-tool-row="${esc(tool.name)}">
      <input type="checkbox" data-mcp-tool="${esc(tool.name)}"${checked ? ' checked' : ''} />
      <div class="cmd-slice-tool-main">
        <div class="cmd-slice-tool-name">
          <span class="mono">${esc(state.mcpServerId)}.${esc(tool.name)}</span>
          <span class="cmd-slice-expose" data-mcp-expose${checked ? '' : ' hidden'}>暴露 Expose</span>
        </div>
        <div class="cmd-slice-tool-desc">${esc(tool.description || '无描述')}</div>
      </div>
      <div class="cmd-slice-tool-tags">
        <span class="cmd-slice-tag ${risk.cls}">${esc(risk.label)}</span>
        <span class="cmd-slice-tag is-kind">${esc(mcpKindTag(tool))}</span>
        ${String(tool.declaredRisk || '').toLowerCase() === 'irreversible' ? '<span class="cmd-slice-tag is-danger">敏感</span>' : ''}
      </div>
    </label>`;
  }

  function mcpPagedTools() {
    const tools = mcpServerTools(state.mcpServerId);
    const pages = Math.max(1, Math.ceil(tools.length / state.mcpPageSize));
    const page = Math.max(1, Math.min(state.mcpPage, pages));
    return {
      tools,
      page,
      pages,
      rows: tools.slice((page - 1) * state.mcpPageSize, page * state.mcpPageSize),
    };
  }

  function mcpPagerHtml(paged) {
    if (paged.tools.length <= state.mcpPageSize) {
      return `<div class="cmd-slice-pager"><span class="cmd-slice-page-info">${paged.tools.length ? '1 / 1 页' : '0 个接口'} · 共 ${paged.tools.length} 个接口</span></div>`;
    }
    const nums = [];
    const start = Math.max(1, Math.min(paged.page - 2, paged.pages - 4));
    const end = Math.min(paged.pages, start + 4);
    for (let i = start; i <= end; i += 1) nums.push(i);
    return `<div class="cmd-slice-pager">
      <button type="button" class="cmd-slice-page-btn" data-mcp-page="${paged.page - 1}"${paged.page <= 1 ? ' disabled' : ''}>‹</button>
      ${nums.map((n) => `<button type="button" class="cmd-slice-page-btn${n === paged.page ? ' is-on' : ''}" data-mcp-page="${n}">${n}</button>`).join('')}
      ${end < paged.pages ? `<span class="cmd-slice-page-gap">…</span><button type="button" class="cmd-slice-page-btn" data-mcp-page="${paged.pages}">${paged.pages}</button>` : ''}
      <button type="button" class="cmd-slice-page-btn" data-mcp-page="${paged.page + 1}"${paged.page >= paged.pages ? ' disabled' : ''}>›</button>
      <span class="cmd-slice-page-info">页 / 共 ${paged.tools.length} 个接口</span>
    </div>`;
  }

  function mcpVisualHtml(server) {
    if (!server) {
      return `<div class="cmd-slice-body"><div class="cmd-slice-empty">${ui.icon('plugin', 24)}<b>选择一个 MCP 服务</b><span>从左侧选择服务，开始做工具切片。</span></div></div>`;
    }
    const tools = mcpServerTools(server.id);
    const selectedCount = (state.mcpSelected || []).length;
    const tokens = mcpSelectedToken();
    const tone = mcpBudgetTone(tokens);
    const pct = mcpBudgetPct(tokens);
    const paged = mcpPagedTools();
    const warn = tokens >= 3500 || pct >= 90;
    const options = (state.mcpServers || []).map((s) => {
      return `<option value="${esc(s.id)}"${s.id === server.id ? ' selected' : ''}>${esc(s.name || s.id)} · ${esc(s.id)}</option>`;
    }).join('');

    return `<div class="cmd-slice-body">
      <div class="cmd-slice-summary">
        <div class="cmd-slice-exposed">
          <span>当前暴露工具 <em>(Exposed to LLM)</em></span>
          <b data-mcp-exposed>${selectedCount} / ${tools.length}</b>
        </div>
        <label class="cmd-slice-select">
          <span>选择 MCP 插件 <em>(Select MCP Server)</em></span>
          <select class="select" data-mcp-server-select>${options}</select>
        </label>
        <div class="cmd-slice-budget">
          <div class="cmd-slice-budget-head">
            <span>预估 Token 消耗 <em>(Token Budget)</em></span>
            <b data-mcp-token>${tokens.toLocaleString()} / ${MCP_TOKEN_BUDGET.toLocaleString()} Token</b>
          </div>
          <div class="cmd-slice-bar"><i data-mcp-bar class="${tone}" style="width:${pct}%"></i></div>
          <div class="cmd-slice-warn" data-mcp-warn${warn ? '' : ' hidden'}>当前工具描述已占用 ${tokens.toLocaleString()} Token，可能导致模型遗忘业务指令。</div>
        </div>
      </div>

      <div class="cmd-slice-tool-head">
        <span>${tools.length} 个可用接口</span>
        <span>Page ${paged.page} of ${paged.pages} · Showing ${paged.rows.length}</span>
      </div>
      <div class="cmd-slice-tool-list">
        ${tools.length
          ? paged.rows.map(mcpToolRowHtml).join('')
          : `<div class="cmd-slice-empty is-small">${ui.icon('wifi', 22)}<b>该服务暂未返回工具</b><span>服务未连接 / 未握手时无法拉取接口；请先到主界面「MCP 插件」完成连接。</span></div>`}
      </div>
      ${tools.length ? mcpPagerHtml(paged) : ''}
    </div>`;
  }

  function mcpYamlText() {
    const key = mcpAgentKey();
    const lines = [
      '# Agent MCP Tool Slicing / 工具授权切片',
      '# 只覆盖 MCP 服务；未列出的服务继续沿用 agents.yaml 的 allowedTools',
      'agent: ' + key,
      'servers:',
    ];
    const servers = Object.keys(state.mcpSlices || {}).sort();
    if (!servers.length) {
      lines.push('  {}');
      return lines.join('\n');
    }
    servers.forEach((serverId) => {
      lines.push('  ' + serverId + ':');
      const tools = state.mcpSlices[serverId] || [];
      if (!tools.length) lines.push('    []');
      else tools.forEach((tool) => lines.push('    - ' + tool));
    });
    return lines.join('\n');
  }

  function mcpYamlHtml() {
    return `<div class="cmd-slice-body">
      <div class="cmd-slice-yaml">
        <div class="cmd-slice-yaml-head">
          <span class="mono">config/agent-mcp-policies.json · ${esc(mcpAgentKey())}</span>
          <span class="cmd-slice-yaml-acts">
            <span class="tiny dim">只读预览</span>
            <button type="button" class="cmd-slice-copy" data-mcp-copy-yaml>复制 YAML</button>
          </span>
        </div>
        <pre class="cmd-slice-code">${skillYamlHighlight(mcpYamlText())}</pre>
      </div>
    </div>`;
  }

  function mcpPanelHtml() {
    if (state.mcpLoading && !state.mcpLoaded) {
      return `<section class="cmd-slice-main"><div class="cmd-empty"><span class="spinner"></span> 正在读取 MCP 工具清单…</div></section>`;
    }
    if (!(state.mcpServers || []).length) {
      return `<section class="cmd-slice-main"><div class="cmd-slice-empty">${ui.icon('plugin', 24)}<b>暂无 MCP 服务</b><span>请先在主界面「MCP 插件」接入服务，再回来做工具切片。</span><button type="button" class="cmd-slice-go" data-mcp-new>去主界面接入</button></div></section>`;
    }
    return `<section class="cmd-slice-main">
      <div class="cmd-slice-head">
        <div>
          <div class="cmd-slice-title">Agent 工具切片与授权</div>
          <div class="cmd-slice-sub">Agent Tool Slicing &amp; Authorization · <span class="mono">${esc(mcpAgentKey())}</span></div>
        </div>
        <div class="cmd-slice-agent">${ui.badge(mcpAgentLabel(), { tone: 'violet' })}</div>
      </div>
      <div class="cmd-slice-tabs">
        <button type="button" class="cmd-slice-tab${state.mcpTab === 'visual' ? ' is-on' : ''}" data-mcp-tab="visual">可视化切片 (Visual Slicing)</button>
        <button type="button" class="cmd-slice-tab${state.mcpTab === 'yaml' ? ' is-on' : ''}" data-mcp-tab="yaml">YAML 代码</button>
      </div>
      ${state.mcpTab === 'yaml' ? mcpYamlHtml() : mcpVisualHtml(mcpCurrentServer())}
      <div class="cmd-slice-foot">
        <span class="cmd-slice-foot-note">仅勾选的工具会注入当前 Agent 的 System Prompt（含 JSON Schema）</span>
        <button type="button" class="cmd-slice-reset" data-mcp-reset>重置</button>
        <button type="button" class="cmd-slice-save" data-mcp-save${state.mcpSaving ? ' disabled' : ''}>${state.mcpSaving ? '保存中…' : '保存切片 & 授权'}</button>
      </div>
    </section>`;
  }

  function mcpHtml() {
    return `<div class="cmd-slice">${mcpServerListHtml()}${mcpPanelHtml()}</div>`;
  }

  async function loadMcpWorkspace() {
    state.mcpLoading = true;
    if (!state.mcpLoaded) paint();
    const agentKey = mcpAgentKey();
    const results = await Promise.all([
      request('GET', '/api/mcp/servers'),
      request('GET', '/api/mcp/tools'),
      request('GET', '/api/agents/' + encodeURIComponent(agentKey) + '/mcp-slices'),
    ]);
    state.mcpLoading = false;
    state.mcpServers = results[0].ok && Array.isArray(results[0].data) ? results[0].data : [];
    if (results[1].ok && Array.isArray(results[1].data)) {
      state.mcpTools = results[1].data;
      state.tools = results[1].data;
    }
    state.mcpSlices = results[2].ok && results[2].data && results[2].data.slices ? results[2].data.slices : {};
    state.mcpLoaded = true;
    const exists = state.mcpServers.find((s) => s.id === state.mcpServerId);
    const target = exists || state.mcpServers.find((s) => s.state === 'connected') || state.mcpServers[0] || null;
    state.mcpServerId = target ? target.id : null;
    state.mcpSelected = target ? mcpDeriveSelection(target.id) : [];
    state.mcpPage = 1;
    state.mcpDirty = false;
    paint();
  }

  async function mcpSelectServer(serverId) {
    if (!serverId || serverId === state.mcpServerId) return;
    if (state.mcpDirty) {
      const ok = await ui.confirm({
        title: '切换 MCP 服务？',
        desc: '当前服务有未保存的工具切片，切换后将丢弃这些勾选。',
        ok: '丢弃并切换',
        tone: 'danger',
      });
      if (!ok) { paint(); return; }
    }
    state.mcpServerId = serverId;
    state.mcpSelected = mcpDeriveSelection(serverId);
    state.mcpPage = 1;
    state.mcpDirty = false;
    paint();
  }

  function mcpSyncReading() {
    const tools = mcpServerTools(state.mcpServerId);
    const selected = (state.mcpSelected || []).length;
    const tokens = mcpSelectedToken();
    const exposed = document.querySelector('[data-mcp-exposed]');
    if (exposed) exposed.textContent = selected + ' / ' + tools.length;
    const tokenEl = document.querySelector('[data-mcp-token]');
    if (tokenEl) tokenEl.textContent = tokens.toLocaleString() + ' / ' + MCP_TOKEN_BUDGET.toLocaleString() + ' Token';
    const bar = document.querySelector('[data-mcp-bar]');
    if (bar) {
      bar.style.width = mcpBudgetPct(tokens) + '%';
      bar.className = mcpBudgetTone(tokens);
    }
    const warn = document.querySelector('[data-mcp-warn]');
    if (warn) {
      const on = tokens >= 3500 || mcpBudgetPct(tokens) >= 90;
      warn.hidden = !on;
      warn.textContent = '当前工具描述已占用 ' + tokens.toLocaleString() + ' Token，可能导致模型遗忘业务指令。';
    }
    const rail = document.querySelector('[data-cmd-panel="mcp"] .cmd-rail-count');
    if (rail) rail.textContent = String(selected);
  }

  function mcpToggleTool(name, checked) {
    const set = new Set(state.mcpSelected || []);
    if (checked) set.add(name);
    else set.delete(name);
    state.mcpSelected = [...set];
    state.mcpDirty = true;
    mcpSyncReading();
  }

  async function saveMcpSlice() {
    if (!state.mcpServerId || state.mcpSaving) return;
    const serverId = state.mcpServerId;
    const tools = (state.mcpSelected || []).slice();
    state.mcpSaving = true;
    paint();
    const agentKey = mcpAgentKey();
    const res = await request(
      'PUT',
      '/api/agents/' + encodeURIComponent(agentKey) + '/mcp-slices/' + encodeURIComponent(serverId),
      { tools: tools }
    );
    state.mcpSaving = false;
    if (!res.ok) {
      toast('保存切片失败：' + (res.error || '服务未连接'), 'warn');
      paint();
      return;
    }
    state.mcpSlices[serverId] = (res.data && res.data.tools) || tools;
    if (state.mcpServerId === serverId) state.mcpDirty = false;
    toast('切片已保存：' + tools.length + ' 个工具授权给 ' + mcpAgentLabel(), 'success');
    paint();
  }

  async function resetMcpSlice() {
    if (!state.mcpServerId || state.mcpSaving) return;
    const ok = await ui.confirm({
      title: '重置 ' + state.mcpServerId + ' 的工具切片？',
      desc: '将删除当前服务的人工切片，运行时回到 agents.yaml 的名册默认授权。',
      ok: '重置',
      tone: 'danger',
    });
    if (!ok) return;
    const agentKey = mcpAgentKey();
    const res = await request(
      'DELETE',
      '/api/agents/' + encodeURIComponent(agentKey) + '/mcp-slices/' + encodeURIComponent(state.mcpServerId)
    );
    if (!res.ok) {
      toast('重置失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    delete state.mcpSlices[state.mcpServerId];
    state.mcpSelected = mcpDeriveSelection(state.mcpServerId);
    state.mcpDirty = false;
    toast('已重置为名册默认授权', 'success');
    paint();
  }

  function openGlobalMcpPage() {
    const bridge = window.workbench;
    if (bridge && typeof bridge.navigateMain === 'function') {
      bridge.navigateMain('#/mcp');
      toast('已切换到主界面 MCP 插件管理', 'info');
      return;
    }
    toast('请到主界面「MCP 插件」页接入服务', 'warn');
  }

  function copyMcpYaml() {
    const text = mcpYamlText();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          () => toast('YAML 已复制', 'success'),
          () => toast('复制失败，请手动选中代码复制', 'warn')
        );
        return;
      }
    } catch (_) { /* 降级提示 */ }
    toast('当前环境不支持自动复制', 'warn');
  }

  function auditTimeText(value) {
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value || '—');
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    if (state.auditSince === '24') return time;
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
  }

  function auditPayloadText(json) {
    if (!json) return '—';
    let text = String(json);
    try {
      text = JSON.stringify(JSON.parse(text));
    } catch (_) {
      /* 原样展示 */
    }
    return text.length <= 220 ? text : text.slice(0, 220) + '…';
  }

  function auditAgentOptions() {
    const set = new Map();
    ((state.wfAgents || [])).forEach((a) => set.set(a.key, allAgentLabel(a.key)));
    (state.auditLogs || []).forEach((r) => {
      if (r.agentKey && !set.has(r.agentKey)) set.set(r.agentKey, r.agentName || r.agentKey);
    });
    return [{ value: 'all', label: '负责 Agent：全部' }].concat(
      [...set.entries()].map(([value, label]) => ({ value, label }))
    );
  }

  function auditPipelineOptions() {
    const map = new Map((state.pipelines || []).map((p) => [p.pipelineId, p.name]));
    (state.auditLogs || []).forEach((r) => {
      if (r.pipelineId && !map.has(r.pipelineId)) map.set(r.pipelineId, r.pipelineName || r.pipelineId);
    });
    return [{ value: 'all', label: '工作流：全部' }].concat(
      [...map.entries()].map(([value, label]) => ({ value, label }))
    );
  }

  function auditRowActions(row) {
    const actions = [`<button type="button" class="cmd-audit-act" data-audit-view="${row.id}">查看</button>`];
    if (row.status === 'pending_approval' && row.approvalId) {
      actions.push(`<button type="button" class="cmd-audit-act is-primary" data-audit-approve="${row.id}">去审批</button>`);
      actions.push(`<button type="button" class="cmd-audit-act is-danger" data-audit-withdraw="${row.id}">撤回</button>`);
    } else if (row.severity === 'error' && row.riskLevel === 'read'
      && row.serverId && row.serverId !== 'builtin' && row.serverId !== 'pipeline') {
      actions.push(`<button type="button" class="cmd-audit-act" data-audit-retry="${row.id}">重试</button>`);
    }
    return actions.join('');
  }

  function auditTableHtml() {
    if (state.auditLoading) {
      return `<div class="cmd-audit-empty"><span class="spinner"></span> 正在读取轨迹…</div>`;
    }
    if (!(state.auditLogs || []).length) {
      return `<div class="cmd-audit-empty">暂无轨迹。发起 Agent 工具调用或推进流水线后会自动落审计。</div>`;
    }
    return `<div class="cmd-audit-table">
      <div class="cmd-audit-thead">
        <span>时间</span><span>来源 / Agent</span><span>行为 (Action)</span>
        <span>参数 / 负载 (Payload Parameters)</span><span>状态</span><span>操作</span>
      </div>
      ${state.auditLogs
        .map((row) => `<div class="cmd-audit-row">
          <div class="mono cmd-audit-time">${esc(auditTimeText(row.at))}</div>
          <div class="cmd-audit-source">
            <b class="mono">${esc(row.serverId || 'system')}</b>
            <em>${esc(row.agentName || row.agentKey || '—')}</em>
            ${row.projectNo ? `<span>${esc(row.projectNo)}</span>` : ''}
          </div>
          <div class="mono cmd-audit-action">${esc(row.action)}</div>
          <code class="cmd-audit-payload" title="${esc(row.argumentsJson || '')}">${esc(
            auditPayloadText(row.argumentsJson)
          )}</code>
          <div class="cmd-audit-status">${ui.badge(row.statusLabel || row.status, {
            tone: row.statusTone || 'slate',
            dot: true,
          })}${row.elapsedMs != null ? `<span>${row.elapsedMs} ms</span>` : ''}</div>
          <div class="cmd-audit-actions">${auditRowActions(row)}</div>
        </div>`)
        .join('')}
    </div>`;
  }

  function logsHtml() {
    const liveMode = String(
      (state.model && state.model.chatMode) || (WB.data && WB.data.chatMode) || ''
    ).toLowerCase();
    const isLive = liveMode === 'live';
    return `<div class="cmd-audit">
      <div class="cmd-audit-head">
        <div class="cmd-audit-title">▦ 轨迹日志 (Live Audit Log)</div>
        ${ui.badge(isLive ? 'Live 真实模型' : '离线模式', { tone: isLive ? 'green' : 'slate', dot: true })}
        <span class="cmd-audit-count">${(state.auditLogs || []).length} 条</span>
      </div>
      <div class="cmd-audit-filters">
        ${ui.select({
          options: [
            { value: '24', label: '今日（24h）' },
            { value: '168', label: '近 7 天' },
            { value: 'all', label: '全部时间' },
          ],
          value: state.auditSince,
          attrs: 'data-audit-since',
        })}
        ${ui.select({ options: auditPipelineOptions(), value: state.auditPipeline, attrs: 'data-audit-pipeline' })}
        ${ui.select({
          options: [
            { value: 'all', label: '日志级别：全部' },
            { value: 'success', label: 'Success / 成功' },
            { value: 'warn', label: 'Warn / 待审批·拦截' },
            { value: 'error', label: 'Error / 异常' },
          ],
          value: state.auditSeverity,
          attrs: 'data-audit-severity',
        })}
        ${ui.select({ options: auditAgentOptions(), value: state.auditAgent, attrs: 'data-audit-agent' })}
        <label class="cmd-audit-search">${ui.icon('search', 14)}
          <input class="input" placeholder="输入关键词检索…" data-audit-search value="${esc(state.auditKeyword)}" />
        </label>
        <button type="button" class="cmd-audit-export" data-audit-export>${ui.icon('download', 13)} 导出日志</button>
      </div>
      ${auditTableHtml()}
    </div>`;
  }

  async function loadAuditLogs() {
    state.auditLoading = true;
    const qs = new URLSearchParams();
    if (state.auditSince !== 'all') qs.set('sinceHours', state.auditSince);
    if (state.auditPipeline !== 'all') qs.set('pipelineId', state.auditPipeline);
    if (state.auditSeverity !== 'all') qs.set('severity', state.auditSeverity);
    if (state.auditAgent !== 'all') qs.set('agent', state.auditAgent);
    if (state.auditKeyword.trim()) qs.set('keyword', state.auditKeyword.trim());
    qs.set('limit', '300');
    const res = await request('GET', '/api/audit/logs?' + qs.toString());
    state.auditLoading = false;
    state.auditLoaded = true;
    state.auditLogs = res.ok && Array.isArray(res.data) ? res.data : [];
  }

  function auditPretty(value) {
    if (!value) return '—';
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch (_) {
      return String(value);
    }
  }

  function openAuditDetail(id) {
    const row = (state.auditLogs || []).find((r) => String(r.id) === String(id));
    if (!row) return;
    const overlay = ui.modal({
      title: '轨迹详情 · ' + row.action,
      desc: `${row.agentName || row.agentKey} · ${row.serverId || 'system'} · ${row.statusLabel || row.status}`,
      body: `<div class="cmd-audit-detail">
        <div class="cmd-audit-kv">
          <span>时间</span><b>${esc(fmtTime(row.at, true))}</b>
          <span>风险等级</span><b>${esc(row.riskLevel || '—')}</b>
          <span>耗时</span><b>${row.elapsedMs != null ? row.elapsedMs + ' ms' : '—'}</b>
          <span>工作流</span><b>${esc(row.pipelineName || row.pipelineId || '—')}</b>
          <span>任务</span><b>${esc(row.projectNo || '—')}</b>
          ${row.approvalId ? `<span>审批单</span><b class="mono">${esc(row.approvalId)}</b>` : ''}
          ${row.errorMessage ? `<span>错误</span><b>${esc(row.errorMessage)}</b>` : ''}
        </div>
        <div class="cmd-audit-code-title">参数 / Payload</div>
        <pre class="cmd-audit-code">${esc(auditPretty(row.argumentsJson))}</pre>
        <div class="cmd-audit-code-title">结果 / Result</div>
        <pre class="cmd-audit-code">${esc(auditPretty(row.resultJson))}</pre>
      </div>`,
      actions: ui.btn({ label: '关闭', tone: 'ghost', attrs: 'data-modal-close' }),
    });
    const modal = overlay.querySelector('.modal');
    if (modal) modal.style.width = 'min(980px, calc(100vw - 80px))';
  }

  async function retryAuditCall(id) {
    const row = (state.auditLogs || []).find((r) => String(r.id) === String(id));
    if (!row) return;
    let args = {};
    try {
      args = row.argumentsJson ? JSON.parse(row.argumentsJson) : {};
    } catch (_) {
      toast('参数 JSON 无法解析，不能重试', 'warn');
      return;
    }
    const res = await request('POST', '/api/mcp/tools/call', {
      serverId: row.serverId,
      name: row.action,
      arguments: args,
    });
    if (!res.ok) {
      toast('重试失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    ui.modal({
      title: '重试结果 · ' + row.action,
      body: `<pre class="cmd-audit-code">${esc(JSON.stringify(res.data, null, 2))}</pre>`,
      actions: ui.btn({ label: '关闭', tone: 'ghost', attrs: 'data-modal-close' }),
    });
    toast('重试成功', 'success');
  }

  async function openAuditApproval(id) {
    const row = (state.auditLogs || []).find((r) => String(r.id) === String(id));
    if (!row || !row.approvalId) {
      toast('该轨迹没有关联审批单', 'warn');
      return;
    }
    const res = await request('GET', '/api/approvals/' + encodeURIComponent(row.approvalId));
    if (!res.ok || !res.data) {
      toast('审批单不存在或已失效：' + (res.error || ''), 'warn');
      return;
    }
    const approval = res.data;
    const overlay = ui.modal({
      title: '人工审批 · ' + approval.toolName,
      desc: `${approval.agentKey} · ${approval.serverId} · ${approval.risk}`,
      body: `<div class="cmd-audit-detail">
        <div class="cmd-audit-kv">
          <span>操作单号</span><b class="mono">${esc(approval.operationId)}</b>
          <span>状态</span><b>${esc(approval.status)}</b>
        </div>
        <div class="cmd-audit-code-title">审批参数</div>
        <pre class="cmd-audit-code">${esc(auditPretty(approval.argumentsJson))}</pre>
        <label class="field"><span class="field-label">审批备注</span>
          ${ui.input({ placeholder: '可选：说明通过 / 驳回原因', attrs: 'data-audit-approval-note' })}
        </label>
      </div>`,
      actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}
        ${ui.btn({ label: '驳回', tone: 'danger', attrs: 'data-audit-approval-reject' })}
        ${ui.btn({ label: '批准执行', tone: 'primary', attrs: 'data-audit-approval-approve' })}`,
    });
    overlay.addEventListener('click', async (e) => {
      const approve = e.target.closest('[data-audit-approval-approve]');
      const reject = e.target.closest('[data-audit-approval-reject]');
      if (!approve && !reject) return;
      const note = String((overlay.querySelector('[data-audit-approval-note]') || {}).value || '').trim();
      const decision = approve ? 'approve' : 'reject';
      const r = await request('POST', `/api/approvals/${encodeURIComponent(row.approvalId)}/${decision}`, { note });
      if (!r.ok) {
        toast('审批失败：' + (r.error || '服务未连接'), 'warn');
        return;
      }
      overlay.close();
      await loadAuditLogs();
      paint();
      toast(decision === 'approve' ? '审批已通过' : '审批已驳回', 'success');
    });
  }

  async function withdrawAuditApproval(id) {
    const row = (state.auditLogs || []).find((r) => String(r.id) === String(id));
    if (!row || !row.approvalId) return;
    const ok = await ui.confirm({
      title: '撤回这次审批？',
      desc: '撤回等价于驳回，后续相同 operationId 会按已拒绝处理。',
      ok: '撤回',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await request('POST', `/api/approvals/${encodeURIComponent(row.approvalId)}/reject`, {
      note: '撤回（轨迹日志）',
    });
    if (!res.ok) {
      toast('撤回失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    await loadAuditLogs();
    paint();
    toast('审批已撤回', 'success');
  }

  function exportAuditLogs() {
    if (!(state.auditLogs || []).length) {
      toast('当前没有可导出的轨迹', 'warn');
      return;
    }
    const escCsv = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [
      ['时间', '来源', 'Agent', '行为', '参数', '状态', '风险', '耗时(ms)', '工作流', '任务', '错误'].map(escCsv).join(','),
    ];
    state.auditLogs.forEach((r) => {
      lines.push([
        fmtTime(r.at, true),
        r.serverId || '',
        r.agentName || r.agentKey || '',
        r.action || '',
        r.argumentsJson || '',
        r.statusLabel || r.status || '',
        r.riskLevel || '',
        r.elapsedMs == null ? '' : r.elapsedMs,
        r.pipelineName || r.pipelineId || '',
        r.projectNo || '',
        r.errorMessage || '',
      ].map(escCsv).join(','));
    });
    downloadText('audit-log-' + Date.now() + '.csv', '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    toast('轨迹日志已导出', 'success');
  }

  function mainHtml() {
    if (!state.loaded) return `<div class="cmd-empty"><span class="spinner"></span> 正在读取真实数据…</div>`;
    if (state.panel === 'workbench' && state.view === 'task') return detailHtml();
    if (state.panel === 'chat') return chatHtml();
    if (state.panel === 'pipelines') return pipelinesHtml();
    if (state.panel === 'memory') return memoryHtml();
    if (state.panel === 'skills') return skillsHtml();
    if (state.panel === 'mcp') return mcpHtml();
    if (state.panel === 'logs') return logsHtml();
    return workbenchHtml();
  }

  /* ------------------------------ 渲染：右侧指令台 ------------------------------ */

  function dockLogs() {
    const items = state.activity.slice(0, 10).map((a) => ({
      at: a.at,
      tag: a.kind === 'pipeline' ? 'Pipeline' : String(a.agentKey || '').replace(/^./, (c) => c.toUpperCase()),
      text: a.text,
    }));
    const extra = state.dockExtra.map((e) => ({ at: e.at, tag: 'Commander', text: e.text }));
    return extra.concat(items).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 14);
  }

  function dockHtml() {
    return `<aside class="cmd-dock">
      <div class="cmd-dock-head">
        <div><div class="cmd-dock-title">指挥官协同与指令台</div><div class="cmd-dock-sub">Commander Copilot Dock</div></div>
        <span class="tiny dim">Streaming Agent Handoff Logs</span>
      </div>
      <div class="cmd-dock-logs">${
        dockLogs().length
          ? dockLogs()
              .map(
                (l) => `<div class="cmd-dock-log">
                  <span class="mono cmd-dock-time">${esc(fmtClock(l.at))}</span>
                  <span class="cmd-dock-tag">[${esc(l.tag)}]</span>
                  <span class="cmd-dock-text">${esc(l.text)}</span>
                </div>`
              )
              .join('')
          : `<div class="cmd-empty">暂无协同日志。</div>`
      }</div>
      <div class="cmd-dock-chips">${DOCK_CHIPS.map(
        (c) => `<button type="button" class="cmd-chip" data-cmd-chip="${esc(c.text)}">${esc(c.label)}</button>`
      ).join('')}</div>
      <div class="cmd-dock-input">
        <textarea class="input cmd-dock-textarea" rows="2" placeholder="向指挥官下达指令…（Enter 发送）" data-cmd-dock-input></textarea>
        <button type="button" class="cmd-dock-send" data-cmd-dock-send title="发送">${ui.icon('zap', 15)}</button>
      </div>
    </aside>`;
  }

  /* ------------------------------ 数据加载 ------------------------------ */

  async function loadAll() {
    const results = await Promise.all([
      request('GET', '/api/business/products'),
      request('GET', '/api/pipelines'),
      request('GET', '/api/commander/activity?limit=40'),
      request('GET', '/api/operations/?sinceHours=24&limit=30'),
      request('GET', '/api/agents/commander/memory'),
      request('GET', '/api/agents/commander'),
      request('GET', '/api/mcp/tools'),
      request('GET', '/api/approvals?status=pending&limit=50'),
      request('GET', '/api/llm/settings'),
      request('GET', '/api/auth/me'),
      request('GET', '/api/agents'),
      request('GET', '/api/skills?agent=' + encodeURIComponent(state.skillAgentKey)),
      request('GET', '/api/audit/logs?sinceHours=168&limit=300'),
    ]);

    state.tasks = results[0].ok && results[0].data ? results[0].data.rows || [] : [];
    state.pipelines = results[1].ok && results[1].data ? results[1].data.pipelines || [] : [];
    state.activity = results[2].ok && Array.isArray(results[2].data) ? results[2].data : [];
    state.operations = results[3].ok && Array.isArray(results[3].data) ? results[3].data : [];
    state.memory = results[4].ok ? results[4].data : null;
    state.profile = results[5].ok ? results[5].data : null;
    state.tools = results[6].ok && Array.isArray(results[6].data) ? results[6].data : [];
    state.approvals = results[7].ok && Array.isArray(results[7].data) ? results[7].data : [];
    state.model = results[8].ok ? results[8].data : null;
    const me = results[9].ok ? results[9].data : null;
    state.wfAgents = results[10].ok && Array.isArray(results[10].data) ? results[10].data : [];
    if (results[11] && results[11].ok && results[11].data) {
      state.skills = Array.isArray(results[11].data.skills) ? results[11].data.skills : [];
      state.skillIssues = Array.isArray(results[11].data.issues) ? results[11].data.issues : [];
      state.skillLoaded = true;
    }
    if (results[12] && results[12].ok && Array.isArray(results[12].data)) {
      state.auditLogs = results[12].data;
      state.auditLoaded = true;
    }
    state.user = me
      ? {
          username: me.username || '',
          displayName: me.displayName || me.username || '用户',
          name: me.displayName || me.username || '用户',
          role: me.role || '',
          initial: String(me.displayName || me.username || '用').slice(0, 1),
        }
      : null;
    state.loaded = true;
  }

  /* ------------------------------ 记忆体：自学习工作区 ------------------------------ */

  async function loadMemoryBundle() {
    const res = await request('GET', '/api/agents/commander/memory');
    if (res.ok && res.data) state.memory = res.data;
  }

  async function loadMemoryTeam() {
    const res = await request('GET', '/api/agents/commander/memory/team?limit=50');
    if (res.ok && Array.isArray(res.data)) state.memTeam = res.data;
  }

  async function loadMemoryTeamOverview() {
    const res = await request('GET', '/api/agents/commander/memory/team/overview');
    if (res.ok && Array.isArray(res.data)) state.memTeamOverview = res.data;
  }

  async function loadMemoryScopes() {
    const res = await request('GET', '/api/agents/commander/memory/scopes');
    if (res.ok && res.data) state.memScopes = res.data;
  }

  async function loadMemoryPreview() {
    const tags = [];
    if (state.memSimCategory !== 'all') tags.push(state.memSimCategory);
    if (state.memSimChannel !== 'all') {
      const channel = ((state.memScopes && state.memScopes.channels) || []).find(
        (c) => c.code === state.memSimChannel
      );
      if (channel) tags.push(channel.label);
    }
    const query = tags.length ? '?tags=' + encodeURIComponent(tags.join(',')) : '';
    const res = await request('GET', '/api/agents/commander/memory/preview' + query);
    state.memPreview = res.ok ? res.data : null;
  }

  async function loadMemoryWorkspace() {
    state.memPreviewLoading = true;
    await Promise.all([loadMemoryBundle(), loadMemoryTeam(), loadMemoryTeamOverview(), loadMemoryScopes()]);
    await loadMemoryPreview();
    state.memPreviewLoading = false;
  }

  /* ------------------------------ Skill 技能：加载与动作 ------------------------------ */

  async function loadSkillsWorkspace() {
    const [listRes, toolsRes] = await Promise.all([
      request('GET', '/api/skills?agent=' + encodeURIComponent(state.skillAgentKey)),
      request('GET', '/api/skills/tools'),
    ]);
    if (listRes.ok && listRes.data) {
      state.skills = Array.isArray(listRes.data.skills) ? listRes.data.skills : [];
      state.skillIssues = Array.isArray(listRes.data.issues) ? listRes.data.issues : [];
    }
    if (toolsRes.ok && Array.isArray(toolsRes.data)) {
      state.skillTools = toolsRes.data;
    }
    state.skillLoaded = true;
    if (!state.skillDraft) {
      const preferred =
        state.skills.find((s) => s.code === 'price-negotiation-sop') || state.skills[0] || null;
      state.skillSelectedCode = preferred ? preferred.code : null;
      state.skillDraft = preferred ? skillClone(preferred) : null;
      state.skillTab = 'visual';
      state.skillYaml = '';
      state.skillYamlError = null;
      state.skillExpandedServers = [];
    }
  }

  function selectSkill(code) {
    const skill = (state.skills || []).find((s) => s.code === code);
    if (!skill) return;
    state.skillSelectedCode = skill.code;
    state.skillDraft = skillClone(skill);
    state.skillTab = 'visual';
    state.skillYaml = '';
    state.skillYamlError = null;
    state.skillExpandedServers = [];
    paint();
  }

  function newSkillDraft() {
    state.skillSelectedCode = null;
    state.skillDraft = {
      code: '',
      name: '',
      description: '',
      agent: state.skillAgentKey,
      enabled: true,
      triggerMode: 'chat',
      allowedTools: [],
      prompt: '',
      temperature: 0.3,
      maxOutputTokens: 2048,
      retry: 2,
    };
    state.skillTab = 'visual';
    state.skillYaml = '';
    state.skillYamlError = null;
    state.skillExpandedServers = [];
    paint();
  }

  function collectSkillForm() {
    const d = state.skillDraft;
    if (!d) return null;
    const q = (sel) => document.querySelector(sel);
    if (q('[data-skill-name]')) d.name = String(q('[data-skill-name]').value || '').trim();
    if (!state.skillSelectedCode && q('[data-skill-code]')) {
      d.code = String(q('[data-skill-code]').value || '').trim().toLowerCase();
    }
    if (q('[data-skill-description]')) d.description = String(q('[data-skill-description]').value || '').trim();
    if (q('[data-skill-enabled]')) d.enabled = !!q('[data-skill-enabled]').checked;
    if (q('[data-skill-prompt]')) d.prompt = String(q('[data-skill-prompt]').value || '').trim();
    if (q('[data-skill-temp]')) d.temperature = Number(q('[data-skill-temp]').value);
    if (q('[data-skill-max-tokens]')) d.maxOutputTokens = Number(q('[data-skill-max-tokens]').value);
    if (q('[data-skill-retry]')) d.retry = Number(q('[data-skill-retry]').value);
    return d;
  }

  async function saveSkill() {
    if (state.skillTab === 'yaml') {
      await saveSkillYaml();
      return;
    }
    const draft = collectSkillForm();
    if (!draft) return;
    if (!draft.code || !draft.name || !draft.agent || !draft.prompt) {
      toast('请填写唯一标识、技能名称、执行 Agent 与 SOP 指令', 'warn');
      return;
    }
    state.skillSaving = true;
    paint();
    const code = state.skillSelectedCode;
    const res = code
      ? await request('PUT', '/api/skills/' + encodeURIComponent(code), draft)
      : await request('POST', '/api/skills', draft);
    state.skillSaving = false;
    if (!res.ok) {
      toast('保存失败：' + (res.error || '服务未连接'), 'warn');
      paint();
      return;
    }
    await loadSkillsWorkspace();
    state.skillSelectedCode = res.data.code;
    state.skillDraft = skillClone(res.data);
    state.skillTab = 'visual';
    paint();
    toast('已保存并热重载：' + res.data.code, 'success');
  }

  async function saveSkillYaml() {
    const yaml = state.skillYaml;
    if (!yaml.trim()) {
      toast('YAML 内容不能为空', 'warn');
      return;
    }
    state.skillSaving = true;
    paint();
    const res = await request('POST', '/api/skills/import', { yaml });
    state.skillSaving = false;
    if (!res.ok) {
      toast('YAML 保存失败：' + (res.error || '服务未连接'), 'warn');
      paint();
      return;
    }
    await loadSkillsWorkspace();
    state.skillSelectedCode = res.data.code;
    state.skillDraft = skillClone(res.data);
    state.skillTab = 'yaml';
    paint();
    toast('YAML 已保存并热重载', 'success');
  }

  async function deleteSkill() {
    if (!state.skillSelectedCode) {
      state.skillDraft = null;
      paint();
      return;
    }
    const code = state.skillSelectedCode;
    const ok = await ui.confirm({
      title: '删除这个 Skill？',
      desc: `将删除 skills/${code}.yaml，并立即热重载；不可恢复。`,
      ok: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await request('DELETE', '/api/skills/' + encodeURIComponent(code));
    if (!res.ok) {
      toast('删除失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    state.skillSelectedCode = null;
    state.skillDraft = null;
    await loadSkillsWorkspace();
    paint();
    toast('Skill 已删除', 'success');
  }

  async function toggleSkill() {
    if (!state.skillDraft) return;
    if (!state.skillSelectedCode) {
      state.skillDraft.enabled = !state.skillDraft.enabled;
      paint();
      return;
    }
    const draft = collectSkillForm();
    const res = await request('POST', '/api/skills/' + encodeURIComponent(state.skillSelectedCode) + '/toggle', {
      enabled: !draft.enabled,
    });
    if (!res.ok) {
      toast('操作失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    state.skillDraft = skillClone(res.data);
    await loadSkillsWorkspace();
    paint();
    toast(res.data.enabled ? 'Skill 已启用' : 'Skill 已停用', 'success');
  }

  async function switchSkillTab(tab) {
    if (!state.skillDraft || state.skillTab === tab) return;
    if (tab === 'yaml') {
      const draft = collectSkillForm();
      if (!draft.code || !draft.name || !draft.agent || !draft.prompt) {
        toast('请先填写唯一标识、名称、执行 Agent 与 SOP 指令', 'warn');
        return;
      }
      const res = await request('POST', '/api/skills/preview', draft);
      if (!res.ok) {
        toast('YAML 预览失败：' + (res.error || '配置不完整'), 'warn');
        return;
      }
      state.skillYaml = res.data.yaml || '';
      state.skillYamlError = null;
      state.skillTab = 'yaml';
      paint();
      return;
    }
    state.skillYamlError = null;
    const res = await request('POST', '/api/skills/parse', { yaml: state.skillYaml });
    if (!res.ok) {
      state.skillYamlError = 'YAML 解析失败：' + (res.error || '请检查格式');
      paint();
      return;
    }
    const parsed = res.data;
    state.skillDraft = parsed;
    state.skillSelectedCode = (state.skills || []).some((s) => s.code === parsed.code) ? parsed.code : null;
    state.skillTab = 'visual';
    paint();
  }

  function cwEnsureId() {
    if (state.cwConversationId) return state.cwConversationId;
    const key = 'wizstar.agent.conv.commander';
    let id = '';
    try {
      id = window.localStorage.getItem(key) || '';
    } catch (_) {
      /* 忽略 */
    }
    if (!id) {
      id = 'ui-commander-' + Date.now().toString(36);
      try {
        window.localStorage.setItem(key, id);
      } catch (_) {
        /* 忽略 */
      }
    }
    state.cwConversationId = id;
    return id;
  }

  async function cwLoadSessions() {
    const res = await request('GET', '/api/agents/commander/sessions?limit=50&includeArchived=true');
    state.cwSessionsLoaded = true;
    state.cwSessions = res.ok && res.data ? res.data.sessions || [] : [];
  }

  async function cwLoadMemory() {
    const res = await request('GET', '/api/agents/commander/memory');
    if (res.ok) state.cwMemory = res.data;
  }

  async function cwLoadHistory(convId) {
    const res = await request('GET', '/api/agents/commander/conversations/' + encodeURIComponent(convId));
    if (!res.ok || !res.data) {
      state.chat = [];
      return;
    }
    state.chat = (res.data.messages || []).map((m) => ({ role: m.role, text: m.text }));
  }

  async function cwLoadGroup(convId) {
    const res = await request('GET', '/api/agents/groups/' + encodeURIComponent(convId));
    if (!res.ok || !res.data) {
      state.cwKind = 'single';
      state.cwGroup = null;
      state.cwMentions = [];
      toast('群聊会话读取失败：' + (res.error || '服务未连接'), 'warn');
      return false;
    }
    state.cwKind = 'group';
    state.cwGroup = res.data;
    state.cwConversationId = res.data.conversationId || convId;
    state.chat = [];
    syncGroupMentions();
    return true;
  }

  /* 打开一个会话：先按左侧列表判断是单聊还是群聊，再走各自的历史读取。 */
  async function cwOpenConversation(convId) {
    const s = (state.cwSessions || []).find((x) => x.conversationId === convId);
    if (s && s.kind === 'group') {
      await cwLoadGroup(convId);
      return;
    }
    state.cwKind = 'single';
    state.cwGroup = null;
    state.cwMentions = [];
    await cwLoadHistory(convId);
  }

  function cwRememberConversation(id) {
    try {
      window.localStorage.setItem('wizstar.agent.conv.commander', id);
    } catch (_) {
      /* 忽略 */
    }
  }

  async function cwBootstrapChat() {
    cwEnsureId();
    await Promise.all([cwLoadSessions(), cwLoadMemory()]);
    const active = (state.cwSessions || []).find((s) => s.conversationId === state.cwConversationId);
    if (active && active.archived) state.cwShowArchived = true;
    await cwOpenConversation(state.cwConversationId);
    if (!state.cwGroup && !state.chat.length) {
      // 未命中任何历史（例如 localStorage 里是旧 ID）时保持空会话，不报错
      state.cwKind = 'single';
    }
  }

  function cwNewConversation() {
    const id = 'ui-commander-' + Date.now().toString(36);
    state.cwConversationId = id;
    cwRememberConversation(id);
    state.cwKind = 'single';
    state.cwGroup = null;
    state.cwMentions = [];
    state.chat = [];
    state.cwAttachments = [];
    paint();
  }

  async function cwSwitchSession(convId) {
    state.cwConversationId = convId;
    cwRememberConversation(convId);
    await cwOpenConversation(convId);
    paint();
  }

  async function cwArchiveSession(convId, archived) {
    const res = await request(
      'POST',
      '/api/agents/commander/sessions/' + encodeURIComponent(convId) + '/archive',
      { archived }
    );
    if (!res.ok) {
      toast((archived ? '归档失败：' : '恢复失败：') + (res.error || '服务未连接'), 'warn');
      return;
    }
    const wasCurrent = convId === state.cwConversationId;
    await cwLoadSessions();
    if (wasCurrent && archived) {
      cwNewConversation();
    } else if (wasCurrent) {
      await cwOpenConversation(convId);
      paint();
    } else {
      paint();
    }
    toast(archived ? '会话已归档，可在「归档箱」恢复' : '会话已恢复', 'success');
  }

  async function cwDeleteSession(convId) {
    const session = (state.cwSessions || []).find((s) => s.conversationId === convId);
    const group = session && session.kind === 'group';
    const ok = await ui.confirm({
      title: '删除这个会话？',
      desc: group
        ? '群聊记录与各专员的群内通道会一并删除，不可恢复；专员长期记忆不受影响。'
        : '会话历史会从数据库删除，不可恢复。',
      ok: '删除',
      tone: 'danger',
    });
    if (!ok) return;

    const res = await request('DELETE', '/api/agents/commander/sessions/' + encodeURIComponent(convId));
    if (!res.ok) {
      toast('删除失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    const wasCurrent = convId === state.cwConversationId;
    await cwLoadSessions();
    if (wasCurrent) cwNewConversation();
    else paint();
    toast('会话已删除', 'success');
  }

  function cwRefreshAttachments() {
    const host = document.querySelector('.cw [data-cw-attachments]');
    if (host) host.innerHTML = cwAttachmentsHtml();
  }

  function closeCwMenu() {
    document.querySelectorAll('.cw [data-cw-plus-menu]').forEach((el) => { el.hidden = true; });
  }

  const CW_TEXT_EXT = /\.(csv|txt|md|json|log)$/i;

  async function cwReadFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      let text = null;
      if (CW_TEXT_EXT.test(file.name) || /^text\//.test(file.type || '') || file.type === 'application/json') {
        if (file.size <= 512 * 1024) {
          try {
            text = (await file.text()).slice(0, 4000);
          } catch (_) {
            text = null;
          }
        }
      }
      state.cwAttachments.push({
        name: file.name,
        size: file.size,
        mime: file.type || '',
        text,
      });
    }
    cwRefreshAttachments();
  }

  function cwPickFiles(kind) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = kind === 'media' ? 'image/*,video/*' : '.xlsx,.xls,.csv,.pdf,.txt,.md,.json';
    input.addEventListener('change', () => { cwReadFiles(input.files); });
    input.click();
    toast(kind === 'media' ? '选择商品图 / 视频后会自动挂载' : '选择附件后会自动挂载', 'info');
  }

  function cwExportMarkdown() {
    const isGroup = state.cwKind === 'group' && state.cwGroup;
    if (!isGroup && !state.chat.length) {
      toast('当前会话还没有内容', 'warn');
      return;
    }
    const lines = isGroup
      ? ['# 群聊会诊 · ' + (state.cwGroup.title || '未命名会诊'), '',
          '- 参会 Agent：' + (state.cwGroup.participants || []).map(agentShort).join('、'),
          '- 导出时间：' + new Date().toLocaleString('zh-CN'), '']
      : ['# 指挥官会话', '', '- 导出时间：' + new Date().toLocaleString('zh-CN'), ''];
    if (isGroup) {
      (state.cwGroup.messages || []).forEach((m) => {
        lines.push('## ' + (m.role === 'user' ? '用户' : m.name || agentShort(m.role)), '', m.text || '', '');
      });
    } else {
      state.chat.forEach((m) => {
        if (m.role === 'group') {
          lines.push('## 群聊会诊', '', m.text, '');
          (m.items || []).forEach((item) => {
            lines.push('### ' + item.name, '', item.text, '');
          });
          return;
        }
        lines.push(m.role === 'user' ? '## 用户' : '## 指挥官', '', m.text, '');
      });
    }
    downloadText('commander-chat-' + Date.now() + '.md', lines.join('\n'), 'text/markdown;charset=utf-8');
    toast('会话已导出 Markdown', 'success');
  }

  function allAgentLabel(key) {
    return (WF_AGENT_LABEL && WF_AGENT_LABEL[key]) || key;
  }

  function cwAttachmentPayload() {
    return state.cwAttachments.map((a) => ({
      name: a.name, mime: a.mime, size: a.size, text: a.text || null,
    }));
  }

  /* 拉起群聊：选参会专员 + 会诊主题（首轮指令可留空，创建后在输入框 @ 专员发送）。 */
  function closeCmdModelMenu() {
    const menu = document.querySelector('[data-cmd-model-menu]');
    if (menu) menu.hidden = true;
  }

  async function selectCommanderModel(modelId) {
    closeCmdModelMenu();
    if (!modelId) return;
    if (modelId === effectiveAgentModel('commander')) return;
    const res = await request('PUT', '/api/llm/bindings', { bindings: { commander: modelId } });
    if (!res.ok || !res.data) {
      toast('模型切换失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    state.model = res.data;
    // 顶栏不在 paint() 的重绘范围内：单独换新，保证当前模型与下拉选中态同步
    const top = document.querySelector('.cmd-top');
    if (top) top.outerHTML = topHtml();
    paint();
    toast('指挥官已切换模型：' + modelId, 'success');
  }

  function openGroupModal() {
    const agents = (state.wfAgents || []).filter((a) => a.key !== 'commander' && a.enabled !== false);
    if (!agents.length) {
      toast('暂无可拉起的专员', 'warn');
      return;
    }
    const defaults = ['scout', 'sourcing', 'creative'].filter((k) => agents.some((a) => a.key === k));
    const picked = defaults.length ? defaults : agents.slice(0, 3).map((a) => a.key);

    const overlay = ui.modal({
      title: '拉起 Agent 群聊（多专员协同会诊）',
      desc: '指挥官固定主持；被 @ 的专员按各自人格与工具授权各发言一次，最后由指挥官收敛总结。',
      body: `<div class="cw-group-form">
        <label class="field"><span class="field-label">会诊主题</span>
          ${ui.input({ placeholder: '如：冬季保温杯选品与核价会诊', value: '选品与核价会诊', attrs: 'data-cw-group-title' })}
        </label>
        <div class="field">
          <span class="field-label">参会专员（指挥官固定参会）</span>
          <div class="cw-agent-picks">
            ${agents
              .map(
                (a) => `<label class="cw-agent-pick">
                  <input type="checkbox" data-cw-agent="${esc(a.key)}"${picked.indexOf(a.key) !== -1 ? ' checked' : ''} />
                  <span>${esc(allAgentLabel(a.key))}</span>
                </label>`
              )
              .join('')}
          </div>
        </div>
        <label class="field"><span class="field-label">首轮会诊指令（可留空）</span>
          <textarea class="input" rows="3" placeholder="例如：这批保温杯，请分别给出选品/供应链/内容/上架视角的意见。" data-cw-group-msg></textarea>
        </label>
        <div class="tiny dim">已挂载附件会随指令一起发给本轮发言的专员。</div>
      </div>`,
      actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}
        ${ui.btn({ label: '拉起群聊', icon: 'users', tone: 'primary', attrs: 'data-cw-group-ok' })}`,
    });

    overlay.addEventListener('click', (e) => {
      if (!e.target.closest('[data-cw-group-ok]')) return;
      const keys = [...overlay.querySelectorAll('[data-cw-agent]:checked')].map((el) => el.dataset.cwAgent);
      const titleEl = overlay.querySelector('[data-cw-group-title]');
      const msgEl = overlay.querySelector('[data-cw-group-msg]');
      const title = titleEl ? String(titleEl.value || '').trim() : '';
      const message = msgEl ? String(msgEl.value || '').trim() : '';
      if (!keys.length) {
        toast('至少选择一位专员', 'warn');
        return;
      }
      overlay.close();
      cwCreateGroup(title || '未命名会诊', keys, message);
    });
  }

  async function cwCreateGroup(title, keys, firstMessage) {
    // 单聊已有内容时原地升级：沿用同一 conversationId，历史映射为 user/commander
    const sourceConversationId =
      state.cwKind === 'single' && state.chat.length ? state.cwConversationId : null;
    const res = await request('POST', '/api/agents/groups', {
      title,
      participants: ['commander'].concat(keys),
      sourceConversationId,
    });
    if (!res.ok || !res.data) {
      toast('群聊创建失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    state.cwKind = 'group';
    state.cwGroup = res.data;
    state.cwConversationId = res.data.conversationId;
    cwRememberConversation(res.data.conversationId);
    state.chat = [];
    syncGroupMentions();
    await cwLoadSessions();
    paint();
    toast('已拉起群聊会诊：' + res.data.title, 'success');
    if (firstMessage) {
      await cwSendGroupChat(firstMessage);
    }
  }

  /* 一轮群聊：只把指令发给被 @ 的专员；后端固定由指挥官收敛一次。 */
  async function cwSendGroupChat(text) {
    if (state.busy || state.cwKind !== 'group' || !state.cwGroup) return;
    const groupId = state.cwGroup.conversationId;
    const message = String(text || '').trim();
    if (!message && !state.cwAttachments.length) return;

    let mentions = state.cwMentions.filter((k) => groupSpecialists().indexOf(k) !== -1);
    if (!mentions.length) mentions = groupSpecialists();
    if (!mentions.length) {
      toast('请先邀请至少一位专员参会', 'warn');
      return;
    }

    const attachments = cwAttachmentPayload();
    state.busy = true;
    state.cwGroup = {
      ...state.cwGroup,
      messages: (state.cwGroup.messages || []).concat([
        {
          role: 'user',
          name: '你',
          text: message || '（仅发送挂载附件）',
          meta: attachments.length ? '附件 ' + attachments.length + ' 个' : null,
          canAdopt: false,
        },
      ]),
    };
    paint();

    const res = await request('POST', '/api/agents/groups/' + encodeURIComponent(groupId) + '/turn', {
      message: message || '请分析我挂载的附件。',
      mentions,
      attachments,
    });
    state.busy = false;

    if (!res.ok || !res.data) {
      toast('会诊失败：' + (res.error || '服务未连接'), 'warn');
      await cwLoadGroup(groupId);
      paint();
      return;
    }

    state.cwGroup = res.data;
    state.cwAttachments = [];
    await cwLoadSessions();
    paint();
  }

  /* 参会专员增删：写回 participants_json；指挥官不可移除。 */
  function openParticipantsModal() {
    if (!state.cwGroup) return;
    const all = (state.wfAgents || []).filter((a) => a.key !== 'commander' && a.enabled !== false);
    const current = state.cwGroup.participants || [];

    const overlay = ui.modal({
      title: '邀请 / 移除参会专员',
      desc: '会诊人数上限 6 人（含指挥官主持）。移除后该专员不再收到群聊指令，但其独立记忆不受影响。',
      body: `<div class="cw-agent-picks">
        ${all
          .map(
            (a) => `<label class="cw-agent-pick">
              <input type="checkbox" data-cw-agent="${esc(a.key)}"${current.indexOf(a.key) !== -1 ? ' checked' : ''} />
              <span>${esc(allAgentLabel(a.key))}</span>
            </label>`
          )
          .join('')}
      </div>`,
      actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}
        ${ui.btn({ label: '保存参会人', tone: 'primary', attrs: 'data-cw-participants-ok' })}`,
    });

    overlay.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-cw-participants-ok]')) return;
      const keys = [...overlay.querySelectorAll('[data-cw-agent]:checked')].map((el) => el.dataset.cwAgent);
      if (!keys.length) {
        toast('至少保留一位专员', 'warn');
        return;
      }
      const res = await request(
        'PUT',
        '/api/agents/groups/' + encodeURIComponent(state.cwGroup.conversationId) + '/participants',
        { participants: ['commander'].concat(keys) }
      );
      if (!res.ok || !res.data) {
        toast('保存失败：' + (res.error || '服务未连接'), 'warn');
        return;
      }
      overlay.close();
      state.cwGroup = res.data;
      state.cwMentions = state.cwMentions.filter((k) => groupSpecialists().indexOf(k) !== -1);
      if (!state.cwMentions.length) syncGroupMentions();
      await cwLoadSessions();
      paint();
      toast('参会专员已更新', 'success');
    });
  }

  function cwToggleMention(key) {
    if (state.cwKind !== 'group') return;
    if (key === 'all') {
      syncGroupMentions();
    } else {
      if (key === 'commander') {
        toast('指挥官固定主持，每轮自动收敛总结', 'info');
        return;
      }
      const list = state.cwMentions.slice();
      const i = list.indexOf(key);
      if (i >= 0) {
        if (list.length <= 1) {
          toast('至少保留一位专员发言', 'warn');
          return;
        }
        list.splice(i, 1);
      } else {
        list.push(key);
      }
      state.cwMentions = groupSpecialists().filter((k) => list.indexOf(k) !== -1);
    }
    const bar = document.querySelector('.cw [data-cw-mentions]');
    if (bar) bar.outerHTML = cwMentionBarHtml();
    const picks = document.querySelector('.cw [data-cw-participants]');
    if (picks) picks.outerHTML = cwParticipantsHtml();
  }

  /* 采纳群聊决议：选择任务 → 待人工闸口走 approve（带决议备注），否则推进下一道工序。 */
  function adoptGroupDecision(index) {
    const messages = (state.cwGroup && state.cwGroup.messages) || [];
    const summary = messages[Number(index)];
    if (!summary || !summary.canAdopt) {
      toast('该条不是可采纳的指挥官决议', 'warn');
      return;
    }
    const candidates = (state.tasks || []).filter((t) => {
      const st = taskState(t);
      return !['done', 'cancelled', 'archived', 'paused'].includes(st.key);
    });
    if (!candidates.length) {
      toast('没有可推进的任务，请先新建任务', 'warn');
      return;
    }

    const overlay = ui.modal({
      title: '采纳群聊决议并推进工序',
      desc: '决议会作为人工备注写入审批/推进动作，随后按工作流推进到下一道工序。',
      body: `<div class="cw-group-form">
        <label class="field"><span class="field-label">推进任务</span>
          ${ui.select({
            options: candidates.map((t) => ({
              value: t.id,
              label: t.name + '（' + progressText(t) + '）',
            })),
            attrs: 'data-cw-adopt-task',
          })}
        </label>
        <div class="cw-adopt-quote">${esc(String(summary.text || '').slice(0, 400))}</div>
      </div>`,
      actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}
        ${ui.btn({ label: '采纳并推进', tone: 'primary', attrs: 'data-cw-adopt-ok' })}`,
    });

    overlay.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-cw-adopt-ok]')) return;
      const projectNo = String((overlay.querySelector('[data-cw-adopt-task]') || {}).value || '');
      const task = candidates.find((t) => t.id === projectNo);
      if (!projectNo || !task) {
        toast('请选择任务', 'warn');
        return;
      }
      const st = taskState(task);
      const note = '采纳群聊决议：' + String(summary.text || '').slice(0, 200);
      const url = '/api/business/products/' + encodeURIComponent(projectNo) + '/pipeline/'
        + (st.key === 'waiting' ? 'approve' : 'advance');
      const body = st.key === 'waiting' ? { approved: true, note } : {};
      const res = await request('POST', url, body);
      if (!res.ok) {
        toast('推进失败：' + (res.error || '服务未连接'), 'warn');
        return;
      }
      overlay.close();
      const stateData = res.data || {};
      toast('已采纳并推进：' + (stateData.currentStageName || stateData.currentStage || projectNo), 'success');
      await loadAll();
      paint();
    });
  }

  /* Chat 输入框统一入口：群聊模式走接力会诊，单聊走指挥官本人。 */
  async function sendCwChat(text) {
    if (cwCurrentArchived()) {
      toast('会话已归档，恢复后再发送', 'warn');
      return;
    }
    if (state.cwKind === 'group') {
      await cwSendGroupChat(text);
      return;
    }
    await sendChat(text);
  }

  /* ------------------------------ 动作 ------------------------------ */

  async function sendChat(text) {
    const message = String(text || '').trim();
    if (state.busy) return;
    if (cwCurrentArchived()) {
      toast('会话已归档，恢复后再发送', 'warn');
      return;
    }
    if (!message && !state.cwAttachments.length) return;

    const conv = cwEnsureId();
    const attachments = state.cwAttachments.map((a) => ({
      name: a.name, mime: a.mime, size: a.size, text: a.text || null,
    }));

    state.busy = true;
    state.chat.push({
      role: 'user',
      text: message || '（仅发送挂载附件）',
      meta: attachments.length ? '附件 ' + attachments.length + ' 个' : null,
    });
    paint();

    const res = await request('POST', '/api/agents/commander/chat', {
      conversationId: conv,
      message: message || '请分析我挂载的附件。',
      attachments,
    });
    state.busy = false;

    if (!res.ok) {
      state.chat.push({ role: 'assistant', text: '调用失败：' + (res.error || '服务未连接') });
      toast('指挥官调用失败', 'warn');
      paint();
      return;
    }

    const d = res.data || {};
    const traceCount = Array.isArray(d.trace) ? d.trace.length : 0;
    const meta = [
      d.mode ? '通道 ' + d.mode : '',
      d.model ? '模型 ' + d.model : '',
      traceCount ? '工具 ' + traceCount + ' 次' : '',
      d.contextChars ? '注入 ' + d.contextChars + ' 字' : '',
      d.elapsedMs != null ? d.elapsedMs + ' ms' : '',
    ].filter(Boolean).join(' · ');
    state.chat.push({ role: 'assistant', text: d.output || '（模型未返回文本）', meta });
    state.dockExtra.push({ at: new Date().toISOString(), text: String(d.output || '').slice(0, 160) });
    state.cwAttachments = [];
    await cwLoadSessions();
    paint();
  }

  async function createTask() {
    const pipelineOptions = state.pipelines.map((p) => ({ value: p.pipelineId, label: p.name }));
    if (!pipelineOptions.length) {
      toast('还没有工作流配方，无法创建任务', 'warn');
      return;
    }

    const overlay = ui.modal({
      title: '新建任务',
      desc: '按工作流配方创建任务：写入 sku_project 并定位到首道工序（不伪造执行结果）。',
      body: `<div class="cmd-form">
        <label class="field"><span class="field-label">任务名称</span>${ui.input({ placeholder: '如：本周选品上线 20 款', attrs: 'data-new-title' })}</label>
        <label class="field"><span class="field-label">工作流</span>${ui.select({ options: pipelineOptions, attrs: 'data-new-pipeline' })}</label>
        <label class="field"><span class="field-label">类目（可空）</span>${ui.input({ placeholder: '如：女装/连衣裙', attrs: 'data-new-category' })}</label>
      </div>`,
      actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}
        ${ui.btn({ label: '创建任务', tone: 'primary', attrs: 'data-new-submit' })}`,
    });

    overlay.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-new-submit]')) return;
      const title = String((overlay.querySelector('[data-new-title]') || {}).value || '').trim();
      const pipelineId = String((overlay.querySelector('[data-new-pipeline]') || {}).value || '');
      const category = String((overlay.querySelector('[data-new-category]') || {}).value || '').trim();
      if (!title) {
        toast('请填写任务名称', 'warn');
        return;
      }
      const btn = overlay.querySelector('[data-new-submit]');
      if (btn) btn.disabled = true;
      const res = await request('POST', '/api/business/products', { title, pipelineId, category });
      if (btn) btn.disabled = false;
      if (!res.ok) {
        toast('创建失败：' + (res.error || '服务未连接'), 'warn');
        return;
      }
      overlay.close();
      toast('任务已创建：' + (res.data && res.data.id), 'success');
      await loadAll();
      paint();
    });
  }

  async function advanceTask(projectNo) {
    const res = await request('POST', '/api/business/products/' + encodeURIComponent(projectNo) + '/pipeline/advance', {});
    if (!res.ok) {
      toast('推进失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    const st = res.data || {};
    toast('已推进：' + (st.currentStageName || st.currentStage) + ' · ' + (st.stageStatus || ''), 'success');
    await loadAll();
    paint();
  }

  async function cancelTask(projectNo, title) {
    const ok = await ui.confirm({
      title: '终止任务？',
      desc: `「${title}」将被标记为已终止，后续不能继续推进；如需重做请新建任务。`,
      ok: '终止',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await request('POST', '/api/business/products/' + encodeURIComponent(projectNo) + '/pipeline/cancel', {
      note: '指挥官界面人工终止',
    });
    if (!res.ok) {
      toast('终止失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast('任务已终止', 'success');
    await loadAll();
    paint();
  }

  async function refreshMemoryWorkspace() {
    await loadMemoryWorkspace();
    paint();
  }

  async function learnMemory() {
    if (state.memLearning) return;
    state.memLearning = true;
    paint();
    const res = await request('POST', '/api/agents/commander/memory/learn', {});
    state.memLearning = false;
    if (!res.ok) {
      toast('提炼失败：' + (res.error || '服务未连接'), 'warn');
      paint();
      return;
    }
    const data = res.data || {};
    await loadMemoryWorkspace();
    paint();
    if (data.added > 0) {
      toast(`已提炼 ${data.added} 条待确认规则（扫描 ${data.scanned || 0} 条证据）`, 'success');
    } else {
      toast(`近 7 天没有可提炼的新证据（扫描 ${data.scanned || 0} 条）`, 'info');
    }
  }

  function memSyncPicksHtml(selected, ownerKey) {
    const owner = ownerKey || 'commander';
    const keys = selected || [];
    return ((state.wfAgents || []).filter((a) => a.key !== owner && a.enabled !== false))
      .map(
        (a) => `<label class="cw-agent-pick">
          <input type="checkbox" data-mem-sync="${esc(a.key)}"${keys.indexOf(a.key) !== -1 ? ' checked' : ''} />
          <span>${esc(allAgentLabel(a.key))}</span>
        </label>`
      )
      .join('');
  }

  function confirmMemoryModal(id) {
    const candidate = ((state.memory && state.memory.memories) || []).find((m) => String(m.id) === String(id));
    if (!candidate) return;
    const conflict = candidate.conflict;
    const overlay = ui.modal({
      title: conflict ? '确认并替换旧规则' : '确认候选规则',
      desc: conflict
        ? `确认后旧规则 #${memNo(conflict.id)} 将自动归档，确保 System Prompt 不会同时看到两条矛盾规则。`
        : '确认后该规则进入生效状态，后续命中标签的任务才会注入。',
      body: `<div class="cmd-mem-confirm">
        <div class="cmd-mem-confirm-rule">
          <div class="cmd-mem-subject">${esc(candidate.subject)}${
            candidate.metric ? `<em>${esc(candidate.metric)}</em>` : ''
          }</div>
          <div class="cmd-mem-tags">${memTagChips(candidate.tags)}</div>
          <div class="cmd-mem-value">${esc(candidate.valueText)}</div>
        </div>
        ${
          conflict
            ? `<div class="cmd-mem-conflict-box">⚡ 旧规则 #${memNo(conflict.id)}（${esc(
                conflict.metric || conflict.subject
              )}）将被自动归档</div>`
            : ''
        }
        <div class="field"><span class="field-label">同步至其它 Agent（跨专员分发）</span>
          <div class="cw-agent-picks">${memSyncPicksHtml(candidate.syncAgentKeys)}</div>
        </div>
        <div class="tiny dim">同步后的规则只在该 Agent 的任务标签命中时注入；确认后立即生效。</div>
      </div>`,
      actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}
        ${ui.btn({
          label: conflict ? '✅ 确认并替换' : '✅ 确认生效',
          tone: 'primary',
          attrs: 'data-cmd-mem-confirm-ok',
        })}`,
    });

    overlay.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-cmd-mem-confirm-ok]')) return;
      const syncAgentKeys = [...overlay.querySelectorAll('[data-mem-sync]:checked')].map((el) => el.dataset.memSync);
      const res = await request(
        'POST',
        '/api/agents/commander/memory/' + encodeURIComponent(id) + '/confirm',
        { replace: !!conflict, syncAgentKeys }
      );
      if (!res.ok) {
        toast('确认失败：' + (res.error || '服务未连接'), 'warn');
        return;
      }
      overlay.close();
      await refreshMemoryWorkspace();
      const archived = (res.data && res.data.archivedRuleIds) || [];
      toast(archived.length ? `规则已生效，旧规则 #${archived.map(memNo).join('、')} 已归档` : '规则已生效', 'success');
    });
  }

  async function rejectMemory(id) {
    const ok = await ui.confirm({
      title: '驳回这条候选规则？',
      desc: '驳回后不会注入 System Prompt，同一证据不会再次自动提示。',
      ok: '驳回',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await request('POST', '/api/agents/commander/memory/' + encodeURIComponent(id) + '/reject', {});
    if (!res.ok) {
      toast('驳回失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast('候选规则已驳回', 'success');
    await refreshMemoryWorkspace();
  }

  async function archiveMemory(id) {
    const ok = await ui.confirm({
      title: '归档这条规则？',
      desc: '归档后不再注入 System Prompt，可在状态筛选中查看历史。',
      ok: '归档',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await request('POST', '/api/agents/commander/memory/' + encodeURIComponent(id) + '/archive', {});
    if (!res.ok) {
      toast('归档失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast('规则已归档', 'success');
    await refreshMemoryWorkspace();
  }

  function openAddMemoryModal(shareAll, editId) {
    const existing = editId
      ? ((state.memory && state.memory.memories) || []).find((m) => String(m.id) === String(editId))
      : null;
    const allKeys = (state.wfAgents || [])
      .filter((a) => a.key !== 'commander' && a.enabled !== false)
      .map((a) => a.key);
    const initialSync = existing ? existing.syncAgentKeys || [] : shareAll ? allKeys : [];
    let mode = existing
      ? initialSync.length === 0
        ? 'current'
        : initialSync.length >= allKeys.length
          ? 'all'
          : 'selected'
      : shareAll
        ? 'all'
        : 'current';
    const selectedSync = new Set(initialSync);
    const tags = existing ? memTagsOf(existing.tags) : ['全局'];
    const confirmed = existing ? String(existing.status || '').toLowerCase() !== 'pending' : true;
    const expiryOptions = existing
      ? [
          { value: 'keep', label: '保持当前有效期' },
          { value: 'permanent', label: '永久' },
          { value: '90', label: '90 天（季节性规则，到期提醒复核）' },
          { value: '180', label: '180 天' },
        ]
      : [
          { value: '90', label: '90 天（季节性规则，到期提醒复核）' },
          { value: 'permanent', label: '永久' },
          { value: '180', label: '180 天' },
        ];
    const confidenceValue = existing ? String(Math.round(Number(existing.confidence || 1) * 100)) : '100';

    const overlay = ui.modal({
      title: existing ? '编辑记忆规则 (Edit Memory Rule)' : '手动新增记忆规则 (Add Memory Rule)',
      body: `<div class="cmd-mem-form cmd-mem-form--wide">
        <div class="cmd-mem-section-title">记忆归属与作用范围 <span>(Ownership &amp; Scope)</span></div>
        <div class="cmd-mem-scope-tabs">
          <button type="button" class="cmd-mem-scope-tab${mode === 'current' ? ' is-on' : ''}" data-mem-mode="current">
            仅当前 Agent（指挥官）
          </button>
          <button type="button" class="cmd-mem-scope-tab${mode === 'selected' ? ' is-on' : ''}" data-mem-mode="selected">
            指定同步给下属专员 (Selected)
          </button>
          <button type="button" class="cmd-mem-scope-tab${mode === 'all' ? ' is-on' : ''}" data-mem-mode="all">
            升级为团队共享记忆（全员生效）
          </button>
        </div>
        <div class="cmd-mem-agent-chips" data-mem-agent-chips>
          <label class="cmd-mem-agent-chip is-owner is-on">
            <input type="checkbox" checked disabled />
            <i class="cw-dot" data-agent="commander"></i>指挥官
          </label>
          ${(state.wfAgents || [])
            .filter((a) => a.key !== 'commander' && a.enabled !== false)
            .map(
              (a) => `<label class="cmd-mem-agent-chip${selectedSync.has(a.key) && mode !== 'current' ? ' is-on' : ''}">
                <input type="checkbox" data-mem-agent="${esc(a.key)}"${
                  selectedSync.has(a.key) && mode !== 'current' ? ' checked' : ''
                }${mode === 'selected' ? '' : ' disabled'} />
                <i class="cw-dot" data-agent="${esc(a.key)}"></i>${esc(allAgentLabel(a.key))}
              </label>`
            )
            .join('')}
        </div>
        <div class="cmd-mem-grid2">
          <label class="field"><span class="field-label">规则主题 &amp; 监控指标 (Subject &amp; Metric)</span>
            ${ui.input({
              placeholder: '如：选品分派 · 材质准入',
              value: existing ? existing.subject : '',
              attrs: 'data-mem-form-subject',
            })}
          </label>
          <label class="field"><span class="field-label">Target Metric</span>
            ${ui.input({
              placeholder: '如：inner_material（内胆材质）',
              value: existing ? existing.metric || '' : '',
              attrs: 'data-mem-form-metric',
            })}
          </label>
        </div>
        <div class="field"><span class="field-label">适用触发标签</span>
          <div class="cmd-kn-tag-editor" data-mem-tags>${tags
            .map(
              (t, i) => `<span class="cmd-kn-tag">#${esc(t)}<button type="button" data-mem-tag-del="${i}" title="移除标签">×</button></span>`
            )
            .join('')}<input class="cmd-kn-tag-input" placeholder="+ 添加标签" data-mem-tag-input autocomplete="off" /></div>
        </div>
        <div class="field"><span class="field-label">规则事实正文 (Rule Fact - 将直接注入 System Prompt 第 3 层)</span>
          <textarea class="input cmd-mem-fact" rows="4" maxlength="500" data-mem-form-value placeholder="针对保温杯类目，优先筛选 316 医用级不锈钢内胆款式；严禁立项玻璃内胆保温杯（运输破损率 > 18%）…">${esc(
            existing ? existing.valueText : ''
          )}</textarea>
          <div class="cmd-mem-char"><span data-mem-fact-count>${existing ? String(existing.valueText || '').length : 0}</span> / 500 字</div>
        </div>
        <div class="cmd-mem-grid2">
          <label class="field"><span class="field-label">有效期</span>${ui.select({
            options: expiryOptions,
            value: existing ? 'keep' : '90',
            attrs: 'data-mem-form-expiry',
          })}</label>
          <label class="field"><span class="field-label">初始置信度</span>${ui.select({
            options: [
              { value: '100', label: '100%（人工录入）' },
              { value: '95', label: '95%' },
              { value: '90', label: '90%' },
              { value: '80', label: '80%' },
            ],
            value: confidenceValue,
            attrs: 'data-mem-form-confidence',
          })}</label>
        </div>
        <label class="cmd-mem-confirm-line">
          <input type="checkbox" data-mem-confirmed${confirmed ? ' checked' : ''} />
          <span>人工录入直接设为「✅ 已确认生效 (Confirmed)」并自动归档同维度冲突旧规则</span>
        </label>
      </div>`,
      actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}
        ${ui.btn({
          label: existing ? '确认保存并生效' : '确认保存并生效',
          tone: 'primary',
          attrs: 'data-cmd-mem-add-ok',
        })}`,
    });
    const modalEl = overlay.querySelector('.modal');
    if (modalEl) modalEl.classList.add('modal--wide');

    function renderTags(focus) {
      const host = overlay.querySelector('[data-mem-tags]');
      if (!host) return;
      host.innerHTML =
        tags
          .map(
            (t, i) =>
              `<span class="cmd-kn-tag">#${esc(t)}<button type="button" data-mem-tag-del="${i}" title="移除标签">×</button></span>`
          )
          .join('') +
        '<input class="cmd-kn-tag-input" placeholder="+ 添加标签" data-mem-tag-input autocomplete="off" />';
      if (focus) {
        const input = host.querySelector('[data-mem-tag-input]');
        if (input) input.focus();
      }
    }

    function applyMode(next) {
      mode = next;
      overlay.querySelectorAll('[data-mem-mode]').forEach((btn) => {
        btn.classList.toggle('is-on', btn.dataset.memMode === mode);
      });
      overlay.querySelectorAll('[data-mem-agent]').forEach((input) => {
        const key = input.dataset.memAgent;
        if (mode === 'current') {
          input.checked = false;
          input.disabled = true;
        } else if (mode === 'all') {
          input.checked = true;
          input.disabled = true;
          selectedSync.add(key);
        } else {
          input.disabled = false;
          input.checked = selectedSync.has(key);
        }
        const chip = input.closest('.cmd-mem-agent-chip');
        if (chip) chip.classList.toggle('is-on', input.checked);
      });
    }

    overlay.addEventListener('click', async (e) => {
      const modeBtn = e.target.closest('[data-mem-mode]');
      if (modeBtn) {
        applyMode(modeBtn.dataset.memMode);
        return;
      }
      const tagDel = e.target.closest('[data-mem-tag-del]');
      if (tagDel) {
        tags.splice(Number(tagDel.dataset.memTagDel), 1);
        renderTags(false);
        return;
      }
      if (e.target.closest('[data-mem-tag-input]')) return;
      if (!e.target.closest('[data-cmd-mem-add-ok]')) return;

      const subject = String((overlay.querySelector('[data-mem-form-subject]') || {}).value || '').trim();
      const metric = String((overlay.querySelector('[data-mem-form-metric]') || {}).value || '').trim();
      const valueText = String((overlay.querySelector('[data-mem-form-value]') || {}).value || '').trim();
      const expiryValue = String((overlay.querySelector('[data-mem-form-expiry]') || {}).value || '90');
      const confidence = Number((overlay.querySelector('[data-mem-form-confidence]') || {}).value || 100) / 100;
      const isConfirmed = !!(overlay.querySelector('[data-mem-confirmed]') || {}).checked;
      if (!subject || !valueText) {
        toast('请填写规则主题与内容', 'warn');
        return;
      }
      const syncAgentKeys =
        mode === 'current'
          ? []
          : mode === 'all'
            ? allKeys
            : [...overlay.querySelectorAll('[data-mem-agent]:checked')].map((el) => el.dataset.memAgent);
      let expiresAt = null;
      if (expiryValue === 'keep' && existing) {
        expiresAt = existing.expiresAt || null;
      } else if (expiryValue !== 'permanent') {
        expiresAt = new Date(Date.now() + Number(expiryValue) * 86400000).toISOString();
      }

      const payload = {
        subject,
        metric: metric || null,
        valueText,
        confidence,
        tags: tags.join(' '),
        expiresAt,
        syncAgentKeys,
        confirmed: isConfirmed,
      };
      const res = existing
        ? await request('PUT', '/api/agents/commander/memory/' + encodeURIComponent(existing.id), payload)
        : await request('POST', '/api/agents/commander/memory', payload);
      if (!res.ok) {
        toast('保存失败：' + (res.error || '服务未连接'), 'warn');
        return;
      }
      overlay.close();
      await refreshMemoryWorkspace();
      toast(isConfirmed ? '规则已保存并生效' : '规则已保存为待确认', 'success');
    });

    overlay.addEventListener('input', (e) => {
      if (e.target.matches('[data-mem-form-value]')) {
        const count = overlay.querySelector('[data-mem-fact-count]');
        if (count) count.textContent = String(e.target.value || '').length;
      }
    });

    overlay.addEventListener('change', (e) => {
      const agent = e.target.closest('[data-mem-agent]');
      if (agent) {
        const key = agent.dataset.memAgent;
        if (agent.checked) selectedSync.add(key);
        else selectedSync.delete(key);
        const chip = agent.closest('.cmd-mem-agent-chip');
        if (chip) chip.classList.toggle('is-on', agent.checked);
      }
    });

    overlay.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.matches('[data-mem-tag-input]')) return;
      e.preventDefault();
      const tag = String(e.target.value || '').replace(/^#+/, '').trim();
      if (tag && tag !== '全局') {
        const globalIndex = tags.indexOf('全局');
        if (globalIndex !== -1) tags.splice(globalIndex, 1);
      }
      if (tag && tags.indexOf(tag) === -1) tags.push(tag);
      renderTags(true);
    });
  }

  function newKnowledgeDraft() {
    state.memKnowledgeDraft = memKnowledgeDraftFrom(null);
    paint();
  }

  function selectKnowledgeDoc(id) {
    const doc = ((state.memory && state.memory.knowledge) || []).find((k) => String(k.id) === String(id));
    if (!doc) return;
    state.memKnowledgeDraft = memKnowledgeDraftFrom(doc);
    paint();
  }

  function importKnowledgeFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,.txt,text/plain,text/markdown';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const text = (await file.text()).slice(0, 200_000);
        state.memKnowledgeDraft = {
          id: 'new',
          title: file.name.replace(/\.[^.]+$/, ''),
          tags: ['导入'],
          content: text,
          enabled: true,
        };
        paint();
        toast('文档已载入，请确认标签与内容后保存', 'info');
      } catch (_) {
        toast('读取文档失败', 'warn');
      }
    });
    input.click();
  }

  function refreshKnTagEditor(focus) {
    const editor = document.querySelector('[data-cmd-kn-tag-editor]');
    if (!editor) return;
    editor.innerHTML = memKnTagEditorHtml();
    if (focus) {
      const input = editor.querySelector('[data-cmd-kn-tag-input]');
      if (input) input.focus();
    }
  }

  function addKnTag(value) {
    const draft = state.memKnowledgeDraft;
    if (!draft) return;
    const tag = String(value || '').replace(/^#+/, '').trim();
    if (!tag) return;
    if (tag !== '全局') {
      const globalIndex = draft.tags.indexOf('全局');
      if (globalIndex !== -1) draft.tags.splice(globalIndex, 1);
    }
    if (draft.tags.indexOf(tag) === -1) draft.tags.push(tag);
    refreshKnTagEditor(true);
  }

  async function saveKnowledgeDraft() {
    const draft = state.memKnowledgeDraft;
    if (!draft) return;
    const title = String((document.querySelector('[data-cmd-kn-title-input]') || {}).value || '').trim();
    const content = String((document.querySelector('[data-cmd-kn-content]') || {}).value || '').trim();
    if (!title || !content) {
      toast('请填写文档标题与正文', 'warn');
      return;
    }
    const tags = (draft.tags || []).join(',');
    const res =
      draft.id === 'new'
        ? await request('POST', '/api/agents/commander/knowledge', { title, tags, content })
        : await request('PUT', '/api/agents/commander/knowledge/' + encodeURIComponent(draft.id), {
            title,
            tags,
            content,
            enabled: draft.enabled !== false,
          });
    if (!res.ok) {
      toast('保存失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    const savedId = draft.id === 'new' ? res.data && res.data.id : draft.id;
    await loadMemoryWorkspace();
    const saved = ((state.memory && state.memory.knowledge) || []).find((k) => String(k.id) === String(savedId));
    state.memKnowledgeDraft = saved ? memKnowledgeDraftFrom(saved) : null;
    paint();
    toast(draft.id === 'new' ? '知识条目已新建并启用' : '知识条目已保存', 'success');
  }

  async function deleteKnowledgeDoc(id) {
    const ok = await ui.confirm({
      title: '删除这条知识？',
      desc: '删除后不再注入指挥官上下文，且不可恢复。',
      ok: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await request('DELETE', '/api/agents/commander/knowledge/' + encodeURIComponent(id));
    if (!res.ok) {
      toast('删除失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    state.memKnowledgeDraft = null;
    await refreshMemoryWorkspace();
    toast('知识条目已删除', 'success');
  }

  async function toggleKnowledgeEnabled(id) {
    const doc = ((state.memory && state.memory.knowledge) || []).find((k) => String(k.id) === String(id));
    if (!doc) return;
    const res = await request('PUT', '/api/agents/commander/knowledge/' + encodeURIComponent(id), {
      title: doc.title,
      tags: doc.tags || '',
      content: doc.content || '',
      enabled: doc.enabled === false,
    });
    if (!res.ok) {
      toast('操作失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast(doc.enabled === false ? '知识条目已启用' : '知识条目已停用', 'success');
    await loadMemoryWorkspace();
    paint();
  }

  async function broadcastTeamMemory() {
    const ok = await ui.confirm({
      title: '一键广播同步至全员？',
      desc: '当前 Agent 的全部生效规则会同步给其余启用 Agent；之后可在每行用「作用范围」调整或「下线」。',
      ok: '广播',
      tone: 'primary',
    });
    if (!ok) return;
    const res = await request('POST', '/api/agents/commander/memory/team/broadcast', {});
    if (!res.ok) {
      toast('广播失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    const count = (res.data && res.data.shared) || 0;
    toast(`已广播 ${count} 条规则至全员`, 'success');
    await refreshMemoryWorkspace();
  }

  async function unshareTeamRule(id) {
    const ok = await ui.confirm({
      title: '下线这条共享规则？',
      desc: '停止同步给其它 Agent，本 Agent 的原始规则仍保留；需要时可重新广播。',
      ok: '下线',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await request(
      'POST',
      '/api/agents/commander/memory/team/' + encodeURIComponent(id) + '/unshare',
      {}
    );
    if (!res.ok) {
      toast('下线失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast('共享规则已下线', 'success');
    await refreshMemoryWorkspace();
  }

  function openTeamEditModal(id, scopeOnly) {
    const row = (state.memTeam || []).find((m) => String(m.id) === String(id));
    if (!row) return;
    const overlay = ui.modal({
      title: scopeOnly ? '调整共享作用范围' : '编辑共享规则',
      desc: '修改后立即作用于团队共享注入；同步对象为空时该规则会从团队共享列表下线。',
      body: `<div class="cmd-mem-form">
        <label class="field"><span class="field-label">共享维度 / 主题</span>${ui.input({
          placeholder: '如：平台合规 · 极限违禁词',
          value: row.subject || '',
          attrs: 'data-team-form-subject',
        })}</label>
        <label class="field"><span class="field-label">指标 / 条件（可空）</span>${ui.input({
          placeholder: '如：价格阈值 > ¥100',
          value: row.metric || '',
          attrs: 'data-team-form-metric',
        })}</label>
        <label class="field"><span class="field-label">全局规则事实</span>
          <textarea class="input" rows="3" data-team-form-value>${esc(row.valueText || '')}</textarea>
        </label>
        <label class="field"><span class="field-label">适用标签</span>${ui.input({
          placeholder: '如：#全局 #微信小店',
          value: row.tags || '',
          attrs: 'data-team-form-tags',
        })}</label>
        <div class="field"><span class="field-label">作用范围（同步至）</span>
          <div class="cw-agent-picks">${memSyncPicksHtml(row.syncAgentKeys, row.agentKey)}</div>
        </div>
      </div>`,
      actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}
        ${ui.btn({ label: '保存共享规则', tone: 'primary', attrs: 'data-cmd-team-edit-ok' })}`,
    });

    overlay.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-cmd-team-edit-ok]')) return;
      const subject = String((overlay.querySelector('[data-team-form-subject]') || {}).value || '').trim();
      const metric = String((overlay.querySelector('[data-team-form-metric]') || {}).value || '').trim();
      const valueText = String((overlay.querySelector('[data-team-form-value]') || {}).value || '').trim();
      const tags = String((overlay.querySelector('[data-team-form-tags]') || {}).value || '').trim();
      const syncAgentKeys = [...overlay.querySelectorAll('[data-mem-sync]:checked')].map((el) => el.dataset.memSync);
      if (!subject || !valueText) {
        toast('请填写共享主题与规则内容', 'warn');
        return;
      }
      const res = await request('PUT', '/api/agents/commander/memory/team/' + encodeURIComponent(id), {
        subject,
        metric: metric || null,
        valueText,
        tags,
        syncAgentKeys,
      });
      if (!res.ok) {
        toast('保存失败：' + (res.error || '服务未连接'), 'warn');
        return;
      }
      overlay.close();
      await refreshMemoryWorkspace();
      toast('共享规则已更新', 'success');
    });
  }

  async function deleteMemory(id) {
    const ok = await ui.confirm({
      title: '删除这条记忆？',
      desc: '删除为软删（保留审计痕迹），删除后不再注入。',
      ok: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await request('DELETE', '/api/agents/commander/memory/' + encodeURIComponent(id));
    if (!res.ok) {
      toast('删除失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast('记忆已删除', 'success');
    await refreshMemoryWorkspace();
  }

  async function toggleMemoryL1(enabled) {
    const settings = (state.memory && state.memory.settings) || {};
    const res = await request('PUT', '/api/agents/commander/context', {
      maxMemoryChars: settings.maxMemoryChars,
      maxKnowledgeChars: settings.maxKnowledgeChars,
      enableL1Extraction: !!enabled,
    });
    if (!res.ok) {
      toast('保存失败：' + (res.error || '服务未连接'), 'warn');
      paint();
      return;
    }
    if (state.memory) state.memory.settings = res.data;
    toast(enabled ? '已开启 L1 显式记忆提取' : '已关闭 L1 显式记忆提取', 'success');
    paint();
  }

  /* ------------------------------ 渲染根 ------------------------------ */

  function content() {
    const root = document.querySelector('.cmd-page');
    const main = root && root.querySelector('[data-cmd-main]');
    const rail = root && root.querySelector('.cmd-rail');
    const dock = root && root.querySelector('.cmd-dock');
    if (main) main.innerHTML = mainHtml();
    if (rail) rail.outerHTML = railHtml();
    if (dock) dock.outerHTML = dockHtml();
    wireDynamic();
    const log = document.querySelector('[data-cmd-chat-log]');
    if (log) log.scrollTop = log.scrollHeight;
  }

  function wireWorkflow() {
    const root = document.querySelector(".cmd-page");
    if (!root) return;
    // 闸口开关 / 配方启用开关
    root.querySelectorAll('[data-wf-gate]').forEach((el) => {
      el.addEventListener('change', () => {
        if (!state.wfDraft) return;
        const idx = Number(el.dataset.wfGate);
        const stage = state.wfDraft.stages[idx];
        if (!stage) return;
        stage.requireHuman = !!el.checked;
        wfDirty(true);
      });
    });
    const enableEl = root.querySelector('[data-wf-enabled]');
    if (enableEl) {
      enableEl.addEventListener('change', () => {
        if (!state.wfDraft) return;
        state.wfDraft.enabled = !!enableEl.checked;
        wfDirty(true);
      });
    }
    const searchEl = root.querySelector('[data-wf-search]');
    if (searchEl) {
      searchEl.addEventListener('input', () => {
        state.wfSearch = searchEl.value;
        const list = root.querySelector('.wf-list');
        if (list) {
          list.outerHTML = `<aside class="wf-list">
            <div class="wf-list-head">工作流配方列表<span class="cmd-count">${wfFiltered().length}</span></div>
            <div class="wf-list-body">${wfListHtml()}</div>
          </aside>`;
          wireWorkflow();
        }
      });
    }
    const sourceEl = root.querySelector('[data-wf-source]');
    if (sourceEl) {
      sourceEl.addEventListener('change', () => {
        state.wfSource = sourceEl.value;
        const list = root.querySelector('.wf-list');
        if (list) {
          list.outerHTML = `<aside class="wf-list">
            <div class="wf-list-head">工作流配方列表<span class="cmd-count">${wfFiltered().length}</span></div>
            <div class="wf-list-body">${wfListHtml()}</div>
          </aside>`;
          wireWorkflow();
        }
      });
    }
  }

  function paint() {
    const host = document.querySelector('[data-cmd-body]');
    if (!host) return;
    // 工作流 / Chat / 记忆体 / Skill 需要更大的画布：隐藏右栏指令台，主区占满
    const wide =
      state.panel === 'pipelines' ||
      state.panel === 'chat' ||
      state.panel === 'memory' ||
      state.panel === 'skills' ||
      state.panel === 'mcp' ||
      state.panel === 'logs';
    host.className = 'cmd-body' + (wide ? ' cmd-body--wide' : '');
    host.innerHTML = `${railHtml()}<section class="cmd-main" data-cmd-main>${mainHtml()}</section>${wide ? '' : dockHtml()}`;
    wireDynamic();
    wireWorkflow();
    wireSkillToolGroups();
    const log = document.querySelector('[data-cmd-chat-log]');
    if (log) log.scrollTop = log.scrollHeight;
  }

  function wireDynamic() {
    const root = document.querySelector('.cmd-page');
    if (!root) return;

    const kw = root.querySelector('[data-cmd-kw]');
    if (kw) {
      kw.addEventListener('input', () => {
        state.filters.keyword = kw.value;
        const main = root.querySelector('[data-cmd-main]');
        if (main) main.innerHTML = workbenchHtml();
        wireDynamic();
      });
    }
    ['range', 'pipeline', 'status'].forEach((key) => {
      const el = root.querySelector('[data-cmd-' + key + ']');
      if (el) {
        el.addEventListener('change', () => {
          state.filters[key] = el.value;
          const main = root.querySelector('[data-cmd-main]');
          if (main) main.innerHTML = workbenchHtml();
          wireDynamic();
        });
      }
    });
  }

  /* ------------------------------ 页面注册 ------------------------------ */

  WB.commanderPage = {
    title: '指挥官管理界面',
    subtitle: '任务编排 · 流水线推进 · 协同指令',

    render() {
      return `<div class="cmd-page">
        ${topHtml()}
        <div class="cmd-body" data-cmd-body>${railHtml()}<section class="cmd-main" data-cmd-main>${mainHtml()}</section>${dockHtml()}</div>
      </div>`;
    },

    mount(root, ctx) {
      state.panel = 'workbench';
      state.loaded = false;
      state.chat = [];
      state.dockExtra = [];
      state.cwConversationId = '';
      state.cwSessions = [];
      state.cwSessionsLoaded = false;
      state.cwAttachments = [];
      state.cwMemory = null;

      const page = root.querySelector('.cmd-page');
      if (!page) return;

      const closeDrawerIfAny = () => {
        if (WB.pipelineDrawer) WB.pipelineDrawer.close();
      };
      closeDrawerIfAny();

      function closeUserMenu() {
        page.querySelectorAll('[data-user-menu-pop]').forEach((pop) => { pop.hidden = true; });
        page.querySelectorAll('[data-user-menu-toggle]').forEach((btn) => { btn.setAttribute('aria-expanded', 'false'); });
      }

      page.addEventListener('click', async (e) => {
        if (!e.target.closest('.cw-input-wrap')) closeCwMenu();
        if (!e.target.closest('[data-cmd-model-picker]')) closeCmdModelMenu();
        const userToggle = e.target.closest('[data-user-menu-toggle]');
        if (userToggle) {
          e.preventDefault();
          const menu = userToggle.closest('[data-user-menu]');
          const pop = menu ? menu.querySelector('[data-user-menu-pop]') : null;
          const willOpen = pop ? pop.hidden : false;
          closeUserMenu();
          if (pop && willOpen) {
            pop.hidden = false;
            userToggle.setAttribute('aria-expanded', 'true');
          }
          return;
        }
        if (e.target.closest('[data-user-switch]')) {
          e.preventDefault();
          closeUserMenu();
          const bridge = window.workbench;
          if (bridge && typeof bridge.switchUser === 'function') bridge.switchUser();
          return;
        }
        if (e.target.closest('[data-user-exit]')) {
          e.preventDefault();
          closeUserMenu();
          const bridge = window.workbench;
          if (bridge && typeof bridge.quit === 'function') bridge.quit();
          return;
        }
        if (!e.target.closest('[data-user-menu]')) closeUserMenu();
        if (e.target.closest('[data-cmd-back]')) {
          if (typeof WB.commanderBack === 'function') WB.commanderBack();
          else WB.go('agents');
          return;
        }
        if (e.target.closest('[data-cmd-model-toggle]')) {
          const menu = page.querySelector('[data-cmd-model-menu]');
          if (menu) {
            const willOpen = menu.hidden;
            closeCmdModelMenu();
            menu.hidden = !willOpen;
          }
          return;
        }
        const pickModel = e.target.closest('[data-cmd-pick-model]');
        if (pickModel) {
          selectCommanderModel(pickModel.dataset.cmdPickModel);
          return;
        }
        const winBtn = e.target.closest('[data-cmd-win]');
        if (winBtn) {
          const bridge = window.workbench;
          if (!bridge) return;
          const action = winBtn.dataset.cmdWin;
          if (action === 'minimize') bridge.minimize();
          else if (action === 'maximize') bridge.toggleMaximize();
          else if (action === 'close') bridge.close();
          return;
        }
        const panelBtn = e.target.closest('[data-cmd-panel]');
        if (panelBtn) {
          state.panel = panelBtn.dataset.cmdPanel;
          // 从任务详情切走：回到列表视图
          state.view = 'list';
          if (state.panel === 'pipelines') ensureWfDraft();
          paint();
          if (state.panel === 'memory') {
            await loadMemoryWorkspace();
            paint();
            return;
          }
          if (state.panel === 'skills') {
            await loadSkillsWorkspace();
            paint();
            return;
          }
          if (state.panel === 'logs') {
            await loadAuditLogs();
            paint();
            return;
          }
          if (state.panel === 'mcp') {
            await loadMcpWorkspace();
            paint();
            return;
          }
          if (state.panel === 'chat') {
            await cwBootstrapChat();
            paint();
          }
          return;
        }
        if (e.target.closest('[data-mcp-new]')) {
          openGlobalMcpPage();
          return;
        }
        const mcpServerCard = e.target.closest('[data-mcp-server]');
        if (mcpServerCard) {
          await mcpSelectServer(mcpServerCard.dataset.mcpServer);
          return;
        }
        const mcpTab = e.target.closest('[data-mcp-tab]');
        if (mcpTab) {
          state.mcpTab = mcpTab.dataset.mcpTab;
          paint();
          return;
        }
        const mcpPageBtn = e.target.closest('[data-mcp-page]');
        if (mcpPageBtn) {
          state.mcpPage = Math.max(1, Number(mcpPageBtn.dataset.mcpPage) || 1);
          paint();
          return;
        }
        if (e.target.closest('[data-mcp-save]')) {
          await saveMcpSlice();
          return;
        }
        if (e.target.closest('[data-mcp-reset]')) {
          await resetMcpSlice();
          return;
        }
        if (e.target.closest('[data-mcp-copy-yaml]')) {
          copyMcpYaml();
          return;
        }
        if (e.target.closest('[data-cmd-new]')) {
          createTask();
          return;
        }
        const detail = e.target.closest('[data-cmd-detail]');
        if (detail) {
          openTask(detail.dataset.cmdDetail);
          return;
        }
        const rowPause = e.target.closest('[data-cmd-row-pause]');
        if (rowPause) {
          await listTaskAction('pause', rowPause.dataset.cmdRowPause);
          return;
        }
        const rowResume = e.target.closest('[data-cmd-row-resume]');
        if (rowResume) {
          await listTaskAction('resume', rowResume.dataset.cmdRowResume);
          return;
        }
        const rowCancel = e.target.closest('[data-cmd-row-cancel]');
        if (rowCancel) {
          await listTaskAction('cancel', rowCancel.dataset.cmdRowCancel);
          return;
        }
        const rowArchive = e.target.closest('[data-cmd-row-archive]');
        if (rowArchive) {
          await archiveTask(rowArchive.dataset.cmdRowArchive);
          return;
        }
        const rowRetro = e.target.closest('[data-cmd-row-retro]');
        if (rowRetro) {
          await openRetro(rowRetro.dataset.cmdRowRetro);
          return;
        }
        const rowDelete = e.target.closest('[data-cmd-row-delete]');
        if (rowDelete) {
          await deleteArchivedTask(rowDelete.dataset.cmdRowDelete);
          return;
        }
        if (e.target.closest('[data-cmd-resume]')) {
          taskAction('resume');
          return;
        }
        if (e.target.closest('[data-cmd-pause]')) {
          taskAction('pause');
          return;
        }
        if (e.target.closest('[data-cmd-task-back]')) {
          backToList();
          return;
        }
        if (e.target.closest('[data-cmd-stop]')) {
          taskAction('cancel');
          return;
        }
        if (e.target.closest('[data-cmd-advance]')) {
          taskAction('advance');
          return;
        }
        if (e.target.closest('[data-cmd-complete]')) {
          taskAction('complete');
          return;
        }
        if (e.target.closest('[data-cmd-approve]')) {
          taskAction('approve');
          return;
        }
        if (e.target.closest('[data-cmd-reject]')) {
          taskAction('reject');
          return;
        }
        if (e.target.closest('[data-cmd-task-cancel]')) {
          taskAction('cancel');
          return;
        }
        const batch = e.target.closest('[data-cmd-batch]');
        if (batch) {
          openTask(batch.dataset.cmdBatch);
          return;
        }

        /* ---------- Chat 面板 ---------- */
        const cwParticipant = e.target.closest('[data-cw-participant]');
        if (cwParticipant) {
          cwToggleMention(cwParticipant.dataset.cwParticipant);
          return;
        }
        const cwMention = e.target.closest('[data-cw-mention]');
        if (cwMention) {
          cwToggleMention(cwMention.dataset.cwMention);
          return;
        }
        if (e.target.closest('[data-cw-invite]')) {
          openParticipantsModal();
          return;
        }
        const cwAdopt = e.target.closest('[data-cw-adopt]');
        if (cwAdopt) {
          adoptGroupDecision(cwAdopt.dataset.cwAdopt);
          return;
        }
        const cwPlus = e.target.closest('[data-cw-plus]');
        if (cwPlus) {
          e.preventDefault();
          const menu = cwPlus.parentElement.querySelector('[data-cw-plus-menu]');
          if (menu) {
            const willOpen = menu.hidden;
            closeCwMenu();
            menu.hidden = !willOpen;
          }
          return;
        }
        const cwFile = e.target.closest('[data-cw-file]');
        if (cwFile) {
          closeCwMenu();
          cwPickFiles(cwFile.dataset.cwFile);
          return;
        }
        if (e.target.closest('[data-cw-group]')) {
          closeCwMenu();
          openGroupModal();
          return;
        }
        const cwAttDel = e.target.closest('[data-cw-att-del]');
        if (cwAttDel) {
          state.cwAttachments.splice(Number(cwAttDel.dataset.cwAttDel), 1);
          cwRefreshAttachments();
          return;
        }
        if (e.target.closest('[data-cw-new]') || e.target.closest('[data-cw-clear]')) {
          cwNewConversation();
          toast('已开启新对话', 'info');
          return;
        }
        if (e.target.closest('[data-cw-toggle-archive]')) {
          state.cwShowArchived = !state.cwShowArchived;
          paint();
          return;
        }
        const archiveSession = e.target.closest('[data-cw-archive-session]');
        if (archiveSession) {
          cwArchiveSession(
            archiveSession.dataset.cwArchiveSession,
            archiveSession.dataset.cwArchiveTo === '1'
          );
          return;
        }
        const deleteSession = e.target.closest('[data-cw-delete-session]');
        if (deleteSession) {
          cwDeleteSession(deleteSession.dataset.cwDeleteSession);
          return;
        }
        const cwSession = e.target.closest('[data-cw-session]');
        if (cwSession) {
          cwSwitchSession(cwSession.dataset.cwSession);
          return;
        }
        if (e.target.closest('[data-cw-export]')) {
          cwExportMarkdown();
          return;
        }
        const cwQuick = e.target.closest('[data-cmd-quick]');
        if (cwQuick) {
          const input = page.querySelector('[data-cw-input]');
          if (input) {
            input.value = cwQuick.dataset.cmdQuick || '';
            input.focus();
          }
          return;
        }
        if (e.target.closest('[data-cw-send]')) {
          const input = page.querySelector('[data-cw-input]');
          const text = input ? String(input.value || '').trim() : '';
          if (input) input.value = '';
          sendCwChat(text);
          return;
        }

        /* ---------- 工作流编排器 ---------- */
        const wfSelect = e.target.closest('[data-wf-select]');
        if (wfSelect) {
          selectWorkflow(wfSelect.dataset.wfSelect);
          return;
        }
        if (e.target.closest('[data-wf-insert]')) {
          openStageModal('insert', -1);
          return;
        }
        const wfStageDel = e.target.closest('[data-wf-stage-del]');
        if (wfStageDel && state.wfDraft) {
          const index = Number(wfStageDel.dataset.wfStageDel);
          const stage = (state.wfDraft.stages || [])[index];
          if (!stage) return;
          const ok = await ui.confirm({
            title: '删除工序节点？',
            desc: `将从当前配方草稿移除「${stage.name || stage.code}」，点「保存工作流」后写入 YAML；取消则不影响配方。`,
            ok: '删除节点',
            cancel: '取消',
            tone: 'danger',
          });
          if (!ok) return;
          state.wfDraft.stages.splice(index, 1);
          wfDirty(true);
          paint();
          return;
        }
        const wfEdit = e.target.closest('[data-wf-edit]');
        if (wfEdit) {
          openStageModal('edit', Number(wfEdit.dataset.wfEdit));
          return;
        }
        if (e.target.closest('[data-wf-preview]')) {
          openPreviewModal();
          return;
        }
        if (e.target.closest('[data-wf-save]')) {
          saveWorkflow();
          return;
        }
        if (e.target.closest('[data-wf-delete]')) {
          deleteWorkflow();
          return;
        }
        if (e.target.closest('[data-wf-yaml]')) {
          openYamlModal();
          return;
        }
        if (e.target.closest('[data-wf-new]')) {
          openNewWorkflowModal();
          return;
        }
        const advance = e.target.closest('[data-cmd-advance]');
        if (advance) {
          advanceTask(advance.dataset.cmdAdvance);
          return;
        }
        const cancel = e.target.closest('[data-cmd-cancel]');
        if (cancel) {
          const task = state.tasks.find((t) => t.id === cancel.dataset.cmdCancel);
          cancelTask(cancel.dataset.cmdCancel, task ? task.name : '该任务');
          return;
        }
        const memTab = e.target.closest('[data-cmd-mem-tab]');
        if (memTab) {
          state.memTab = memTab.dataset.cmdMemTab;
          paint();
          return;
        }
        if (e.target.closest('[data-cmd-mem-learn]')) {
          learnMemory();
          return;
        }
        if (e.target.closest('[data-cmd-mem-add]')) {
          openAddMemoryModal(false);
          return;
        }
        if (e.target.closest('[data-cmd-mem-add-shared]')) {
          openAddMemoryModal(true);
          return;
        }
        if (e.target.closest('[data-cmd-team-broadcast]')) {
          broadcastTeamMemory();
          return;
        }
        const teamEdit = e.target.closest('[data-cmd-team-edit]');
        if (teamEdit) {
          openTeamEditModal(teamEdit.dataset.cmdTeamEdit, false);
          return;
        }
        const teamScope = e.target.closest('[data-cmd-team-scope]');
        if (teamScope) {
          openTeamEditModal(teamScope.dataset.cmdTeamScope, true);
          return;
        }
        const teamUnshare = e.target.closest('[data-cmd-team-unshare]');
        if (teamUnshare) {
          unshareTeamRule(teamUnshare.dataset.cmdTeamUnshare);
          return;
        }

        /* ---------- Skill 技能 ---------- */
        if (e.target.closest('[data-skill-new]')) {
          newSkillDraft();
          return;
        }
        const skillSelect = e.target.closest('[data-skill-select]');
        if (skillSelect) {
          selectSkill(skillSelect.dataset.skillSelect);
          return;
        }
        const groupToggle = e.target.closest('[data-skill-group-toggle]');
        if (groupToggle) {
          const serverId = groupToggle.dataset.skillGroupToggle;
          const body = page.querySelector(`[data-skill-group-body="${serverId}"]`);
          if (body) {
            const willExpand = body.hidden;
            body.hidden = !willExpand;
            groupToggle.textContent = willExpand ? '▾' : '▸';
            groupToggle.title = willExpand ? '收起' : '展开';
            const expanded = new Set(state.skillExpandedServers || []);
            if (willExpand) expanded.add(serverId);
            else expanded.delete(serverId);
            state.skillExpandedServers = [...expanded];
          }
          return;
        }
        const skillTab = e.target.closest('[data-skill-tab]');
        if (skillTab) {
          switchSkillTab(skillTab.dataset.skillTab);
          return;
        }
        const skillTrigger = e.target.closest('[data-skill-trigger]');
        if (skillTrigger) {
          if (state.skillDraft) {
            const modes = new Set(skillTriggerModes(state.skillDraft.triggerMode));
            const target = skillTrigger.dataset.skillTrigger;
            if (modes.has(target)) {
              if (modes.size === 1) {
                toast('至少保留一种触发模式', 'warn');
                return;
              }
              modes.delete(target);
            } else {
              modes.add(target);
            }
            state.skillDraft.triggerMode = modes.size === 2 ? 'both' : [...modes][0];
          }
          const active = new Set(skillTriggerModes(state.skillDraft && state.skillDraft.triggerMode));
          page.querySelectorAll('[data-skill-trigger]').forEach((el) => {
            el.classList.toggle('is-on', active.has(el.dataset.skillTrigger));
          });
          return;
        }
        if (e.target.closest('[data-skill-save]')) {
          saveSkill();
          return;
        }
        if (e.target.closest('[data-skill-delete]')) {
          deleteSkill();
          return;
        }
        if (e.target.closest('[data-skill-toggle]')) {
          toggleSkill();
          return;
        }

        /* ---------- 轨迹日志 ---------- */
        const auditView = e.target.closest('[data-audit-view]');
        if (auditView) {
          openAuditDetail(auditView.dataset.auditView);
          return;
        }
        const auditRetry = e.target.closest('[data-audit-retry]');
        if (auditRetry) {
          retryAuditCall(auditRetry.dataset.auditRetry);
          return;
        }
        const auditApprove = e.target.closest('[data-audit-approve]');
        if (auditApprove) {
          openAuditApproval(auditApprove.dataset.auditApprove);
          return;
        }
        const auditWithdraw = e.target.closest('[data-audit-withdraw]');
        if (auditWithdraw) {
          withdrawAuditApproval(auditWithdraw.dataset.auditWithdraw);
          return;
        }
        if (e.target.closest('[data-audit-export]')) {
          exportAuditLogs();
          return;
        }

        if (e.target.closest('[data-cmd-mem-add-knowledge]')) {
          newKnowledgeDraft();
          return;
        }
        if (e.target.closest('[data-cmd-kn-import]')) {
          importKnowledgeFile();
          return;
        }
        const knSelect = e.target.closest('[data-cmd-kn-select]');
        if (knSelect) {
          selectKnowledgeDoc(knSelect.dataset.cmdKnSelect);
          return;
        }
        const knToggle = e.target.closest('[data-cmd-kn-toggle]');
        if (knToggle) {
          toggleKnowledgeEnabled(knToggle.dataset.cmdKnToggle);
          return;
        }
        if (e.target.closest('[data-cmd-kn-save]')) {
          saveKnowledgeDraft();
          return;
        }
        if (e.target.closest('[data-cmd-kn-cancel]')) {
          state.memKnowledgeDraft = null;
          paint();
          return;
        }
        const knDelete = e.target.closest('[data-cmd-kn-delete]');
        if (knDelete) {
          deleteKnowledgeDoc(knDelete.dataset.cmdKnDelete);
          return;
        }
        const knTagDel = e.target.closest('[data-cmd-kn-tag-del]');
        if (knTagDel) {
          const draft = state.memKnowledgeDraft;
          if (draft) {
            draft.tags.splice(Number(knTagDel.dataset.cmdKnTagDel), 1);
            refreshKnTagEditor(false);
          }
          return;
        }
        const memEdit = e.target.closest('[data-cmd-mem-edit]');
        if (memEdit) {
          openAddMemoryModal(false, memEdit.dataset.cmdMemEdit);
          return;
        }
        const memConfirm = e.target.closest('[data-cmd-mem-confirm]');
        if (memConfirm) {
          confirmMemoryModal(memConfirm.dataset.cmdMemConfirm);
          return;
        }
        const memReject = e.target.closest('[data-cmd-mem-reject]');
        if (memReject) {
          rejectMemory(memReject.dataset.cmdMemReject);
          return;
        }
        const memArchive = e.target.closest('[data-cmd-mem-archive]');
        if (memArchive) {
          archiveMemory(memArchive.dataset.cmdMemArchive);
          return;
        }
        const memDelete = e.target.closest('[data-cmd-mem-delete]');
        if (memDelete) {
          deleteMemory(memDelete.dataset.cmdMemDelete);
          return;
        }
        if (e.target.closest('[data-cmd-add-memory]')) {
          openAddMemoryModal();
          return;
        }
        const chip = e.target.closest('[data-cmd-chip]');
        if (chip) {
          const input = page.querySelector('[data-cmd-dock-input]');
          if (input) {
            input.value = chip.dataset.cmdChip || '';
            input.focus();
          }
          return;
        }
        if (e.target.closest('[data-cmd-dock-send]')) {
          const input = page.querySelector('[data-cmd-dock-input]');
          const text = input ? String(input.value || '').trim() : '';
          if (input) input.value = '';
          sendChat(text);
          return;
        }
      });

      page.addEventListener('input', (e) => {
        if (e.target.matches('[data-mcp-search]')) {
          state.mcpSearch = String(e.target.value || '');
          const list = page.querySelector('[data-mcp-server-list]');
          if (list) list.innerHTML = mcpServerItemsHtml();
          return;
        }
        if (e.target.matches('[data-cmd-mem-search]')) {
          state.memSearch = String(e.target.value || '');
          const card = page.querySelector('.cmd-mem-table-card');
          if (card) card.innerHTML = memTableHtml();
          return;
        }
        if (e.target.matches('[data-cmd-team-search]')) {
          state.memTeamSearch = String(e.target.value || '');
          const card = page.querySelector('.cmd-mem-table-card');
          if (card) card.innerHTML = memTeamHtml();
          return;
        }
        if (e.target.matches('[data-cmd-kn-search]')) {
          state.memKnowledgeSearch = String(e.target.value || '');
          const list = page.querySelector('.cmd-kn-list');
          if (list) list.innerHTML = memKnowledgeRowsHtml();
          return;
        }
        if (e.target.matches('[data-cmd-kn-content]')) {
          const count = page.querySelector('[data-cmd-kn-char-count]');
          if (count) count.textContent = String(e.target.value || '').length.toLocaleString();
          return;
        }
        if (e.target.matches('[data-skill-search]')) {
          state.skillSearch = String(e.target.value || '');
          const list = page.querySelector('.cmd-skill-list');
          if (list) list.innerHTML = skillFiltered().map(skillCardHtml).join('');
          return;
        }
        if (e.target.matches('[data-skill-temp]')) {
          const out = page.querySelector('[data-skill-temp-val]');
          if (out) out.textContent = Number(e.target.value).toFixed(1);
          return;
        }
        if (e.target.matches('[data-skill-yaml]')) {
          state.skillYaml = String(e.target.value || '');
          const pre = page.querySelector('[data-skill-highlight]');
          if (pre) {
            pre.innerHTML = skillYamlHighlight(state.skillYaml);
            pre.scrollTop = e.target.scrollTop;
            pre.scrollLeft = e.target.scrollLeft;
          }
          return;
        }
        if (e.target.matches('[data-audit-search]')) {
          state.auditKeyword = String(e.target.value || '');
          if (state.auditSearchTimer) clearTimeout(state.auditSearchTimer);
          state.auditSearchTimer = setTimeout(async () => {
            await loadAuditLogs();
            paint();
          }, 300);
          return;
        }
      });

      page.addEventListener('change', async (e) => {
        if (e.target.matches('[data-mcp-tool]')) {
          const row = e.target.closest('[data-mcp-tool-row]');
          mcpToggleTool(e.target.dataset.mcpTool, e.target.checked);
          if (row) {
            row.classList.toggle('is-on', e.target.checked);
            const badge = row.querySelector('[data-mcp-expose]');
            if (badge) badge.hidden = !e.target.checked;
          }
          return;
        }
        if (e.target.matches('[data-mcp-server-select]')) {
          await mcpSelectServer(e.target.value);
          return;
        }
        if (e.target.matches('[data-cmd-mem-tag]')) {
          state.memTag = e.target.value;
          paint();
          return;
        }
        if (e.target.matches('[data-cmd-mem-status]')) {
          state.memStatus = e.target.value;
          paint();
          return;
        }
        if (e.target.matches('[data-cmd-team-scope]')) {
          state.memTeamScope = e.target.value;
          paint();
          return;
        }
        if (e.target.matches('[data-cmd-team-category]')) {
          state.memTeamCategory = e.target.value;
          paint();
          return;
        }
        if (e.target.matches('[data-cmd-kn-tag-filter]')) {
          state.memKnowledgeTag = e.target.value;
          const list = page.querySelector('.cmd-kn-list');
          if (list) list.innerHTML = memKnowledgeRowsHtml();
          return;
        }
        if (e.target.matches('[data-cmd-kn-status]')) {
          state.memKnowledgeStatus = e.target.value;
          const list = page.querySelector('.cmd-kn-list');
          if (list) list.innerHTML = memKnowledgeRowsHtml();
          return;
        }
        if (e.target.matches('[data-skill-enabled]')) {
          if (state.skillDraft) state.skillDraft.enabled = !!e.target.checked;
          return;
        }
        if (e.target.matches('[data-skill-group-all]')) {
          const serverId = e.target.dataset.skillGroupAll;
          const body = page.querySelector(`[data-skill-group-body="${serverId}"]`);
          if (body && state.skillDraft) {
            const boxes = [...body.querySelectorAll('[data-skill-tool]')];
            const tools = new Set(state.skillDraft.allowedTools || []);
            boxes.forEach((box) => {
              box.checked = e.target.checked;
              if (e.target.checked) tools.add(box.dataset.skillTool);
              else tools.delete(box.dataset.skillTool);
            });
            state.skillDraft.allowedTools = [...tools];
            syncSkillToolGroup(serverId);
            const count = page.querySelector('[data-skill-tool-count]');
            if (count) count.textContent = String(state.skillDraft.allowedTools.length);
          }
          return;
        }
        if (e.target.matches('[data-skill-tool]')) {
          if (state.skillDraft) {
            const canonical = e.target.dataset.skillTool;
            const tools = new Set(state.skillDraft.allowedTools || []);
            if (e.target.checked) tools.add(canonical);
            else tools.delete(canonical);
            state.skillDraft.allowedTools = [...tools];
            const count = page.querySelector('[data-skill-tool-count]');
            if (count) count.textContent = String(state.skillDraft.allowedTools.length);
            const group = e.target.closest('.cmd-skill-tool-group');
            const master = group && group.querySelector('[data-skill-group-all]');
            if (master) syncSkillToolGroup(master.dataset.skillGroupAll);
          }
          return;
        }
        if (e.target.matches('[data-audit-since]')) {
          state.auditSince = e.target.value;
          await loadAuditLogs();
          paint();
          return;
        }
        if (e.target.matches('[data-audit-pipeline]')) {
          state.auditPipeline = e.target.value;
          await loadAuditLogs();
          paint();
          return;
        }
        if (e.target.matches('[data-audit-severity]')) {
          state.auditSeverity = e.target.value;
          await loadAuditLogs();
          paint();
          return;
        }
        if (e.target.matches('[data-audit-agent]')) {
          state.auditAgent = e.target.value;
          await loadAuditLogs();
          paint();
          return;
        }
        if (e.target.matches('[data-cmd-mem-category]')) {
          state.memSimCategory = e.target.value;
          state.memPreviewLoading = true;
          paint();
          await loadMemoryPreview();
          state.memPreviewLoading = false;
          paint();
          return;
        }
        if (e.target.matches('[data-cmd-mem-channel]')) {
          state.memSimChannel = e.target.value;
          state.memPreviewLoading = true;
          paint();
          await loadMemoryPreview();
          state.memPreviewLoading = false;
          paint();
          return;
        }
        if (e.target.matches('[data-cmd-mem-l1]')) {
          toggleMemoryL1(e.target.checked);
        }
      });

      page.addEventListener('scroll', (e) => {
        if (!e.target.matches('[data-skill-yaml]')) return;
        const pre = page.querySelector('[data-skill-highlight]');
        if (pre) {
          pre.scrollTop = e.target.scrollTop;
          pre.scrollLeft = e.target.scrollLeft;
        }
      }, true);

      page.addEventListener('dblclick', (e) => {
        const row = e.target.closest('[data-cmd-task]');
        if (!row) return;
        openTask(row.dataset.cmdTask);
      });

      page.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        const knTagInput = e.target.closest('[data-cmd-kn-tag-input]');
        if (knTagInput) {
          e.preventDefault();
          addKnTag(knTagInput.value);
          return;
        }
        const dockInput = e.target.closest('[data-cmd-dock-input]');
        if (dockInput) {
          e.preventDefault();
          const text = String(dockInput.value || '').trim();
          dockInput.value = '';
          sendChat(text);
          return;
        }
        const chatInput = e.target.closest('[data-cw-input]');
        if (chatInput) {
          e.preventDefault();
          const text = String(chatInput.value || '').trim();
          chatInput.value = '';
          sendCwChat(text);
        }
      });

      // 拖拽排序（HTML5 DnD）
      let dragIndex = -1;
      page.addEventListener('dragstart', (e) => {
        const card = e.target.closest('[data-wf-stage]');
        if (!card) return;
        dragIndex = Number(card.dataset.wfStage);
        card.classList.add('is-dragging');
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragIndex)); } catch (_) { /* 忽略 */ }
      });
      page.addEventListener('dragend', () => {
        dragIndex = -1;
        page.querySelectorAll('.wf-stage').forEach((c) => c.classList.remove('is-dragging', 'is-over'));
      });
      page.addEventListener('dragover', (e) => {
        const card = e.target.closest('[data-wf-stage]');
        if (!card || dragIndex < 0) return;
        e.preventDefault();
        page.querySelectorAll('.wf-stage').forEach((c) => c.classList.toggle('is-over', c === card && Number(c.dataset.wfStage) !== dragIndex));
      });
      page.addEventListener('drop', (e) => {
        const card = e.target.closest('[data-wf-stage]');
        if (!card || dragIndex < 0 || !state.wfDraft) return;
        e.preventDefault();
        const to = Number(card.dataset.wfStage);
        const stages = state.wfDraft.stages;
        if (to === dragIndex || to < 0 || to >= stages.length) return;
        const [moved] = stages.splice(dragIndex, 1);
        stages.splice(to, 0, moved);
        dragIndex = -1;
        wfDirty(true);
        paint();
      });

      loadAll().then(async () => {
        paint();
        const top = page.querySelector('.cmd-top');
        if (top) top.outerHTML = topHtml();
        paint();
      });
    },
  };
})();
