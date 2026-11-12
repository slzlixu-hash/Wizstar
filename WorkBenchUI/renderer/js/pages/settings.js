'use strict';

/**
 * 系统设置页
 *   Tab 1：模型与 API Key 设置（供应商卡 + Agent 默认模型映射分派表）
 *   Tab 2：全局业务风控（L1–L4 风险等级与审批策略）
 *   Tab 3：环境与网络配置（环境信息 + 网络开关 + 连通性测试）
 *
 * 纯界面演示：所有数据来自 WB.data.settings，交互仅做本地状态切换。
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

  const GLOBAL_MODEL = app.globalModels[0] || app.globalModel;

  /* 演示用明文 Key：mock-data 只保存了掩码，眼睛切换时展示这段装饰性文本。 */
  const API_KEY_PLAIN = { deepseek: 'sk-9a2f4c8e71b37a9c' };

  /* ------------------------------ 页头操作区 ------------------------------ */
  const HEADER_ACTIONS = [
    ui.btn({ label: '新增模型供应商', icon: 'plus', tone: 'gradient', id: 'set-add-provider-btn' }),
    `<div class="set-global" id="set-global">
      <button type="button" class="set-global-btn" id="set-global-btn" aria-haspopup="listbox" aria-expanded="false" title="选择默认全局模型">
        <span class="set-global-k">默认全局模型：</span>
        <span class="set-global-v" id="set-global-value">${ui.esc(GLOBAL_MODEL)}</span>
        <span class="set-global-caret">${ui.icon('chevron-down', 14)}</span>
      </button>
      <div class="set-global-menu" id="set-global-menu" role="listbox" aria-label="默认全局模型">
        ${app.globalModels
          .map(
            (model) =>
              `<button type="button" class="set-global-item${model === GLOBAL_MODEL ? ' active' : ''}" role="option" aria-selected="${
                model === GLOBAL_MODEL ? 'true' : 'false'
              }" data-set-global-model="${ui.esc(model)}"><span>${ui.esc(model)}</span>${ui.icon('check', 13)}</button>`
          )
          .join('')}
      </div>
    </div>`,
    ui.btn({ label: '保存更改', tone: 'primary', id: 'set-save-btn' }),
  ].join('');

  /* ------------------------------ 模型与 API Key ------------------------------ */
  function providerCard(provider) {
    const hasKeyTools = provider.id !== 'ollama';
    const keyPlain = API_KEY_PLAIN[provider.id] || provider.apiKey;
    const tools = hasKeyTools
      ? `<span class="set-key-tools">
          <button type="button" class="icon-btn" data-set-eye="${ui.esc(provider.id)}" title="显示 / 隐藏 API Key" aria-label="显示或隐藏 API Key">${ui.icon(
            'eye-off',
            16
          )}</button>
          <button type="button" class="icon-btn" data-set-key="${ui.esc(provider.id)}" title="配置 API Key" aria-label="配置 API Key">${ui.icon(
            'pencil',
            16
          )}</button>
        </span>`
      : '';

    const buttons = [];
    if (provider.secondaryAction) {
      buttons.push(
        ui.btn({
          label: provider.secondaryAction,
          tone: 'ghost',
          size: 'sm',
          cls: 'set-btn-quiet',
          attrs: `data-set-edit="${ui.esc(provider.id)}"`,
        })
      );
    }
    if (provider.primaryAction) {
      buttons.push(
        ui.btn({
          label: provider.primaryAction,
          tone: provider.id === 'ollama' ? 'outline' : 'primary',
          size: 'sm',
          attrs: provider.id === 'ollama' ? `data-set-probe="${ui.esc(provider.id)}"` : `data-set-key="${ui.esc(provider.id)}"`,
        })
      );
    }

    return `<section class="card set-provider" data-provider="${ui.esc(provider.id)}">
      <div class="set-provider-head">
        <h3 class="set-provider-name">${ui.esc(provider.name)}<span class="set-provider-seed">（${ui.esc(provider.seed)}）</span></h3>
        <span class="set-provider-badge">${ui.badge(provider.badge.text, { tone: provider.badge.tone, dot: provider.badge.dot })}</span>
      </div>
      <dl class="set-fields">
        <div class="set-frow">
          <dt>Base URL:</dt>
          <dd class="set-fvalue">${ui.esc(provider.baseUrl)}</dd>
        </div>
        <div class="set-frow set-frow--key">
          <dt>API Key:</dt>
          <dd class="set-key-line"><span class="set-key-value" data-key-mask="${ui.esc(provider.apiKey)}" data-key-plain="${ui.esc(
            keyPlain
          )}" data-plain="0">${ui.esc(provider.apiKey)}</span>${tools}</dd>
        </div>
        <div class="set-frow set-frow--models">
          <dt>支持模型:</dt>
          <dd>${provider.models.map((model) => `<span class="set-chip">${ui.esc(model)}</span>`).join('')}</dd>
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
        (row) => `<div class="set-map-row" data-agent="${ui.esc(row.agentId)}">
          <span class="set-map-agent">${ui.esc(row.label)}</span>
          <div class="set-map-side">
            <span class="set-map-label">-&gt; 摆渡的模型:</span>
            <span class="set-map-select">${ui.select({
              options: S.modelOptions,
              value: row.model,
              attrs: `data-map-select="${ui.esc(row.agentId)}" aria-label="${ui.esc(row.label)} 默认模型"`,
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
        sub: '设置默认模型映射分派表；Agent 未单独配置模型时，按此表分派调用。',
        cls: 'set-map-card',
        body: `<div class="set-map-list">${mappingRows()}</div>`,
      })}
    </div>`;
  }

  /* ------------------------------ 全局业务风控 ------------------------------ */
  function riskCard(item) {
    return `<section class="set-risk-card set-risk--${ui.esc(item.tone)}">
      <div class="set-risk-head">
        <span class="set-risk-title">${ui.esc(item.title)}</span>
        ${ui.badge(item.level, { tone: item.tone })}
      </div>
      <p class="set-risk-desc">${ui.esc(item.desc)}</p>
      <div class="set-risk-foot">
        <span class="set-risk-foot-label">执行策略</span>
        <label class="switch">
          <input type="checkbox" data-risk-toggle="${ui.esc(item.id)}"${item.auto ? ' checked' : ''} aria-label="${ui.esc(
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
            <span class="set-env-label">${ui.esc(item.label)}</span>
            <span class="set-env-value">${ui.esc(item.value)}</span>
          </div>
          <span class="set-env-note">${ui.esc(item.note)}</span>
        </div>`
      )
      .join('');
  }

  function toggleRows() {
    return S.toggles
      .map(
        (item) => `<div class="set-toggle-row">
          <div class="set-toggle-copy">
            <div class="set-toggle-label">${ui.esc(item.label)}</div>
            <div class="set-toggle-desc">${ui.esc(item.desc)}</div>
          </div>
          ${ui.switchControl({ checked: item.checked, attrs: `data-toggle="${ui.esc(item.id)}" aria-label="${ui.esc(item.label)}"` })}
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
    btn.innerHTML = `<span class="spinner"></span><span>${ui.esc(loadingText)}</span>`;
    setTimeout(() => {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      btn.style.minWidth = '';
      btn.innerHTML = original;
      if (typeof done === 'function') done();
    }, ms);
  }

  function openProviderModal(provider, mode, toast) {
    const isKey = mode === 'key';
    const body = isKey
      ? `<div class="set-form">
          <label class="field">
            <span class="field-label">API Key</span>
            ${ui.input({ type: 'password', value: API_KEY_PLAIN[provider.id] || provider.apiKey, placeholder: 'sk-...' })}
          </label>
          <div class="field-hint">${ui.esc(provider.keyNote)}</div>
        </div>`
      : `<div class="set-form">
          <label class="field">
            <span class="field-label">供应商名称</span>
            ${ui.input({ value: provider.name })}
          </label>
          <label class="field">
            <span class="field-label">Base URL</span>
            ${ui.input({ value: provider.baseUrl })}
          </label>
          <label class="field">
            <span class="field-label">API Key</span>
            ${ui.input({ value: provider.apiKey })}
          </label>
        </div>`;

    const overlay = ui.modal({
      title: `${isKey ? '配置 API Key' : '编辑供应商'} · ${provider.name}`,
      desc: '演示界面：修改仅保存在当前页面，不会写入真实配置。',
      body,
      actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}${ui.btn({
        label: '保存',
        tone: 'primary',
        attrs: 'data-modal-close data-set-form-ok',
      })}`,
    });
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('[data-set-form-ok]')) {
        toast(isKey ? 'API Key 已更新并等待重新握手（演示）' : '供应商配置已更新（演示）', 'success');
      }
    });
  }

  function openAddProviderModal(toast) {
    const types = ['OpenAI', '阿里通义', '硅基流动', '自定义 (OpenAI 兼容)'];
    const overlay = ui.modal({
      title: '添加自定义模型供应商',
      desc: '支持 OpenAI 兼容协议，保存后会自动握手并拉取模型列表（演示）。',
      body: `<div class="set-form">
        <label class="field">
          <span class="field-label">供应商类型</span>
          ${ui.select({ options: types, value: types[0] })}
        </label>
        <label class="field">
          <span class="field-label">显示名称</span>
          ${ui.input({ placeholder: '例如：阿里通义 百炼' })}
        </label>
        <label class="field">
          <span class="field-label">Base URL</span>
          ${ui.input({ placeholder: 'https://...' })}
        </label>
        <label class="field">
          <span class="field-label">API Key</span>
          ${ui.input({ type: 'password', placeholder: 'sk-...' })}
        </label>
      </div>`,
      actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}${ui.btn({
        label: '添加并握手',
        tone: 'primary',
        attrs: 'data-modal-close data-set-form-ok',
      })}`,
    });
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('[data-set-form-ok]')) toast('自定义供应商已添加并开始握手（演示）', 'success');
    });
  }

  /* 文档级“点击空白关闭下拉”，模块级保存引用，避免重复渲染后监听器累积。 */
  let outsideClickHandler = null;

  /* ------------------------------ 页面注册 ------------------------------ */
  pages.settings = {
    title: '系统设置',
    subtitle: '',
    actions: HEADER_ACTIONS,

    render() {
      return `<div class="stack set-page">
        <div class="set-toolbar">
          <div class="set-tabs" role="tablist" aria-label="系统设置分类">
            ${TABS.map(
              (tab, i) =>
                `<button type="button" class="set-tab${i === 0 ? ' active' : ''}" role="tab" aria-selected="${
                  i === 0 ? 'true' : 'false'
                }" data-set-tab="${ui.esc(tab.id)}">${ui.esc(tab.label)}</button>`
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
          item.addEventListener('click', () => {
            const value = item.dataset.setGlobalModel;
            if (globalValue) globalValue.textContent = value;
            globalMenu.querySelectorAll('.set-global-item').forEach((node) => {
              const active = node === item;
              node.classList.toggle('active', active);
              node.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            closeGlobal();
            toast(`默认全局模型已切换为 ${value}`, 'success');
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

      /* ---------- 页头：保存 / 新增供应商 ---------- */
      const saveBtn = document.getElementById('set-save-btn');
      if (saveBtn) {
        saveBtn.addEventListener('click', () => {
          runButton(saveBtn, '保存中…', 850, () => toast('设置已保存，模型与风控策略已同步（演示）', 'success'));
        });
      }

      const headerAddBtn = document.getElementById('set-add-provider-btn');
      if (headerAddBtn) headerAddBtn.addEventListener('click', () => openAddProviderModal(toast));

      /* ---------- 供应商卡：眼睛 / 编辑 / 配置 / 探测 ---------- */
      ui.bind(root, '[data-set-eye]', 'click', (e) => {
        const btn = e.currentTarget;
        const card = btn.closest('[data-provider]');
        const valueEl = card && card.querySelector('.set-key-value');
        if (!valueEl) return;
        const show = valueEl.dataset.plain !== '1';
        valueEl.dataset.plain = show ? '1' : '0';
        valueEl.textContent = show ? valueEl.dataset.keyPlain : valueEl.dataset.keyMask;
        btn.innerHTML = ui.icon(show ? 'eye' : 'eye-off', 16);
        btn.classList.toggle('is-active', show);
        btn.setAttribute('aria-label', show ? '隐藏 API Key' : '显示 API Key');
      });

      ui.bind(root, '[data-set-edit]', 'click', (e) => {
        const provider = S.providers.find((p) => p.id === e.currentTarget.dataset.setEdit);
        if (provider) openProviderModal(provider, 'edit', toast);
      });

      ui.bind(root, '[data-set-key]', 'click', (e) => {
        const provider = S.providers.find((p) => p.id === e.currentTarget.dataset.setKey);
        if (provider) openProviderModal(provider, 'key', toast);
      });

      ui.bind(root, '[data-set-probe]', 'click', (e) => {
        runButton(e.currentTarget, '探测中…', 650, () =>
          toast('Ollama 本地服务可用 · 127.0.0.1:11434 · 12ms（演示）', 'success')
        );
      });

      ui.bind(root, '[data-set-add-provider]', 'click', () => openAddProviderModal(toast));

      /* ---------- 映射表下拉 ---------- */
      ui.bind(root, '[data-map-select]', 'change', (e) => {
        const agentId = e.currentTarget.dataset.mapSelect;
        const row = S.modelMapping.find((item) => item.agentId === agentId);
        toast(`${row ? row.label : 'Agent'} 默认模型已切换为 ${e.currentTarget.value}`, 'info');
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

      /* ---------- 测试连通性 ---------- */
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
          setTimeout(() => {
            testBtn.disabled = false;
            testBtn.classList.remove('is-busy');
            testBtn.innerHTML = original;
            if (netResult) {
              netResult.innerHTML = `<i class="status-dot online"></i><span>${ui.esc(app.endpoint)} · 12ms · 正常</span>`;
            }
            toast(`连通性正常 · ${app.endpoint}（演示）`, 'success');
          }, 750);
        });
      }
    },
  };
})();
