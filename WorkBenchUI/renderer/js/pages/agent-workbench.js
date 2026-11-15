'use strict';

/**
 * Agent 工作台（右滑浮层）
 *
 * 四个分区，全部接真实接口：
 *   对话   POST /api/agents/{key}/chat + GET /conversations/{id}（按 Agent 独立、可跨重启恢复）
 *   记忆   GET/POST/DELETE /api/agents/{key}/memory、/knowledge（长期记忆与知识库）
 *   上下文 GET/PUT /api/agents/{key}/context（字符上限、L1 提取开关、最近注入快照）
 *   配置   GET /api/agents/{key}（完整 systemPrompt 与授权工具）
 *
 * 每个 Agent 的会话 ID 按 key 存在 localStorage：换 Agent 就是另一条对话，互不污染。
 */
(function () {
  const WB = window.WB;
  const ui = WB.ui;

  const TABS = [
    { id: 'chat', label: '对话' },
    { id: 'memory', label: '记忆' },
    { id: 'context', label: '上下文' },
    { id: 'skills', label: '技能' },
    { id: 'config', label: '配置' },
  ];

  const state = {
    agent: null,
    tab: 'chat',
    drawer: null,
    backdrop: null,
    messages: [],
    bundle: null,
    profile: null,
    busy: false,
    loading: false,
    error: null,
    llm: null,
    llmLoading: false,
    skills: [],
    skillTools: [],
    skillsLoaded: false,
    skillsLoading: false,
  };

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

  const agentPath = (suffix) => '/api/agents/' + encodeURIComponent(state.agent.id) + suffix;

  /** 每个 Agent 固定一条会话（localStorage 持有，后端持久化消息）。 */
  function conversationId() {
    const key = 'wizstar.agent.conv.' + state.agent.id;
    let id = '';
    try {
      id = window.localStorage.getItem(key) || '';
    } catch (_) {
      /* file:// 下不可用时退化为进程内会话 */
    }
    if (!id) {
      id = 'ui-' + state.agent.id + '-' + Date.now().toString(36);
      try {
        window.localStorage.setItem(key, id);
      } catch (_) {
        /* 忽略 */
      }
    }
    return id;
  }

  /* ------------------------------ 抽屉骨架 ------------------------------ */

  function ensureShell() {
    if (state.drawer) return;
    state.backdrop = document.createElement('div');
    state.backdrop.className = 'aw-backdrop';
    state.backdrop.addEventListener('click', close);
    state.drawer = document.createElement('aside');
    state.drawer.className = 'aw-drawer';
    state.drawer.tabIndex = -1;
    document.body.appendChild(state.backdrop);
    document.body.appendChild(state.drawer);
    document.addEventListener('keydown', onKeydown);
    state.drawer.addEventListener('click', onClick);
    state.drawer.addEventListener('keydown', onKeydownInDrawer);
  }

  function onKeydown(e) {
    if (e.key === 'Escape' && state.drawer) close();
  }

  function onKeydownInDrawer(e) {
    if (e.key === 'Enter' && !e.shiftKey && e.target.closest('[data-aw-chat-input]')) {
      e.preventDefault();
      sendChat();
    }
  }

  function close() {
    if (state.drawer) state.drawer.remove();
    if (state.backdrop) state.backdrop.remove();
    document.removeEventListener('keydown', onKeydown);
    state.drawer = null;
    state.backdrop = null;
    state.agent = null;
    state.messages = [];
    state.bundle = null;
    state.profile = null;
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function tabsHtml() {
    return `<div class="aw-tabs">${TABS.map(
      (t) => `<button type="button" class="aw-tab${t.id === state.tab ? ' is-on' : ''}" data-aw-tab="${t.id}">${t.label}</button>`
    ).join('')}</div>`;
  }

  /* ------------------------------ 模型选择 ------------------------------ */

  function llmSnapshot() {
    return state.llm || (WB.data && WB.data.llm) || {};
  }

  function boundModel() {
    const snapshot = llmSnapshot();
    const bindings = Array.isArray(snapshot.bindings) ? snapshot.bindings : [];
    const hit = bindings.find((b) => b.agentId === state.agent.id);
    return (hit && hit.model) || snapshot.defaultModel || '';
  }

  function enabledModels() {
    const snapshot = llmSnapshot();
    const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
    const on = new Set(providers.filter((p) => p.enabled).map((p) => p.code));
    return (Array.isArray(snapshot.models) ? snapshot.models : []).filter(
      (m) => m.enabled && (providers.length === 0 || on.has(m.providerCode))
    );
  }

  function modelPickerHtml() {
    const current = boundModel();
    const models = enabledModels();
    return `<div class="aw-model" data-aw-model>
      <button type="button" class="aw-model-btn" data-aw-model-toggle title="选择当前 Agent 使用的模型">
        ${ui.icon('cpu', 13)}<span>模型选择</span>
        <b class="aw-model-name">${esc(state.llmLoading && !current ? '读取中…' : current || '未配置')}</b>
        ${ui.icon('chevron-down', 12)}
      </button>
      <div class="aw-model-menu" data-aw-model-menu hidden>
        <div class="aw-model-menu-head">切换「${esc(state.agent.name)}」当前模型</div>
        ${
          models.length
            ? models
                .map(
                  (m) => `<button type="button" class="aw-model-item${m.modelId === current ? ' is-on' : ''}"
                    data-aw-pick-model="${esc(m.modelId)}">
                    <span class="aw-model-item-main">
                      <b>${esc(m.name || m.modelId)}</b>
                      <em class="mono">${esc(m.modelId)}</em>
                    </span>
                    <span class="aw-model-item-provider">${esc(m.providerCode)}</span>
                    ${m.modelId === current ? ui.icon('check', 13) : ''}
                  </button>`
                )
                .join('')
            : `<div class="aw-model-empty">系统还没有已接入的可用模型。</div>`
        }
      </div>
    </div>`;
  }

  async function loadLlm() {
    state.llmLoading = true;
    paint();
    const res = await request('GET', '/api/llm/settings');
    state.llmLoading = false;
    if (res.ok && res.data) state.llm = res.data;
    paint();
  }

  function closeModelMenu() {
    const menu = state.drawer && state.drawer.querySelector('[data-aw-model-menu]');
    if (menu) menu.hidden = true;
  }

  async function selectModel(modelId) {
    closeModelMenu();
    if (!modelId || !state.agent || modelId === boundModel()) return;
    const key = state.agent.id;
    const res = await request('PUT', '/api/llm/bindings', { bindings: { [key]: modelId } });
    if (!res.ok || !res.data) {
      toast('模型切换失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    state.llm = res.data;
    paint();
    toast('已切换模型：' + modelId, 'success');
  }

  function headHtml() {
    const a = state.agent;
    return `<div class="aw-head">
      <span class="aw-avatar">${ui.avatar(a, 'lg')}</span>
      <div class="aw-head-main">
        <div class="aw-title">${esc(a.name)} <span class="aw-en">${esc(a.en)}</span></div>
        <div class="aw-sub">${esc(a.desc)}</div>
      </div>
      <span class="aw-head-status">${ui.badge(a.status, { tone: a.tone, dot: true })}</span>
      ${modelPickerHtml()}
      ${ui.iconBtn('close', { title: '关闭（Esc）', attrs: 'data-aw-close' })}
    </div>${tabsHtml()}`;
  }

  function chatLogHtml() {
    if (!state.messages.length) {
      const quick = (state.agent.quickPrompts || [])
        .map((q) => `<button type="button" class="aw-quick" data-aw-quick="${esc(q)}">${esc(q)}</button>`)
        .join('');
      return `<div class="aw-chat-empty">
        <div class="aw-chat-hint">向「${esc(state.agent.name)}」发送一条消息开始会话。</div>
        ${quick ? `<div class="aw-quick-list">${quick}</div>` : ''}
      </div>`;
    }

    return state.messages
      .map((m) => {
        if (m.role === 'user') {
          return `<div class="aw-msg aw-msg--user"><div class="aw-bubble">${esc(m.text)}</div></div>`;
        }
        const meta = (m.meta || []).filter(Boolean).join(' · ');
        return `<div class="aw-msg aw-msg--agent"><div class="aw-bubble">${esc(m.text)}</div>${
          meta ? `<div class="aw-msg-meta">${esc(meta)}</div>` : ''
        }</div>`;
      })
      .join('');
  }

  function chatHtml() {
    const offline = String((WB.data.chatMode || '')).toLowerCase() === 'offline';
    const quick = (state.agent.quickPrompts || [])
      .map((q) => `<button type="button" class="aw-quick" data-aw-quick="${esc(q)}">${esc(q)}</button>`)
      .join('');
    return `<div class="aw-panel aw-panel--chat">
      ${offline ? `<div class="aw-alert">模型通道当前为 offline：对话会如实返回未接通原因，不会伪造回答。</div>` : ''}
      <div class="aw-chat-log" data-aw-chat-log>${chatLogHtml()}</div>
      ${state.messages.length && quick ? `<div class="aw-quick-list">${quick}</div>` : ''}
      <div class="aw-chat-input">
        ${ui.input({ placeholder: '输入消息，回车发送', attrs: 'data-aw-chat-input autocomplete="off"' })}
        ${ui.btn({ label: '发送', icon: 'zap', tone: 'primary', size: 'sm', attrs: 'data-aw-send' })}
      </div>
      <div class="aw-hint">会话按 Agent 独立保存：切到别的 Agent 是另一条对话，页面刷新后可恢复。</div>
    </div>`;
  }

  function memoryRows() {
    const memories = (state.bundle && state.bundle.memories) || [];
    if (!memories.length) return `<div class="aw-empty">还没有长期记忆。可手动录入关键事实（报价、供应商偏好、类目规则等）。</div>`;
    return memories
      .map(
        (m) => `<div class="aw-row">
          <div class="aw-row-main">
            <div class="aw-row-title">${esc(m.subject)}${m.metric ? `<span class="aw-row-metric">${esc(m.metric)}</span>` : ''}</div>
            <div class="aw-row-text">${esc(m.valueText)}</div>
            <div class="aw-row-meta">置信度 ${Number(m.confidence || 0).toFixed(2)} · ${esc(m.status)} · ${esc(
          (m.updatedAt || '').slice(0, 10)
        )}${m.verifiedBy ? ' · 录入 ' + esc(m.verifiedBy) : ''}</div>
          </div>
          <button type="button" class="aw-icon-del" data-aw-del-memory="${m.id}" title="删除记忆">${ui.icon('trash', 13)}</button>
        </div>`
      )
      .join('');
  }

  function knowledgeRows() {
    const docs = (state.bundle && state.bundle.knowledge) || [];
    if (!docs.length) return `<div class="aw-empty">知识库为空。可录入类目规则、平台政策、话术模板等长文本。</div>`;
    return docs
      .map(
        (k) => `<div class="aw-row">
          <div class="aw-row-main">
            <div class="aw-row-title">${esc(k.title)}${k.tags ? `<span class="aw-row-metric">${esc(k.tags)}</span>` : ''}</div>
            <div class="aw-row-text">${esc(String(k.content || '').slice(0, 160))}${String(k.content || '').length > 160 ? '…' : ''}</div>
            <div class="aw-row-meta">${esc((k.updatedAt || '').slice(0, 10))}</div>
          </div>
          <button type="button" class="aw-icon-del" data-aw-del-knowledge="${k.id}" title="删除知识">${ui.icon('trash', 13)}</button>
        </div>`
      )
      .join('');
  }

  function memoryHtml() {
    if (state.loading) return `<div class="aw-empty"><span class="spinner"></span> 正在读取记忆…</div>`;
    if (state.error) return `<div class="aw-alert">${esc(state.error)}</div>`;
    return `<div class="aw-panel">
      <div class="aw-section">
        <div class="aw-section-head"><span class="aw-section-title">长期记忆</span><span class="aw-count">${(state.bundle?.memories || []).length}</span></div>
        <div class="aw-rows">${memoryRows()}</div>
        <div class="aw-form">
          <div class="aw-form-row">
            ${ui.input({ placeholder: '主题，如：供应商A', attrs: 'data-aw-mem-subject' })}
            ${ui.input({ placeholder: '指标（可空），如：报价', attrs: 'data-aw-mem-metric' })}
          </div>
          ${ui.input({ placeholder: '内容，如：¥12.5 含税，起订 50 件', attrs: 'data-aw-mem-value' })}
          <div class="aw-form-actions">${ui.btn({ label: '添加记忆', icon: 'plus', tone: 'primary', size: 'sm', attrs: 'data-aw-add-memory' })}</div>
        </div>
      </div>

      <div class="aw-section">
        <div class="aw-section-head"><span class="aw-section-title">知识库</span><span class="aw-count">${(state.bundle?.knowledge || []).length}</span></div>
        <div class="aw-rows">${knowledgeRows()}</div>
        <div class="aw-form">
          ${ui.input({ placeholder: '标题，如：抖音违禁词清单', attrs: 'data-aw-kn-title' })}
          ${ui.input({ placeholder: '标签（可空），用逗号分隔', attrs: 'data-aw-kn-tags' })}
          <textarea class="input aw-textarea" rows="3" placeholder="内容…" data-aw-kn-content></textarea>
          <div class="aw-form-actions">${ui.btn({ label: '添加知识', icon: 'plus', tone: 'primary', size: 'sm', attrs: 'data-aw-add-knowledge' })}</div>
        </div>
      </div>
    </div>`;
  }

  function contextHtml() {
    if (state.loading) return `<div class="aw-empty"><span class="spinner"></span> 正在读取上下文配置…</div>`;
    if (state.error) return `<div class="aw-alert">${esc(state.error)}</div>`;
    const s = (state.bundle && state.bundle.settings) || {};
    const snap = state.bundle && state.bundle.lastSnapshot;
    return `<div class="aw-panel">
      <div class="aw-section">
        <div class="aw-section-title">注入上限</div>
        <div class="aw-hint">每次对话把长期记忆与知识库拼成一条 system 消息注入；超出上限按条目截断，并在提示里标注。</div>
        <label class="field"><span class="field-label">记忆字符上限</span>
          ${ui.input({ value: String(s.maxMemoryChars || 4000), attrs: 'data-aw-max-memory inputmode="numeric"' })}
        </label>
        <label class="field"><span class="field-label">知识库字符上限</span>
          ${ui.input({ value: String(s.maxKnowledgeChars || 4000), attrs: 'data-aw-max-knowledge inputmode="numeric"' })}
        </label>
        <label class="field"><span class="field-label">L1 自动提取（预留开关）</span>
          ${ui.switchControl({ checked: s.enableL1Extraction !== false, attrs: 'data-aw-l1' })}
        </label>
        <div class="aw-form-actions">${ui.btn({ label: '保存上下文配置', icon: 'check', tone: 'primary', size: 'sm', attrs: 'data-aw-save-context' })}</div>
      </div>
      <div class="aw-section">
        <div class="aw-section-title">最近一次注入</div>
        ${
          snap
            ? `<div class="aw-kv">
                <span>注入时间</span><b>${esc((snap.createdAt || '').replace('T', ' ').slice(0, 19))}</b>
                <span>总字符</span><b>${esc(String(snap.totalChars))}</b>
                <span>记忆 / 知识</span><b>${esc(String(snap.memoryCount))} / ${esc(String(snap.knowledgeCount))}</b>
                <span>是否截断</span><b>${snap.truncated ? '是' : '否'}</b>
              </div>`
            : `<div class="aw-empty">该 Agent 还没有运行记录。</div>`
        }
      </div>
    </div>`;
  }

  /* ------------------------------ Skill 技能（仅本 Agent） ------------------------------ */

  function awSkillTriggerText(mode) {
    const raw = String(mode || 'chat').toLowerCase();
    if (raw === 'both' || raw.indexOf('chat') !== -1 && raw.indexOf('auto') !== -1) return 'Chat + 自动管线';
    return raw === 'auto' ? '自动管线' : 'Chat 调用';
  }

  function skillsHtml() {
    if (state.skillsLoading && !state.skillsLoaded) {
      return `<div class="aw-panel"><div class="aw-empty"><span class="spinner"></span> 正在读取本 Agent 的 Skill…</div></div>`;
    }
    const rows = state.skills || [];
    return `<div class="aw-panel">
      <div class="aw-skill-head">
        <div>
          <div class="aw-section-title">Skill 技能</div>
          <div class="aw-hint">仅显示与维护绑定到「${esc(state.agent.name)}」的 SOP。</div>
        </div>
        ${ui.btn({ label: '新建技能', icon: 'plus', tone: 'primary', size: 'sm', attrs: 'data-aw-skill-new' })}
      </div>
      <div class="aw-skill-list">
        ${
          rows.length
            ? rows
                .map(
                  (skill) => `<div class="aw-skill-card">
                    <div class="aw-skill-card-main">
                      <div class="aw-skill-card-head">
                        <b>${esc(skill.name)}</b>
                        ${ui.badge(skill.enabled ? '已启用' : '已停用', {
                          tone: skill.enabled ? 'green' : 'slate',
                          dot: true,
                        })}
                      </div>
                      <div class="aw-skill-code mono">${esc(skill.code)}</div>
                      <div class="aw-skill-meta">${(skill.allowedTools || []).length} 个工具 · ${esc(
                        awSkillTriggerText(skill.triggerMode)
                      )}</div>
                    </div>
                    <div class="aw-skill-actions">
                      <button type="button" class="aw-skill-act" data-aw-skill-edit="${esc(skill.code)}">编辑</button>
                      <button type="button" class="aw-skill-act" data-aw-skill-toggle="${esc(skill.code)}">${
                        skill.enabled ? '停用' : '启用'
                      }</button>
                      <button type="button" class="aw-skill-act is-danger" data-aw-skill-delete="${esc(skill.code)}">删除</button>
                    </div>
                  </div>`
                )
                .join('')
            : `<div class="aw-empty">本 Agent 还没有 Skill。点右上角「新建技能」创建第一条 SOP。</div>`
        }
      </div>
    </div>`;
  }

  async function loadSkills() {
    state.skillsLoading = true;
    if (!state.skillsLoaded) paint();
    const [listRes, toolsRes] = await Promise.all([
      request('GET', '/api/skills?agent=' + encodeURIComponent(state.agent.id)),
      request('GET', '/api/skills/tools'),
    ]);
    if (listRes.ok && listRes.data) {
      state.skills = Array.isArray(listRes.data.skills) ? listRes.data.skills : [];
    }
    if (toolsRes.ok && Array.isArray(toolsRes.data)) {
      state.skillTools = toolsRes.data;
    }
    state.skillsLoaded = true;
    state.skillsLoading = false;
    paint();
  }

  function awSkillTreeHtml(selected, expanded) {
    const groups = new Map();
    (state.skillTools || []).forEach((tool) => {
      const key = tool.serverId || 'unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(tool);
    });
    const known = new Set((state.skillTools || []).map((t) => t.canonical));
    const missing = [...selected].filter((t) => !known.has(t));

    const renderGroup = (serverId, title, tools, isMissing) => {
      const closed = !expanded.has(serverId);
      const checked = tools.filter((t) => selected.has(t.canonical)).length;
      return `<div class="aw-skill-tool-group${isMissing ? ' is-missing' : ''}">
        <div class="aw-skill-tool-head">
          <button type="button" class="aw-skill-group-toggle" data-aw-skill-group-toggle="${esc(serverId)}">${
            closed ? '▸' : '▾'
          }</button>
          <span class="mono">${esc(title)}</span>
          <span class="aw-skill-group-count" data-aw-skill-group-count="${esc(serverId)}">${checked}/${tools.length}</span>
          <label class="aw-skill-group-all">
            <input type="checkbox" data-aw-skill-group-all="${esc(serverId)}" /> 全选
          </label>
        </div>
        <div class="aw-skill-tool-body" data-aw-skill-group-body="${esc(serverId)}"${closed ? ' hidden' : ''}>
          ${tools
            .map(
              (tool) => `<label class="aw-skill-tool">
                <input type="checkbox" data-aw-skill-tool="${esc(tool.canonical)}"${
                  selected.has(tool.canonical) ? ' checked' : ''
                } />
                <span><code>${esc(tool.canonical)}</code><em>${esc(tool.description || '')}</em></span>
              </label>`
            )
            .join('')}
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
          missing.map((canonical) => ({ canonical, description: '服务未连接或工具已下线' })),
          true
        )
      );
    }
    return parts.length ? parts.join('') : `<div class="aw-empty">暂无可用工具。</div>`;
  }

  function openSkillEditor(skill) {
    const isNew = !skill;
    const selected = new Set((skill && skill.allowedTools) || []);
    const expanded = new Set();
    const overlay = ui.modal({
      title: isNew ? '新建 Skill 技能' : '编辑 Skill 技能',
      desc: `执行 Agent 固定为「${state.agent.name}」；只有勾选的工具会暴露给模型。`,
      body: `<div class="aw-skill-form">
        <div class="aw-skill-grid2">
          <label class="field"><span class="field-label">技能名称</span>
            ${ui.input({ value: skill ? skill.name : '', placeholder: '如：寻源议价', attrs: 'data-aw-skill-name' })}
          </label>
          <label class="field"><span class="field-label">唯一标识 (code)</span>
            ${ui.input({
              value: skill ? skill.code : '',
              placeholder: 'price-negotiation-sop',
              attrs: 'data-aw-skill-code' + (isNew ? '' : ' disabled'),
            })}
          </label>
        </div>
        <label class="field"><span class="field-label">描述</span>
          ${ui.input({ value: skill ? skill.description || '' : '', placeholder: '一句话说明 SOP 用途', attrs: 'data-aw-skill-desc' })}
        </label>
        <div class="aw-skill-grid3">
          <label class="field"><span class="field-label">触发模式</span>
            ${ui.select({
              options: [
                { value: 'chat', label: 'Chat 调用' },
                { value: 'auto', label: '自动管线触发' },
                { value: 'both', label: 'Chat + 自动管线（两者都支持）' },
              ],
              value: skill ? skill.triggerMode : 'chat',
              attrs: 'data-aw-skill-trigger',
            })}
          </label>
          <label class="field"><span class="field-label">温度</span>
            ${ui.input({
              type: 'number',
              value: String(skill ? skill.temperature : 0.3),
              attrs: 'min="0" max="2" step="0.1" data-aw-skill-temp',
            })}
          </label>
          <label class="field"><span class="field-label">最大 Token</span>
            ${ui.input({
              type: 'number',
              value: String(skill ? skill.maxOutputTokens : 2048),
              attrs: 'min="128" max="32000" data-aw-skill-max',
            })}
          </label>
        </div>
        <label class="aw-skill-enabled-line">
          <input type="checkbox" data-aw-skill-enabled${!skill || skill.enabled ? ' checked' : ''} />
          <span>启用该 Skill</span>
          <em>重试策略</em>
          ${ui.input({
            type: 'number',
            value: String(skill ? skill.retry : 2),
            attrs: 'min="0" max="5" data-aw-skill-retry',
          })}
        </label>
        <div class="field"><span class="field-label">精准挂载 MCP 工具</span>
          <div class="aw-skill-tools" data-aw-skill-tools>${awSkillTreeHtml(selected, expanded)}</div>
        </div>
        <label class="field"><span class="field-label">SOP 核心作业指令 (Prompt)</span>
          <textarea class="input aw-skill-prompt" rows="7" data-aw-skill-prompt>${esc(
            skill ? skill.prompt : ''
          )}</textarea>
        </label>
      </div>`,
      actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}
        ${ui.btn({ label: '保存并热重载', tone: 'primary', attrs: 'data-aw-skill-save' })}`,
    });
    const modal = overlay.querySelector('.modal');
    if (modal) modal.style.width = 'min(920px, calc(100vw - 80px))';

    const treeHost = overlay.querySelector('[data-aw-skill-tools]');
    function syncGroup(serverId) {
      const body = treeHost.querySelector(`[data-aw-skill-group-body="${serverId}"]`);
      const master = treeHost.querySelector(`[data-aw-skill-group-all="${serverId}"]`);
      const count = treeHost.querySelector(`[data-aw-skill-group-count="${serverId}"]`);
      if (!body || !master) return;
      const boxes = [...body.querySelectorAll('[data-aw-skill-tool]')];
      const checked = boxes.filter((b) => b.checked).length;
      master.checked = boxes.length > 0 && checked === boxes.length;
      master.indeterminate = checked > 0 && checked < boxes.length;
      if (count) count.textContent = checked + '/' + boxes.length;
    }
    function wireGroups() {
      treeHost.querySelectorAll('[data-aw-skill-group-all]').forEach((el) => syncGroup(el.dataset.awSkillGroupAll));
    }
    wireGroups();

    overlay.addEventListener('click', async (e) => {
      const toggle = e.target.closest('[data-aw-skill-group-toggle]');
      if (toggle) {
        const serverId = toggle.dataset.awSkillGroupToggle;
        if (expanded.has(serverId)) expanded.delete(serverId);
        else expanded.add(serverId);
        treeHost.innerHTML = awSkillTreeHtml(selected, expanded);
        wireGroups();
        return;
      }
      if (!e.target.closest('[data-aw-skill-save]')) return;

      const q = (sel) => overlay.querySelector(sel);
      const code = String((q('[data-aw-skill-code]') || {}).value || '').trim();
      const name = String((q('[data-aw-skill-name]') || {}).value || '').trim();
      const prompt = String((q('[data-aw-skill-prompt]') || {}).value || '').trim();
      if (!code || !name || !prompt) {
        toast('请填写唯一标识、技能名称与 SOP 指令', 'warn');
        return;
      }
      const payload = {
        code,
        name,
        description: String((q('[data-aw-skill-desc]') || {}).value || '').trim() || null,
        agent: state.agent.id,
        enabled: !!(q('[data-aw-skill-enabled]') || {}).checked,
        triggerMode: (q('[data-aw-skill-trigger]') || {}).value || 'chat',
        allowedTools: [...selected],
        prompt,
        temperature: Number((q('[data-aw-skill-temp]') || {}).value || 0.3),
        maxOutputTokens: Number((q('[data-aw-skill-max]') || {}).value || 2048),
        retry: Number((q('[data-aw-skill-retry]') || {}).value || 2),
      };
      const res = isNew
        ? await request('POST', '/api/skills', payload)
        : await request('PUT', '/api/skills/' + encodeURIComponent(skill.code), payload);
      if (!res.ok) {
        toast('保存失败：' + (res.error || '服务未连接'), 'warn');
        return;
      }
      overlay.close();
      await loadSkills();
      toast('Skill 已保存并热重载', 'success');
    });

    overlay.addEventListener('change', (e) => {
      const groupAll = e.target.closest('[data-aw-skill-group-all]');
      if (groupAll) {
        const serverId = groupAll.dataset.awSkillGroupAll;
        const body = treeHost.querySelector(`[data-aw-skill-group-body="${serverId}"]`);
        if (body) {
          [...body.querySelectorAll('[data-aw-skill-tool]')].forEach((box) => {
            box.checked = groupAll.checked;
            if (groupAll.checked) selected.add(box.dataset.awSkillTool);
            else selected.delete(box.dataset.awSkillTool);
          });
          syncGroup(serverId);
        }
        return;
      }
      const tool = e.target.closest('[data-aw-skill-tool]');
      if (tool) {
        if (tool.checked) selected.add(tool.dataset.awSkillTool);
        else selected.delete(tool.dataset.awSkillTool);
        const group = tool.closest('.aw-skill-tool-group');
        const master = group && group.querySelector('[data-aw-skill-group-all]');
        if (master) syncGroup(master.dataset.awSkillGroupAll);
      }
    });
  }

  async function deleteSkill(code) {
    const skill = (state.skills || []).find((s) => s.code === code);
    const ok = await ui.confirm({
      title: '删除这个 Skill？',
      desc: `将删除 skills/${code}.yaml，不可恢复。`,
      ok: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await request('DELETE', '/api/skills/' + encodeURIComponent(code));
    if (!res.ok) {
      toast('删除失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast('Skill 已删除', 'success');
    await loadSkills();
  }

  async function toggleSkillEnabled(code) {
    const skill = (state.skills || []).find((s) => s.code === code);
    if (!skill) return;
    const res = await request('POST', '/api/skills/' + encodeURIComponent(code) + '/toggle', {
      enabled: !skill.enabled,
    });
    if (!res.ok) {
      toast('操作失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast(res.data.enabled ? 'Skill 已启用' : 'Skill 已停用', 'success');
    await loadSkills();
  }

  function configHtml() {
    if (state.loading) return `<div class="aw-empty"><span class="spinner"></span> 正在读取配置…</div>`;
    if (state.error) return `<div class="aw-alert">${esc(state.error)}</div>`;
    const p = state.profile || {};
    const tools = Array.isArray(p.allowedTools) ? p.allowedTools : [];
    return `<div class="aw-panel">
      <div class="aw-kv">
        <span>Key</span><b class="mono">${esc(p.key || state.agent.id)}</b>
        <span>最大步数</span><b>${esc(String(p.maxSteps || state.agent.today))} 步</b>
        <span>启用状态</span><b>${p.enabled === false ? '已停用' : '已启用'}</b>
        <span>授权工具</span><b>${tools.length ? esc(tools.join(' · ')) : '未授权'}</b>
      </div>
      <div class="aw-section">
        <div class="aw-section-title">System Prompt</div>
        <pre class="aw-prompt">${esc(p.systemPrompt || '（未配置）')}</pre>
      </div>
      <div class="aw-hint">人设由 <code>config/agents.yaml</code> 固化，界面只读；改配置后热加载生效。</div>
    </div>`;
  }

  function bodyHtml() {
    if (state.tab === 'chat') return chatHtml();
    if (state.tab === 'memory') return memoryHtml();
    if (state.tab === 'context') return contextHtml();
    if (state.tab === 'skills') return skillsHtml();
    return configHtml();
  }

  function paint() {
    if (!state.drawer || !state.agent) return;
    state.drawer.innerHTML = `${headHtml()}<div class="aw-body">${bodyHtml()}</div>`;
    scrollLog();
  }

  function scrollLog() {
    const log = state.drawer && state.drawer.querySelector('[data-aw-chat-log]');
    if (log) log.scrollTop = log.scrollHeight;
  }

  /* ------------------------------ 数据加载 ------------------------------ */

  async function loadHistory() {
    const id = conversationId();
    const res = await request('GET', agentPath('/conversations/' + encodeURIComponent(id)));
    if (!res.ok || !res.data) return;
    state.messages = (res.data.messages || []).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      text: m.text || '',
    }));
  }

  async function loadBundle() {
    state.loading = true;
    state.error = null;
    paint();
    const res = await request('GET', agentPath('/memory'));
    state.loading = false;
    if (!res.ok || !res.data) {
      state.error = '读取记忆失败：' + (res.error || '服务未连接');
    } else {
      state.bundle = res.data;
    }
    paint();
  }

  async function loadProfile() {
    state.loading = true;
    state.error = null;
    paint();
    const res = await request('GET', agentPath(''));
    state.loading = false;
    if (!res.ok || !res.data) {
      state.error = '读取配置失败：' + (res.error || '服务未连接');
    } else {
      state.profile = res.data;
    }
    paint();
  }

  /* ------------------------------ 动作 ------------------------------ */

  async function sendChat() {
    if (state.busy || !state.drawer) return;
    const input = state.drawer.querySelector('[data-aw-chat-input]');
    const text = input ? String(input.value || '').trim() : '';
    if (!text) return;

    state.busy = true;
    input.value = '';
    state.messages.push({ role: 'user', text: text });
    paint();

    const sendBtn = state.drawer.querySelector('[data-aw-send]');
    if (sendBtn) sendBtn.disabled = true;

    const res = await request('POST', agentPath('/chat'), {
      conversationId: conversationId(),
      message: text,
    });

    state.busy = false;
    if (state.drawer && sendBtn) sendBtn.disabled = false;

    if (!res.ok) {
      state.messages.push({ role: 'assistant', text: '调用失败：' + (res.error || '服务未连接'), meta: [] });
      paint();
      return;
    }

    const d = res.data || {};
    const meta = [
      d.mode ? '通道 ' + d.mode : '',
      d.model ? '模型 ' + d.model : '',
      d.assembledTools != null ? '装配工具 ' + d.assembledTools : '',
      d.contextChars ? '注入 ' + d.contextChars + ' 字' + (d.contextTruncated ? '（已截断）' : '') : '',
      d.elapsedMs != null ? d.elapsedMs + ' ms' : '',
    ];
    state.messages.push({ role: 'assistant', text: d.output || '（模型未返回文本）', meta: meta });

    if (String(d.mode || '') === 'offline' && d.message) {
      state.messages.push({ role: 'assistant', text: '模型通道 offline：' + d.message, meta: [] });
    }
    if (Array.isArray(d.pendingApprovalIds) && d.pendingApprovalIds.length) {
      state.messages.push({
        role: 'assistant',
        text: `已挂起 ${d.pendingApprovalIds.length} 个审批单，请到「工作台」处理后再继续。`,
        meta: [],
      });
    }
    paint();
  }

  async function addMemory() {
    if (!state.drawer) return;
    const subject = String((state.drawer.querySelector('[data-aw-mem-subject]') || {}).value || '').trim();
    const metric = String((state.drawer.querySelector('[data-aw-mem-metric]') || {}).value || '').trim();
    const valueText = String((state.drawer.querySelector('[data-aw-mem-value]') || {}).value || '').trim();
    if (!subject || !valueText) {
      toast('请填写记忆主题与内容', 'warn');
      return;
    }
    const res = await request('POST', agentPath('/memory'), { subject, metric, valueText });
    if (!res.ok) {
      toast('保存失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast('记忆已添加', 'success');
    loadBundle();
  }

  async function addKnowledge() {
    if (!state.drawer) return;
    const title = String((state.drawer.querySelector('[data-aw-kn-title]') || {}).value || '').trim();
    const tags = String((state.drawer.querySelector('[data-aw-kn-tags]') || {}).value || '').trim();
    const content = String((state.drawer.querySelector('[data-aw-kn-content]') || {}).value || '').trim();
    if (!title || !content) {
      toast('请填写知识标题与内容', 'warn');
      return;
    }
    const res = await request('POST', agentPath('/knowledge'), { title, tags, content });
    if (!res.ok) {
      toast('保存失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast('知识已添加', 'success');
    loadBundle();
  }

  async function saveContext() {
    if (!state.drawer) return;
    const maxMemoryChars = Number((state.drawer.querySelector('[data-aw-max-memory]') || {}).value || 0);
    const maxKnowledgeChars = Number((state.drawer.querySelector('[data-aw-max-knowledge]') || {}).value || 0);
    const l1El = state.drawer.querySelector('[data-aw-l1]');
    const res = await request('PUT', agentPath('/context'), {
      maxMemoryChars: maxMemoryChars || null,
      maxKnowledgeChars: maxKnowledgeChars || null,
      enableL1Extraction: l1El ? !!l1El.checked : true,
    });
    if (!res.ok) {
      toast('保存失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast('上下文配置已保存', 'success');
    loadBundle();
  }

  function switchTab(id) {
    if (state.tab === id) return;
    state.tab = id;
    state.error = null;
    if (id === 'memory' || id === 'context') {
      // 每次进入都重新拉取：记忆可能被其他窗口改动，快照也会随对话更新
      loadBundle();
      return;
    }
    if (id === 'config') {
      if (state.profile) paint();
      else loadProfile();
      return;
    }
    if (id === 'skills') {
      if (state.skillsLoaded) paint();
      else loadSkills();
      return;
    }
    paint();
  }

  function onClick(e) {
    if (!e.target.closest('[data-aw-model]')) closeModelMenu();
    if (e.target.closest('[data-aw-model-toggle]')) {
      const menu = state.drawer.querySelector('[data-aw-model-menu]');
      if (menu) {
        const willOpen = menu.hidden;
        closeModelMenu();
        menu.hidden = !willOpen;
      }
      return;
    }
    const pickModel = e.target.closest('[data-aw-pick-model]');
    if (pickModel) {
      selectModel(pickModel.dataset.awPickModel);
      return;
    }
    if (e.target.closest('[data-aw-close]')) {
      close();
      return;
    }
    const tab = e.target.closest('[data-aw-tab]');
    if (tab) {
      switchTab(tab.dataset.awTab);
      return;
    }
    if (e.target.closest('[data-aw-skill-new]')) {
      openSkillEditor(null);
      return;
    }
    const skillEdit = e.target.closest('[data-aw-skill-edit]');
    if (skillEdit) {
      const skill = (state.skills || []).find((s) => s.code === skillEdit.dataset.awSkillEdit);
      if (skill) openSkillEditor(skill);
      return;
    }
    const skillToggle = e.target.closest('[data-aw-skill-toggle]');
    if (skillToggle) {
      toggleSkillEnabled(skillToggle.dataset.awSkillToggle);
      return;
    }
    const skillDelete = e.target.closest('[data-aw-skill-delete]');
    if (skillDelete) {
      deleteSkill(skillDelete.dataset.awSkillDelete);
      return;
    }
    if (e.target.closest('[data-aw-send]')) {
      sendChat();
      return;
    }
    const quick = e.target.closest('[data-aw-quick]');
    if (quick) {
      const input = state.drawer.querySelector('[data-aw-chat-input]');
      if (input) {
        input.value = quick.dataset.awQuick || '';
        input.focus();
      }
      return;
    }
    if (e.target.closest('[data-aw-add-memory]')) {
      addMemory();
      return;
    }
    if (e.target.closest('[data-aw-add-knowledge]')) {
      addKnowledge();
      return;
    }
    if (e.target.closest('[data-aw-save-context]')) {
      saveContext();
      return;
    }
    const delMemory = e.target.closest('[data-aw-del-memory]');
    if (delMemory) {
      deleteMemory(delMemory.dataset.awDelMemory);
      return;
    }
    const delKnowledge = e.target.closest('[data-aw-del-knowledge]');
    if (delKnowledge) {
      deleteKnowledge(delKnowledge.dataset.awDelKnowledge);
    }
  }

  async function deleteMemory(id) {
    const ok = await ui.confirm({
      title: '删除这条记忆？',
      desc: '删除后不再注入该 Agent 的上下文（软删除，保留审计痕迹）。',
      ok: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await request('DELETE', agentPath('/memory/' + encodeURIComponent(id)));
    if (!res.ok) {
      toast('删除失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast('记忆已删除', 'success');
    loadBundle();
  }

  async function deleteKnowledge(id) {
    const ok = await ui.confirm({
      title: '删除这条知识？',
      desc: '删除后不再注入该 Agent 的上下文。',
      ok: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await request('DELETE', agentPath('/knowledge/' + encodeURIComponent(id)));
    if (!res.ok) {
      toast('删除失败：' + (res.error || '服务未连接'), 'warn');
      return;
    }
    toast('知识已删除', 'success');
    loadBundle();
  }

  /* ------------------------------ 对外入口 ------------------------------ */

  async function open(agent, tab) {
    ensureShell();
    state.agent = agent;
    state.tab = tab || 'chat';
    state.messages = [];
    state.bundle = null;
    state.profile = null;
    state.error = null;
    state.busy = false;
    state.skills = [];
    state.skillTools = [];
    state.skillsLoaded = false;
    paint();
    loadLlm();
    try {
      state.drawer.focus({ preventScroll: true });
    } catch (_) {
      /* 忽略 */
    }

    if (state.tab === 'chat') {
      await loadHistory();
      paint();
    } else if (state.tab === 'memory' || state.tab === 'context') {
      loadBundle();
    } else if (state.tab === 'skills') {
      loadSkills();
    } else {
      loadProfile();
    }
  }

  WB.agentWorkbench = { open, close };
})();
