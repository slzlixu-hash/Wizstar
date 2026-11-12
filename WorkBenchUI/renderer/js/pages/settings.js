'use strict';

/**
 * 系统设置页
 *   Tab 1：模型与 API Key 设置（供应商卡 + 支持模型管理 + Agent 默认模型映射分派表）
 *   Tab 2：全局业务风控（L1–L4 风险等级与审批策略）
 *   Tab 3：环境与网络配置（环境信息 + 网络开关 + 连通性测试）
 *
 * A2：模型与 API Key 接真实 `/api/llm/*`（写操作返回完整快照，直接覆盖 WB.data.settings）。
 *     后端不可用时自动降级为演示交互，不产生 console.error、不白屏。
 *     风控 / 环境两个 Tab 仍为本地演示数据（本期不做业务表写入）。
 *
 * 保留原有全部元素：页头操作区、三个 Tab、供应商卡内 Base URL / API Key（眼睛+铅笔）/
 * 支持模型 chips / 底部按钮、Agent 分派表、虚线添加卡、添加自定义供应商链接。
 */
(function () {
  const WB = window.WB;
  const ui = WB.ui;
  const pages = (WB.pages = WB.pages || {});
  const app = WB.data.app;
  const S = WB.data.settings;

  const TABS = [
    { id: 'models', label: '模型与 API Key 设置' },
    { id: 'risk', label: '全局业务风控' },
    { id: 'network', label: '环境与网络配置' },
  ];

  /* 演示用明文 Key：mock-data 只保存了掩码，离线时眼睛切换展示这段装饰性文本。 */
  const API_KEY_PLAIN = { deepseek: 'sk-9a2f4c8e71b37a9c' };

  /* 新增供应商的类型预设：只填 Base URL，不预置任何本地私有化（本机部署）供应商。 */
  const PROVIDER_PRESETS = {
    OpenAI: 'https://api.openai.com/v1',
    阿里通义: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    硅基流动: 'https://api.siliconflow.cn/v1',
    '自定义 (OpenAI 兼容)': '',
  };

  /* ------------------------------ 真实 / 演示开关 ------------------------------ */
  function isLive() {
    return !!(WB.data && WB.data.llmSource === 'live' && WB.api && WB.api.available());
  }

  function esc(v) {
    return ui.esc(v === undefined || v === null ? '' : String(v));
  }

  function pathId(v) {
    return encodeURIComponent(String(v));
  }

  function findProvider(id) {
    return (S.providers || []).find(function (p) { return p.id === id; }) || null;
  }

  /* 写操作返回的快照直接复用 api-client 的适配层；随后重渲染设置页。 */
  function applySnapshot(snapshot) {
    try {
      if (snapshot && WB.api && typeof WB.api.applyLlm === 'function') WB.api.applyLlm(snapshot);
      if (typeof WB.go === 'function') WB.go('settings');
    } catch (_) {
      /* 适配失败保持当前界面，不抛到渲染进程 */
    }
  }

  /**
   * 统一写操作。成功 → 应用快照 + 重渲染 + 成功 toast；
   * 失败 → 明确提示原因并保留当前数据；演示态 → 只给演示 toast。
   */
  async function call(method, path, body, toast, okMessage) {
    if (!isLive()) {
      toast(okMessage + '（演示）', 'info');
      return { ok: false, demo: true };
    }
    let res;
    try {
      res = await WB.api.request(method, path, body);
    } catch (_) {
      toast('操作未生效：服务未连接（已保留当前数据）', 'warn');
      return { ok: false };
    }
    if (!res.ok) {
      toast('操作未生效：' + (res.error || '服务未连接') + '（已保留当前数据）', 'warn');
      return res;
    }
    if (res.data) applySnapshot(res.data);
    toast(okMessage, 'success');
    return res;
  }

  /* ------------------------------ 页头操作区 ------------------------------ */
  function headerActions() {
    const models = app.globalModels && app.globalModels.length ? app.globalModels : [app.globalModel];
    const current = app.globalModel || models[0] || '';

    return [
      ui.btn({ label: '新增模型供应商', icon: 'plus', tone: 'gradient', id: 'set-add-provider-btn' }),
      ui.btn({ label: '支持模型', icon: 'layers', tone: 'outline', size: 'sm', id: 'set-models-btn' }),
      `<div class="set-global" id="set-global">
        <button type="button" class="set-global-btn" id="set-global-btn" aria-haspopup="listbox" aria-expanded="false" title="选择默认全局模型">
          <span class="set-global-k">默认全局模型：</span>
          <span class="set-global-v" id="set-global-value">${esc(current)}</span>
          <span class="set-global-caret">${ui.icon('chevron-down', 14)}</span>
        </button>
        <div class="set-global-menu" id="set-global-menu" role="listbox" aria-label="默认全局模型">
          ${models
            .map(
              (model) =>
                `<button type="button" class="set-global-item${model === current ? ' active' : ''}" role="option" aria-selected="${
                  model === current ? 'true' : 'false'
                }" data-set-global-model="${esc(model)}"><span>${esc(model)}</span>${ui.icon('check', 13)}</button>`
            )
            .join('')}
        </div>
      </div>`,
      ui.btn({ label: '保存更改', tone: 'primary', id: 'set-save-btn' }),
    ].join('');
  }

  /* ------------------------------ 模型与 API Key ------------------------------ */
  function providerCard(provider) {
    const builtin = !!provider.builtin;
    const builtinTag = builtin
      ? `<span class="set-provider-builtin">${ui.badge('内置', { tone: 'cyan' })}</span>`
      : '';
    const models = (provider.models || []).map(function (m) {
      return typeof m === 'string' ? { id: m, name: m } : { id: m.id, name: m.name || m.id };
    });
    const keyMask = provider.apiKey || '未配置';
    const keyPlain = isLive() ? keyMask : API_KEY_PLAIN[provider.id] || keyMask;

    const tools = `<span class="set-key-tools">
        <button type="button" class="icon-btn" data-set-eye="${esc(provider.id)}" title="显示 / 隐藏 API Key" aria-label="显示或隐藏 API Key">${ui.icon(
          'eye-off',
          16
        )}</button>
        <button type="button" class="icon-btn" data-set-key="${esc(provider.id)}" title="配置 API Key" aria-label="配置 API Key">${ui.icon(
          'pencil',
          16
        )}</button>
      </span>`;

    const buttons = [];
    if (provider.secondaryAction) {
      buttons.push(
        ui.btn({
          label: provider.secondaryAction,
          tone: 'ghost',
          size: 'sm',
          cls: 'set-btn-quiet',
          attrs: `data-set-edit="${esc(provider.id)}"`,
        })
      );
    }
    if (provider.primaryAction) {
      buttons.push(
        ui.btn({
          label: provider.primaryAction,
          tone: 'primary',
          size: 'sm',
          attrs: `data-set-key="${esc(provider.id)}"`,
        })
      );
    }
    /* 内置（DeepSeek）不可删除；用户自建供应商提供删除入口。 */
    if (!builtin) {
      buttons.push(
        ui.btn({
          label: '删除',
          icon: 'trash',
          tone: 'danger',
          size: 'sm',
          attrs: `data-set-delete="${esc(provider.id)}"`,
        })
      );
    }

    return `<section class="card set-provider" data-provider="${esc(provider.id)}">
      <div class="set-provider-head">
        <h3 class="set-provider-name">${esc(provider.name)}${builtinTag}</h3>
        <span class="set-provider-badge">${ui.badge(provider.badge.text, {
          tone: provider.badge.tone,
          dot: provider.badge.dot,
        })}</span>
      </div>
      <dl class="set-fields">
        <div class="set-frow">
          <dt>Base URL:</dt>
          <dd class="set-fvalue">${esc(provider.baseUrl)}</dd>
        </div>
        <div class="set-frow set-frow--key">
          <dt>API Key:</dt>
          <dd class="set-key-line"><span class="set-key-value" data-key-mask="${esc(keyMask)}" data-key-plain="${esc(
            keyPlain
          )}" data-plain="0">${esc(keyMask)}</span>${tools}</dd>
        </div>
        <div class="set-frow set-frow--models">
          <dt>支持模型:</dt>
          <dd>
            <div class="set-model-chips">${models
              .map((model) => `<span class="set-chip">${esc(model.name)}</span>`)
              .join('')}</div>
            <button type="button" class="set-model-manage" data-set-models="${esc(provider.id)}" title="管理该供应商的支持模型">
              ${ui.icon('layers', 13)}<span>管理</span>
            </button>
          </dd>
        </div>
      </dl>
      <div class="set-provider-foot">${buttons.join('')}</div>
    </section>`;
  }

  function addProviderCard() {
    return `<button type="button" class="card-dashed set-add-card" data-set-add-provider>
      <span class="set-add-plus">${ui.icon('plus', 34)}</span>
      <span class="set-add-title">添加自定义供应商</span>
      <span class="set-add-sub">(OpenAI / 阿里通义 / 硅基流动)</span>
    </button>`;
  }

  function mappingRows() {
    return S.modelMapping
      .map(
        (row) => `<div class="set-map-row" data-agent="${esc(row.agentId)}">
          <span class="set-map-agent">${esc(row.label)}</span>
          <div class="set-map-side">
            <span class="set-map-label">-&gt; 摆渡的模型:</span>
            <span class="set-map-select">${ui.select({
              options: S.modelOptions,
              value: row.model,
              attrs: `data-map-select="${esc(row.agentId)}" aria-label="${esc(row.label)} 默认模型"`,
            })}</span>
          </div>
        </div>`
      )
      .join('');
  }

  function modelsPanel() {
    return `<div class="set-panel" data-panel="models">
      <div class="set-providers">${S.providers.map(providerCard).join('')}${addProviderCard()}</div>
      ${ui.card({
        title: 'Agent 默认模型映射分派表',
        sub: '设置默认模型映射分派表；Agent 未单独配置模型时，按此表分派调用。修改后点「保存更改」提交。',
        cls: 'set-map-card',
        body: `<div class="set-map-list">${mappingRows()}</div>`,
      })}
    </div>`;
  }

  /* ------------------------------ 全局业务风控 ------------------------------ */
  function riskCard(item) {
    return `<section class="set-risk-card set-risk--${esc(item.tone)}">
      <div class="set-risk-head">
        <span class="set-risk-title">${esc(item.title)}</span>
        ${ui.badge(item.level, { tone: item.tone })}
      </div>
      <p class="set-risk-desc">${esc(item.desc)}</p>
      <div class="set-risk-foot">
        <span class="set-risk-foot-label">执行策略</span>
        <label class="switch">
          <input type="checkbox" data-risk-toggle="${esc(item.id)}"${item.auto ? ' checked' : ''} aria-label="${esc(
            item.title
          )} 执行策略" />
          <span class="track"></span>
          <span class="set-risk-state">${item.auto ? '自动执行' : '需人工审批'}</span>
        </label>
      </div>
    </section>`;
  }

  function riskPanel() {
    return `<div class="set-panel is-hidden" data-panel="risk">
      <div class="set-risk-grid">${S.riskPolicy.map(riskCard).join('')}</div>
      <div class="set-note">
        <span class="set-note-ico">${ui.icon('shield', 16)}</span>
        <span><strong>服务端不自动批准 HITL：</strong>L3 / L4 操作由服务端强制挂起人工审批，Agent 无法自行重试或跳过；风险等级与开关仅影响本地演示策略。</span>
      </div>
    </div>`;
  }

  /* ------------------------------ 环境与网络配置 ------------------------------ */
  function envRows() {
    return S.environment
      .map(
        (item) => `<div class="set-env-row">
          <div class="set-env-top">
            <span class="set-env-label">${esc(item.label)}</span>
            <span class="set-env-value">${esc(item.value)}</span>
          </div>
          <span class="set-env-note">${esc(item.note)}</span>
        </div>`
      )
      .join('');
  }

  function toggleRows() {
    return S.toggles
      .map(
        (item) => `<div class="set-toggle-row">
          <div class="set-toggle-copy">
            <div class="set-toggle-label">${esc(item.label)}</div>
            <div class="set-toggle-desc">${esc(item.desc)}</div>
          </div>
          ${ui.switchControl({ checked: item.checked, attrs: `data-toggle="${esc(item.id)}" aria-label="${esc(item.label)}"` })}
        </div>`
      )
      .join('');
  }

  function networkPanel() {
    return `<div class="set-panel is-hidden" data-panel="network">
      <div class="set-net-grid">
        <section class="card set-env-card">
          <div class="card-head">
            <div>
              <div class="card-title">环境信息</div>
              <div class="card-sub">本机运行环境与操作账本参数（演示数据）</div>
            </div>
            <span class="set-head-side">${ui.badge('只读', { tone: 'slate' })}</span>
          </div>
          <div class="set-env-list">${envRows()}</div>
        </section>
        <section class="card set-net-card">
          <div class="card-head">
            <div>
              <div class="card-title">网络与连通性</div>
              <div class="card-sub">本地回环服务与 MCP 握手策略</div>
            </div>
            <span class="set-net-status">${ui.statusDot('online', '服务正常')}</span>
          </div>
          <div class="set-toggle-list">${toggleRows()}</div>
          <div class="set-net-foot">
            ${ui.btn({ label: '测试连通性', icon: 'wifi', tone: 'outline', size: 'sm', id: 'set-test-conn' })}
            <span class="set-net-result" id="set-net-result">${ui.statusDot('offline', '尚未测试')}</span>
          </div>
        </section>
      </div>
    </div>`;
  }

  /* ------------------------------ 弹窗 / 按钮加载 ------------------------------ */
  function runButton(btn, loadingText, ms, done) {
    if (!btn || btn.disabled) return;
    const original = btn.innerHTML;
    btn.style.minWidth = `${btn.offsetWidth}px`;
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.innerHTML = `<span class="spinner"></span><span>${esc(loadingText)}</span>`;
    setTimeout(() => {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      btn.style.minWidth = '';
      btn.innerHTML = original;
      if (typeof done === 'function') done();
    }, ms);
  }

  function field(overlay, name) {
    const el = overlay.querySelector(`[data-f="${name}"]`);
    return el ? String(el.value || '').trim() : '';
  }

  function openProviderModal(provider, mode, toast) {
    const isKey = mode === 'key';
    const body = isKey
      ? `<div class="set-form">
          <label class="field">
            <span class="field-label">API Key</span>
            ${ui.input({ type: 'password', placeholder: 'sk-...（留空则清除已保存的 Key）', attrs: 'data-f="apiKey"' })}
          </label>
          <div class="field-hint">${esc(provider.keyNote || '密文落库，仅主动查看时取回明文')}</div>
        </div>`
      : `<div class="set-form">
          <label class="field">
            <span class="field-label">供应商名称</span>
            ${ui.input({ value: provider.name, attrs: 'data-f="name"' })}
          </label>
          <label class="field">
            <span class="field-label">Base URL</span>
            ${ui.input({ value: provider.baseUrl, attrs: 'data-f="baseUrl"' })}
          </label>
          <label class="field">
            <span class="field-label">启用状态</span>
            ${ui.switchControl({ checked: provider.enabled !== false, attrs: 'data-f="enabled"' })}
          </label>
        </div>`;

    const overlay = ui.modal({
      title: `${isKey ? '配置 API Key' : '编辑供应商'} · ${esc(provider.name)}`,
      desc: isLive() ? '保存后立即生效，模型通道会按新配置热切换。' : '演示界面：修改仅保存在当前页面，不会写入真实配置。',
      body,
      actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}${ui.btn({
        label: '保存',
        tone: 'primary',
        attrs: 'data-set-form-ok',
      })}`,
    });

    overlay.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-set-form-ok]')) return;
      let res;
      if (isKey) {
        res = await call(
          'PUT',
          `/api/llm/providers/${pathId(provider.id)}/api-key`,
          { apiKey: field(overlay, 'apiKey') },
          toast,
          'API Key 已加密保存'
        );
      } else {
        const enabledEl = overlay.querySelector('[data-f="enabled"]');
        res = await call(
          'PUT',
          `/api/llm/providers/${pathId(provider.id)}`,
          {
            name: field(overlay, 'name'),
            baseUrl: field(overlay, 'baseUrl'),
            enabled: enabledEl ? !!enabledEl.checked : undefined,
          },
          toast,
          '供应商配置已更新'
        );
      }
      if (res && (res.ok || res.demo)) overlay.close();
    });
  }

  function openAddProviderModal(toast) {
    const types = Object.keys(PROVIDER_PRESETS);
    const overlay = ui.modal({
      title: '添加自定义模型供应商',
      desc: '支持公网 OpenAI 兼容协议；保存后即可配置 API Key 与管理支持模型。',
      body: `<div class="set-form">
        <label class="field">
          <span class="field-label">供应商类型</span>
          ${ui.select({ options: types, value: types[0], attrs: 'data-f="type"' })}
        </label>
        <label class="field">
          <span class="field-label">显示名称</span>
          ${ui.input({ placeholder: '例如：阿里通义 百炼', attrs: 'data-f="name"' })}
        </label>
        <label class="field">
          <span class="field-label">Base URL</span>
          ${ui.input({ value: PROVIDER_PRESETS[types[0]], placeholder: 'https://.../v1', attrs: 'data-f="baseUrl"' })}
        </label>
        <label class="field">
          <span class="field-label">API Key</span>
          ${ui.input({ type: 'password', placeholder: 'sk-...', attrs: 'data-f="apiKey"' })}
        </label>
        <label class="field">
          <span class="field-label">支持模型（逗号分隔，可留空）</span>
          ${ui.input({ placeholder: '例如：qwen-plus, qwen-max', attrs: 'data-f="models"' })}
        </label>
      </div>`,
      actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}${ui.btn({
        label: '添加供应商',
        tone: 'primary',
        attrs: 'data-set-form-ok',
      })}`,
    });

    overlay.addEventListener('change', (e) => {
      if (!e.target.matches('[data-f="type"]')) return;
      const urlEl = overlay.querySelector('[data-f="baseUrl"]');
      if (urlEl) urlEl.value = PROVIDER_PRESETS[e.target.value] || '';
    });

    overlay.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-set-form-ok]')) return;
      const models = field(overlay, 'models')
        .split(/[,，\s]+/)
        .filter(Boolean);
      const res = await call(
        'POST',
        '/api/llm/providers',
        {
          name: field(overlay, 'name'),
          baseUrl: field(overlay, 'baseUrl'),
          apiKey: field(overlay, 'apiKey'),
          models: models,
        },
        toast,
        '自定义供应商已添加'
      );
      if (res && (res.ok || res.demo)) overlay.close();
    });
  }

  /** 支持模型管理入口：页头「支持模型」与卡内「管理」按钮共用。 */
  function openModelsModal(providerId, toast) {
    const first = findProvider(providerId) || S.providers[0];
    if (!first) {
      toast('暂无可管理的供应商', 'warn');
      return;
    }

    const overlay = ui.modal({
      title: '支持模型管理',
      desc: '按供应商维护可调用的模型 ID；内置供应商同样可增删自定义模型。',
      body: `<div class="set-form">
        <label class="field">
          <span class="field-label">供应商</span>
          ${ui.select({
            options: S.providers.map((p) => ({ value: p.id, label: p.name })),
            value: first.id,
            attrs: 'data-f="provider"',
          })}
        </label>
        <div class="set-model-list" data-model-list></div>
        <div class="set-model-add">
          ${ui.input({ placeholder: '模型 ID，例如 deepseek-chat', attrs: 'data-f="modelId"' })}
          ${ui.btn({ label: '添加', icon: 'plus', tone: 'primary', size: 'sm', attrs: 'data-model-add' })}
        </div>
        <div class="field-hint">显示名称默认与模型 ID 相同；删除模型不会删除 API Key。</div>
      </div>`,
      actions: `${ui.btn({ label: '关闭', tone: 'ghost', attrs: 'data-modal-close' })}`,
    });

    function currentId() {
      const sel = overlay.querySelector('[data-f="provider"]');
      return sel ? sel.value : first.id;
    }

    function renderList() {
      const listEl = overlay.querySelector('[data-model-list]');
      if (!listEl) return;
      const provider = findProvider(currentId());
      const models = (provider && provider.models) || [];
      listEl.innerHTML = models.length
        ? models
            .map((m) => {
              const id = typeof m === 'string' ? m : m.id;
              const name = typeof m === 'string' ? m : m.name || m.id;
              return `<div class="set-model-row">
                <span class="set-model-name">${esc(name)}</span>
                <code class="set-model-id">${esc(id)}</code>
                <button type="button" class="set-model-del" data-model-del="${esc(id)}" title="删除模型" aria-label="删除模型 ${esc(
                  id
                )}">${ui.icon('trash', 14)}</button>
              </div>`;
            })
            .join('')
        : '<div class="set-model-empty">该供应商暂无模型，请先在下方添加。</div>';
    }

    renderList();

    overlay.addEventListener('change', (e) => {
      if (e.target.matches('[data-f="provider"]')) renderList();
    });

    overlay.addEventListener('click', async (e) => {
      const pid = currentId();
      if (e.target.closest('[data-model-add]')) {
        const input = overlay.querySelector('[data-f="modelId"]');
        const modelId = input ? String(input.value || '').trim() : '';
        if (!modelId) {
          toast('请填写模型 ID', 'warn');
          return;
        }
        const res = await call(
          'POST',
          `/api/llm/providers/${pathId(pid)}/models`,
          { modelId: modelId, displayName: null },
          toast,
          `模型已添加：${modelId}`
        );
        if (input && res.ok) input.value = '';
        if (res.demo) {
          const p = findProvider(pid);
          if (p) {
            p.models = (p.models || []).concat([{ id: modelId, name: modelId }]);
            if (input) input.value = '';
          }
        }
        renderList();
        return;
      }

      const del = e.target.closest('[data-model-del]');
      if (del) {
        const modelId = del.dataset.modelDel;
        const res = await call(
          'DELETE',
          `/api/llm/providers/${pathId(pid)}/models?modelId=${pathId(modelId)}`,
          null,
          toast,
          `模型已删除：${modelId}`
        );
        if (res.demo) {
          const p = findProvider(pid);
          if (p) p.models = (p.models || []).filter((m) => (typeof m === 'string' ? m : m.id) !== modelId);
        }
        renderList();
      }
    });
  }

  /* 文档级“点击空白关闭下拉”，模块级保存引用，避免重复渲染后监听器累积。 */
  let outsideClickHandler = null;

  /* ------------------------------ 页面注册 ------------------------------ */
  pages.settings = {
    title: '系统设置',
    subtitle: '',
    get actions() {
      return headerActions();
    },

    render() {
      return `<div class="stack set-page">
        <div class="set-toolbar">
          <div class="set-tabs" role="tablist" aria-label="系统设置分类">
            ${TABS.map(
              (tab, i) =>
                `<button type="button" class="set-tab${i === 0 ? ' active' : ''}" role="tab" aria-selected="${
                  i === 0 ? 'true' : 'false'
                }" data-set-tab="${esc(tab.id)}">${esc(tab.label)}</button>`
            ).join('')}
          </div>
          <button type="button" class="set-add-link" data-set-add-provider>
            ${ui.icon('plus', 15)}<span>添加自定义供应商</span><span class="set-add-hint">(OpenAI / 阿里通义 / 硅基流动)</span>
          </button>
        </div>
        ${modelsPanel()}
        ${riskPanel()}
        ${networkPanel()}
      </div>`;
    },

    mount(root, ctx) {
      const toast = ctx.toast;

      /* 设置页自治兜底：首屏并行预取稍慢时（或用户秒进设置页），进页面再取一次。
         llmSource 变成 live 后不再重复请求，避免 WB.go 重渲染造成循环。 */
      if (!isLive() && WB.api && WB.api.available()) {
        WB.api.request('GET', '/api/llm/settings')
          .then(function (res) {
            if (res.ok && WB.data && WB.data.llmSource !== 'live') applySnapshot(res.data);
          })
          .catch(function () {});
      }

      /* ---------- Tab 切换 ---------- */
      ui.bind(root, '[data-set-tab]', 'click', (e) => {
        const id = e.currentTarget.dataset.setTab;
        root.querySelectorAll('[data-set-tab]').forEach((tab) => {
          const on = tab.dataset.setTab === id;
          tab.classList.toggle('active', on);
          tab.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        root.querySelectorAll('.set-panel').forEach((panel) => {
          panel.classList.toggle('is-hidden', panel.dataset.panel !== id);
        });
        root.scrollTop = 0;
      });

      /* ---------- 页头：全局模型下拉 ---------- */
      const globalWrap = document.getElementById('set-global');
      const globalBtn = document.getElementById('set-global-btn');
      const globalValue = document.getElementById('set-global-value');
      const globalMenu = document.getElementById('set-global-menu');

      if (globalWrap && globalBtn && globalMenu) {
        const closeGlobal = () => {
          globalWrap.classList.remove('open');
          globalBtn.setAttribute('aria-expanded', 'false');
        };

        globalBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const open = globalWrap.classList.toggle('open');
          globalBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });

        globalMenu.querySelectorAll('[data-set-global-model]').forEach((item) => {
          item.addEventListener('click', async () => {
            const value = item.dataset.setGlobalModel;
            if (globalValue) globalValue.textContent = value;
            globalMenu.querySelectorAll('.set-global-item').forEach((node) => {
              const active = node === item;
              node.classList.toggle('active', active);
              node.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            closeGlobal();

            if (!isLive()) {
              toast(`默认全局模型已切换为 ${value}`, 'success');
              return;
            }
            const res = await WB.api.request('PUT', '/api/llm/default-model', { modelId: value });
            if (res.ok) {
              applySnapshot(res.data);
              toast(`默认全局模型已切换为 ${value}`, 'success');
            } else {
              toast(`切换未生效：${res.error || '服务未连接'}`, 'warn');
            }
          });
        });

        if (outsideClickHandler) document.removeEventListener('click', outsideClickHandler);
        outsideClickHandler = (e) => {
          const wrap = document.getElementById('set-global');
          if (!wrap) {
            document.removeEventListener('click', outsideClickHandler);
            outsideClickHandler = null;
            return;
          }
          if (!wrap.contains(e.target)) {
            wrap.classList.remove('open');
            const btn = document.getElementById('set-global-btn');
            if (btn) btn.setAttribute('aria-expanded', 'false');
          }
        };
        document.addEventListener('click', outsideClickHandler);
      }

      /* ---------- 页头：保存 / 新增供应商 / 支持模型 ---------- */
      const saveBtn = document.getElementById('set-save-btn');
      if (saveBtn) {
        saveBtn.addEventListener('click', () => {
          runButton(saveBtn, '保存中…', 400, async () => {
            const bindings = {};
            root.querySelectorAll('[data-map-select]').forEach((sel) => {
              if (sel.dataset.mapSelect && sel.value) bindings[sel.dataset.mapSelect] = sel.value;
            });
            const globalEl = document.getElementById('set-global-value');
            const defaultModel = globalEl ? String(globalEl.textContent || '').trim() : app.globalModel;

            if (!isLive()) {
              toast('设置已保存，模型与风控策略已同步（演示）', 'success');
              return;
            }

            const first = await WB.api.request('PUT', '/api/llm/bindings', { bindings: bindings });
            if (!first.ok) {
              toast(`保存失败：${first.error || '服务未连接'}`, 'warn');
              return;
            }
            let snapshot = first.data;
            if (defaultModel && (S.modelOptions || []).indexOf(defaultModel) >= 0) {
              const second = await WB.api.request('PUT', '/api/llm/default-model', { modelId: defaultModel });
              if (second.ok) snapshot = second.data;
            }
            applySnapshot(snapshot);
            toast('设置已保存，模型通道已按新配置热切换', 'success');
          });
        });
      }

      const headerAddBtn = document.getElementById('set-add-provider-btn');
      if (headerAddBtn) headerAddBtn.addEventListener('click', () => openAddProviderModal(toast));

      const headerModelsBtn = document.getElementById('set-models-btn');
      if (headerModelsBtn) {
        headerModelsBtn.addEventListener('click', () => openModelsModal(S.providers[0] && S.providers[0].id, toast));
      }

      /* ---------- 供应商卡：眼睛 / 编辑 / 配置 Key / 删除 / 支持模型 ---------- */
      ui.bind(root, '[data-set-eye]', 'click', async (e) => {
        const btn = e.currentTarget;
        const card = btn.closest('[data-provider]');
        const valueEl = card && card.querySelector('.set-key-value');
        if (!valueEl) return;
        const show = valueEl.dataset.plain !== '1';

        if (show && isLive()) {
          const res = await WB.api.request('GET', `/api/llm/providers/${pathId(card.dataset.provider)}/api-key`);
          if (!res.ok) {
            toast(`无法读取明文：${res.error || '服务未连接'}`, 'warn');
            return;
          }
          valueEl.dataset.keyPlain = (res.data && res.data.apiKey) || '未配置';
        }

        valueEl.dataset.plain = show ? '1' : '0';
        valueEl.textContent = show ? valueEl.dataset.keyPlain : valueEl.dataset.keyMask;
        btn.innerHTML = ui.icon(show ? 'eye' : 'eye-off', 16);
        btn.classList.toggle('is-active', show);
        btn.setAttribute('aria-label', show ? '隐藏 API Key' : '显示 API Key');
      });

      ui.bind(root, '[data-set-edit]', 'click', (e) => {
        const provider = findProvider(e.currentTarget.dataset.setEdit);
        if (provider) openProviderModal(provider, 'edit', toast);
      });

      ui.bind(root, '[data-set-key]', 'click', (e) => {
        const provider = findProvider(e.currentTarget.dataset.setKey);
        if (provider) openProviderModal(provider, 'key', toast);
      });

      ui.bind(root, '[data-set-delete]', 'click', async (e) => {
        const id = e.currentTarget.dataset.setDelete;
        const provider = findProvider(id);
        const ok = await ui.confirm({
          title: '删除供应商',
          desc: `将同时删除「${provider ? provider.name : id}」下的支持模型与 Agent 分派，且不可恢复。`,
          ok: '删除',
          tone: 'danger',
        });
        if (!ok) return;
        await call('DELETE', `/api/llm/providers/${pathId(id)}`, null, toast, '供应商已删除');
      });

      ui.bind(root, '[data-set-models]', 'click', (e) => {
        openModelsModal(e.currentTarget.dataset.setModels, toast);
      });

      ui.bind(root, '[data-set-add-provider]', 'click', () => openAddProviderModal(toast));

      /* ---------- 映射表下拉 ---------- */
      ui.bind(root, '[data-map-select]', 'change', (e) => {
        const agentId = e.currentTarget.dataset.mapSelect;
        const row = S.modelMapping.find((item) => item.agentId === agentId);
        toast(`${row ? row.label : 'Agent'} 默认模型已切换为 ${e.currentTarget.value}（保存后生效）`, 'info');
      });

      /* ---------- 风控开关 ---------- */
      ui.bind(root, '[data-risk-toggle]', 'change', (e) => {
        const input = e.currentTarget;
        const item = S.riskPolicy.find((r) => r.id === input.dataset.riskToggle);
        const state = input.closest('.switch');
        const label = state && state.querySelector('.set-risk-state');
        if (label) label.textContent = input.checked ? '自动执行' : '需人工审批';
        toast(
          `${item ? `${item.level} ${item.title}` : '风控策略'}：${input.checked ? '自动执行' : '需人工审批'}`,
          input.checked ? 'success' : 'warn'
        );
      });

      /* ---------- 环境开关 ---------- */
      ui.bind(root, '[data-toggle]', 'change', (e) => {
        const input = e.currentTarget;
        const item = S.toggles.find((t) => t.id === input.dataset.toggle);
        toast(`${item ? item.label : '网络选项'}：已${input.checked ? '开启' : '关闭'}`, input.checked ? 'success' : 'info');
      });

      /* ---------- 测试连通性：真实 /models 探测，失败显式标注 ---------- */
      const testBtn = root.querySelector('#set-test-conn');
      const netResult = root.querySelector('#set-net-result');
      if (testBtn) {
        testBtn.addEventListener('click', () => {
          if (testBtn.disabled) return;
          const original = testBtn.innerHTML;
          testBtn.disabled = true;
          testBtn.classList.add('is-busy');
          testBtn.innerHTML = '<span class="spinner"></span><span>测试中…</span>';
          if (netResult) netResult.innerHTML = ui.statusDot('cyan', '正在探测…');

          const restore = () => {
            testBtn.disabled = false;
            testBtn.classList.remove('is-busy');
            testBtn.innerHTML = original;
          };

          if (!isLive()) {
            setTimeout(() => {
              restore();
              if (netResult) netResult.innerHTML = `<i class="status-dot online"></i><span>${esc(app.endpoint)} · 12ms · 正常</span>`;
              toast(`连通性正常 · ${app.endpoint}（演示）`, 'success');
            }, 750);
            return;
          }

          WB.api.request('POST', '/api/llm/test', {})
            .then((res) => {
              restore();
              if (!res.ok) {
                if (netResult) netResult.innerHTML = ui.statusDot('offline', '探测失败');
                toast(`探测失败：${res.error || '服务未连接'}`, 'warn');
                return;
              }
              const d = res.data || {};
              const ok = !!d.reachable;
              if (netResult) {
                netResult.innerHTML = `<i class="status-dot ${ok ? 'online' : 'offline'}"></i><span>${esc(
                  ok ? `${d.model || ''} · ${d.elapsedMs || 0}ms · ${d.status || ''}` : d.reason || '不可用'
                )}</span>`;
              }
              toast(ok ? `握手成功 · ${d.endpoint || ''}（/models）` : `连通性异常：${d.reason || '未通过'}`, ok ? 'success' : 'warn');
            })
            .catch(() => {
              restore();
              if (netResult) netResult.innerHTML = ui.statusDot('offline', '探测失败');
              toast('探测失败：服务未连接', 'warn');
            });
        });
      }
    },
  };
})();
