'use strict';

/**
 * 商品工作流抽屉（商品管理 → 行点击）。
 *
 * 数据全部来自后端：
 *   GET  /api/business/products/{projectNo}/pipeline
 *   POST .../pipeline/advance   自动推进（执行器未接线会置 blocked）
 *   POST .../pipeline/approve   { approved, note } 人工闸口
 *   POST .../pipeline/complete  { note } 人工完成当前自动工序
 *
 * 面板自适应：后端配方里的 stage.panel 决定展示哪种面板
 * （qualification = 审核口径；media_compare = 原图/精修对比），前端只做注册表映射，
 * 不按选品来源分支。
 */
(function () {
  const WB = window.WB;
  const ui = WB.ui;

  const STATUS_META = {
    pending: { label: '待执行', tone: 'slate', dot: 'offline' },
    running: { label: '执行中', tone: 'cyan', dot: 'busy' },
    waiting_human: { label: '待人工审核', tone: 'amber', dot: 'amber' },
    completed: { label: '已完成', tone: 'green', dot: 'online' },
    failed: { label: '失败', tone: 'rose', dot: 'amber' },
    blocked: { label: '待接线 / 可人工完成', tone: 'slate', dot: 'offline' },
  };

  const TYPE_LABEL = { auto: '自动节点', hitl_gate: '人机闸口' };

  function esc(v) {
    return ui.esc(v === undefined || v === null ? '' : String(v));
  }

  function meta(status) {
    return STATUS_META[String(status || '').toLowerCase()] || { label: status || '未知', tone: 'slate', dot: 'offline' };
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

  function pipelinePath(projectNo) {
    return '/api/business/products/' + encodeURIComponent(projectNo) + '/pipeline';
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function timelineHtml(state) {
    const stages = state.stages || [];
    if (!stages.length) {
      return `<div class="mcp-sec__empty">该商品未匹配到工作流配方</div>`;
    }
    return stages
      .map((stage, i) => {
        const m = meta(stage.status);
        const current = stage.code === state.currentStage;
        return `<div class="pl-step${current ? ' is-current' : ''}">
          <span class="pl-step__no">${i + 1}</span>
          <span class="pl-step__main">
            <span class="pl-step__name">${esc(stage.name || stage.code)}</span>
            <span class="pl-step__meta mono">${esc(stage.code)}${
              stage.type === 'hitl_gate' ? ' · 人机闸口' : ''
            }${stage.agent ? ' · ' + esc(stage.agent) : ''}${stage.skill ? ' · ' + esc(stage.skill) : ''}</span>
          </span>
          <span class="pl-step__state">${ui.badge(m.label, { tone: m.tone, dot: true })}</span>
        </div>`;
      })
      .join('');
  }

  /** 面板注册表：按 stage.panel 渲染，未知 panel 走通用卡片。 */
  function panelHtml(state) {
    const panel = String(state.stagePanel || '');
    const rule = (state.stages || []).find((s) => s.code === state.currentStage);

    if (panel === 'qualification') {
      return `<div class="pl-panel">
        <div class="pl-panel__title">${ui.icon('shield', 14)} 资格 / 准入审核口径</div>
        <div class="pl-rule mono">${esc(rule && rule.autoRule ? rule.autoRule : '（配方未声明 auto_rule）')}</div>
        <div class="tiny dim">规则表达式仅作审核口径展示；通过 / 驳回由人工判断，引擎不自动放行闸口。</div>
      </div>`;
    }

    if (panel === 'media_compare') {
      return `<div class="pl-panel">
        <div class="pl-panel__title">${ui.icon('image', 14)} 原图 / 精修对比</div>
        <div class="pl-compare">
          <div class="pl-compare__box"><span class="tiny dim">原图（选品抓取）</span><div class="pl-compare__ph">${ui.icon('image', 22)}</div></div>
          <div class="pl-compare__box"><span class="tiny dim">精修 / 视频（创意产物）</span><div class="pl-compare__ph">${ui.icon('sparkles', 22)}</div></div>
        </div>
        <div class="tiny dim">素材接入后在此展示真实对比；当前阶段由 creative 执行器产出写入。</div>
      </div>`;
    }

    return '';
  }

  function actionsHtml(state) {
    if (state.error) return '';
    if (state.completed) {
      return `<div class="pl-note-ok">${ui.icon('check', 14)} 流水线已完成</div>`;
    }

    const buttons = [];
    if (state.canApprove) {
      buttons.push(ui.btn({ label: '通过审核', tone: 'primary', icon: 'check', attrs: 'data-pl-approve' }));
      buttons.push(ui.btn({ label: '驳回', tone: 'danger', icon: 'x', attrs: 'data-pl-reject' }));
    } else {
      buttons.push(ui.btn({ label: '推进下一站', tone: 'primary', icon: 'play', attrs: 'data-pl-advance' }));
      if (state.canCompleteManually) {
        buttons.push(ui.btn({ label: '手动完成本阶段', tone: 'ghost', icon: 'check', attrs: 'data-pl-complete' }));
      }
    }
    return `<div class="pl-actions">${buttons.join('')}</div>`;
  }

  function drawerHtml(state) {
    const m = meta(state.stageStatus);
    const progress = state.stageTotal > 0 ? `${state.stageIndex}/${state.stageTotal}` : '—';
    const stage = (state.stages || []).find((s) => s.code === state.currentStage);
    const isGate = stage && stage.type === 'hitl_gate';

    return `<div class="pl-drawer__head">
        <div class="pl-drawer__heading">
          <div class="pl-drawer__title">${esc(state.projectNo)} · 工作流</div>
          <div class="pl-drawer__slug">${esc(state.pipelineName || state.pipelineId || '未匹配配方')}${
            state.triggerSource ? ' · 来源 ' + esc(state.triggerSource) : ''
          }</div>
        </div>
        ${ui.iconBtn('close', { title: '关闭（Esc）', attrs: 'data-pl-close' })}
      </div>
      <div class="pl-drawer__body">
        <div class="pl-summary">
          <span class="pl-summary__stage">${ui.badge(`${progress} ${state.currentStageName || '—'}`, { tone: m.tone, dot: true })}</span>
          <span class="tiny dim">${esc(m.label)}${isGate ? ' · 人机闸口' : stage ? ' · ' + TYPE_LABEL[stage.type] || '' : ''}</span>
        </div>
        ${state.error ? `<div class="mcp-alert">${esc(state.error)}</div>` : ''}
        ${state.stageNote ? `<div class="pl-note">${esc(state.stageNote)}</div>` : ''}
        <div class="pl-section">
          <div class="pl-section__title">工序时间线</div>
          <div class="pl-steps">${timelineHtml(state)}</div>
        </div>
        ${panelHtml(state)}
        <div class="pl-section">
          <div class="pl-section__title">审核 / 完成备注（可选）</div>
          <textarea class="input pl-note-input" rows="2" placeholder="填写审核意见或线下完成说明" data-pl-note></textarea>
        </div>
        ${actionsHtml(state)}
        <div class="tiny dim pl-hint">推进只按配方里的 next 指针走；执行器未接线的自动工序会停在“待接线”，可人工完成后继续。</div>
      </div>`;
  }

  /* ------------------------------ 抽屉生命周期 ------------------------------ */

  let backdrop = null;
  let drawer = null;
  let currentProject = null;
  let busy = false;

  function close() {
    if (drawer) drawer.remove();
    if (backdrop) backdrop.remove();
    drawer = null;
    backdrop = null;
    currentProject = null;
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape' && drawer) close();
  }

  function ensureShell() {
    if (drawer) return;
    backdrop = document.createElement('div');
    backdrop.className = 'pl-backdrop';
    backdrop.addEventListener('click', close);
    drawer = document.createElement('aside');
    drawer.className = 'pl-drawer';
    drawer.tabIndex = -1;
    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);
    document.addEventListener('keydown', onKey);
  }

  function render(state) {
    if (!drawer) return;
    drawer.innerHTML = drawerHtml(state);
    try {
      drawer.focus({ preventScroll: true });
    } catch (_) {
      /* 焦点失败不影响展示 */
    }
  }

  async function load(projectNo) {
    const res = await request('GET', pipelinePath(projectNo));
    if (!res.ok || !res.data) {
      throw new Error(res.error || '流程状态读取失败');
    }
    return res.data;
  }

  async function act(projectNo, path, body, okMessage) {
    if (busy) return;
    busy = true;
    const res = await request('POST', path, body);
    busy = false;
    if (!res.ok) {
      toast(res.error || '操作失败', 'warn');
      return null;
    }
    toast(okMessage, 'success');
    return res.data;
  }

  async function open(projectNo) {
    ensureShell();
    currentProject = projectNo;
    render({ projectNo: projectNo, stages: [], stageTotal: 0, stageIndex: 0, currentStage: '', currentStageName: '', stageStatus: 'pending' });
    try {
      const state = await load(projectNo);
      currentProject = state.projectNo || projectNo;
      render(state);
    } catch (error) {
      toast(error.message || '流程状态读取失败', 'warn');
      if (drawer) {
        drawer.innerHTML = `<div class="pl-drawer__head"><div class="pl-drawer__heading">
            <div class="pl-drawer__title">${esc(projectNo)} · 工作流</div>
            <div class="pl-drawer__slug">读取失败</div></div>
          ${ui.iconBtn('close', { title: '关闭', attrs: 'data-pl-close' })}</div>
          <div class="pl-drawer__body"><div class="mcp-alert">${esc(error.message || '流程状态读取失败')}</div></div>`;
      }
    }
  }

  function noteValue() {
    const el = drawer && drawer.querySelector('[data-pl-note]');
    return el ? String(el.value || '').trim() : '';
  }

  function bind() {
    document.addEventListener('click', async (e) => {
      if (!drawer) return;
      if (e.target.closest('[data-pl-close]')) {
        close();
        return;
      }
      const project = currentProject;
      if (!project) return;

      if (e.target.closest('[data-pl-advance]')) {
        const state = await act(project, pipelinePath(project) + '/advance', {}, '已推进');
        if (state) render(state);
        return;
      }
      if (e.target.closest('[data-pl-approve]')) {
        const state = await act(project, pipelinePath(project) + '/approve', { approved: true, note: noteValue() }, '审核已通过');
        if (state) render(state);
        return;
      }
      if (e.target.closest('[data-pl-reject]')) {
        const state = await act(project, pipelinePath(project) + '/approve', { approved: false, note: noteValue() }, '已驳回');
        if (state) render(state);
        return;
      }
      if (e.target.closest('[data-pl-complete]')) {
        const state = await act(project, pipelinePath(project) + '/complete', { note: noteValue() }, '本阶段已标记完成');
        if (state) render(state);
      }
    });
  }

  bind();

  WB.pipelineDrawer = { open, close };
})();
