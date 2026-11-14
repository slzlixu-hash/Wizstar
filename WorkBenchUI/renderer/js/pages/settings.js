'use strict';

/**
 * 系统设置页
 *   Tab 1：模型与 API Key 设置（供应商卡：编辑 / 模型管理 / 删除 + 虚线新增卡）
 *   Tab 2：全局业务风控（L1–L3 风险等级与审批策略，落 sys_risk_policy）
 *   Tab 3：环境与网络配置（真实运行参数 + 可持久化开关）
 *
 * 三个 Tab 全部接真实接口，无演示降级：
 *   模型  → /api/llm/*
 *   风控  → GET/PUT /api/settings/risk
 *   环境  → GET/PUT /api/settings/environment
 *
 * 风控等级与后端 RiskLevels 一一对应（read / write / irreversible）；
 * irreversible 为平台强制人工审批，开关锁定不可关闭（服务端从不自动批准）。
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

  /* 新增供应商的类型预设：只填 Base URL，不预置任何本地私有化（本机部署）供应商。 */
  const PROVIDER_PRESETS = {
    OpenAI: 'https://api.openai.com/v1',
    阿里通义: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    硅基流动: 'https://api.siliconflow.cn/v1',
    '自定义 (OpenAI 兼容)': '',
  };

  /* ------------------------------ 真实链路判定 ------------------------------ */
  function isLive() {
    return !!(WB.data && WB.data.app && WB.data.app.source === 'live' && WB.api && WB.api.available());
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
   * 统一写操作：成功 → 应用返回快照 + 重渲染 + 成功 toast；
   * 失败 → 明确提示原因并保留当前数据。没有演示分支——接口不通就如实报错。
   */
  async function call(method, path, body, toast, okMessage) {
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

  /* ------------------------------ 模型与 API Key ------------------------------ */
  function providerCard(provider) {
    const builtin = !!provider.builtin;
    const builtinTag = builtin
      ? `<span class="set-provider-builtin">${ui.badge('内置', { tone: 'cyan' })}</span>`
      : '';
    const models = (provider.models || []).map(function (m) {
      return typeof m === 'string' ? { id: m, name: m } : { id: m.id, name: m.name || m.id };
    });
    // API Key 已配置时显示「头部 4 字符 + 掩码 + 尾部 4 字符」；未配置显示「未配置」。
    // 掩码由后端 ApiKeyProtector.Hint 生成，前端只做展示，不入明文、不提供「显示明文」入口。
    const keyMask = provider.apiKey || '未配置';

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
    /* 支持模型管理入口：与「编辑供应商」并排，不再放在模型 chip 行内。 */
    buttons.push(
      ui.btn({
        label: '模型管理',
        icon: 'layers',
        tone: 'outline',
        size: 'sm',
        attrs: `data-set-models="${esc(provider.id)}"`,
      })
    );
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
        <h3 class="set-provider-name">${esc(provider.name)}</h3>
        <span class="set-provider-tags">
          ${builtinTag}
          <span class="set-provider-badge">${ui.badge(provider.badge.text, {
            tone: provider.badge.tone,
            dot: provider.badge.dot,
          })}</span>
        </span>
      </div>
      <dl class="set-fields">
        <div class="set-frow">
          <dt>Base URL:</dt>
          <dd class="set-fvalue">${esc(provider.baseUrl)}</dd>
        </div>
        <div class="set-frow set-frow--key">
          <dt>API Key:</dt>
          <dd class="set-key-line"><span class="set-key-value">${esc(keyMask)}</span></dd>
        </div>
        <div class="set-frow set-frow--models">
          <dt>支持模型:</dt>
          <dd>
            <div class="set-model-chips">${models
              .map((model) => `<span class="set-chip">${esc(model.name)}</span>`)
              .join('')}</div>
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

  function modelsPanel() {
    return `<div class="set-panel" data-panel="models">
      <div class="set-providers">${(S.providers || []).map(providerCard).join('')}${addProviderCard()}</div>
    </div>`;
  }

  /* ------------------------------ 全局业务风控 ------------------------------ */
  function riskCard(item) {
    // locked = 平台强制人工审批（不可逆操作），开关固定为「需人工审批」且禁用
    const locked = !!item.locked;
    return `<section class="set-risk-card set-risk--${esc(item.tone)}">
      <div class="set-risk-head">
        <span class="set-risk-title">${esc(item.title)}</span>
        ${ui.badge(item.level, { tone: item.tone })}
      </div>
      <p class="set-risk-desc">${esc(item.desc)}</p>
      <div class="set-risk-foot">
        <span class="set-risk-foot-label">执行策略</span>
        <label class="switch">
          <input type="checkbox" data-risk-toggle="${esc(item.id)}"${item.auto ? ' checked' : ''}${
            locked ? ' disabled' : ''
          } aria-label="${esc(item.title)} 执行策略" />
          <span class="track"></span>
          <span class="set-risk-state">${locked ? '强制人工审批' : item.auto ? '自动执行' : '需人工审批'}</span>
        </label>
      </div>
    </section>`;
  }

  function riskPanel() {
    const items = S.riskPolicy || [];
    return `<div class="set-panel is-hidden" data-panel="risk">
      ${
        items.length
          ? `<div class="set-risk-grid">${items.map(riskCard).join('')}</div>`
          : `<div class="empty"><div class="empty-title">风控配置读取失败</div><div class="empty-desc">请检查 /api/settings/risk 是否可达。</div></div>`
      }
      <div class="set-note">
        <span class="set-note-ico">${ui.icon('shield', 16)}</span>
        <span><strong>服务端不自动批准 HITL：</strong>不可逆操作由服务端强制挂起人工审批，Agent 无法自行重试或跳过；
        该等级开关已锁定，即使数据库被手工修改也不会放行。L1 / L2 可配置为「需人工审批」以加严管控，保存后立即生效。</span>
      </div>
    </div>`;
  }

  /* ------------------------------ 环境与网络配置 ------------------------------ */
  function envRows() {
    const items = S.environment || [];
    if (!items.length) {
      return `<div class="empty"><div class="empty-title">环境信息读取失败</div><div class="empty-desc">请检查 /api/settings/environment 是否可达。</div></div>`;
    }
    return items
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
    return (S.toggles || [])
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
              <div class="card-sub">本机真实运行参数（只读，来自 IConfiguration）</div>
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

  /* ------------------------------ 弹窗 / 表单辅助 ------------------------------ */
  function field(overlay, name) {
    const el = overlay.querySelector(`[data-f="${name}"]`);
    return el ? String(el.value || '').trim() : '';
  }

  function openProviderModal(provider, toast) {
    const body = `<div class="set-form">
        <label class="field">
          <span class="field-label">供应商名称</span>
          ${ui.input({ value: provider.name, attrs: 'data-f="name"' })}
        </label>
        <label class="field">
          <span class="field-label">Base URL</span>
          ${ui.input({ value: provider.baseUrl, attrs: 'data-f="baseUrl"' })}
        </label>
        <label class="field">
          <span class="field-label">API Key</span>
          ${ui.input({ type: 'password', placeholder: 'sk-...（留空则不修改已保存的 Key）', attrs: 'data-f="apiKey"' })}
        </label>
        <div class="field-hint">${esc(provider.keyNote || '密文落库，界面仅回显「头4+掩码+尾4」；留空表示保持原 Key 不变。')}</div>
        <label class="field">
          <span class="field-label">启用状态</span>
          ${ui.switchControl({ checked: provider.enabled !== false, attrs: 'data-f="enabled"' })}
        </label>
      </div>`;

    const overlay = ui.modal({
      title: `编辑供应商 · ${esc(provider.name)}`,
      desc: '保存后立即生效，模型通道会按新配置热切换。',
      body,
      actions: `${ui.btn({ label: '取消', tone: 'ghost', attrs: 'data-modal-close' })}${ui.btn({
        label: '保存',
        tone: 'primary',
        attrs: 'data-set-form-ok',
      })}`,
    });

    overlay.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-set-form-ok]')) return;
      const enabledEl = overlay.querySelector('[data-f="enabled"]');
      const apiKey = field(overlay, 'apiKey');
      const body = {
        name: field(overlay, 'name'),
        baseUrl: field(overlay, 'baseUrl'),
        enabled: enabledEl ? !!enabledEl.checked : undefined,
      };
      // 仅当用户输入了 Key 才随编辑一起提交，避免空串误清空已保存 Key。
      if (apiKey) body.apiKey = apiKey;
      const res = await call(
        'PUT',
        `/api/llm/providers/${pathId(provider.id)}`,
        body,
        toast,
        '供应商配置已更新'
      );
      if (res && res.ok) overlay.close();
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
      if (res && res.ok) overlay.close();
    });
  }

  /** 支持模型管理入口：按供应商维护可调用的模型 ID。 */
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
        renderList();
        return;
      }

      const del = e.target.closest('[data-model-del]');
      if (del) {
        const modelId = del.dataset.modelDel;
        await call(
          'DELETE',
          `/api/llm/providers/${pathId(pid)}/models?modelId=${pathId(modelId)}`,
          null,
          toast,
          `模型已删除：${modelId}`
        );
        renderList();
      }
    });
  }

  /* ------------------------------ 页面注册 ------------------------------ */
  pages.settings = {
    title: '系统设置',
    subtitle: '',
    actions: '',

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
        </div>
        ${modelsPanel()}
        ${riskPanel()}
        ${networkPanel()}
      </div>`;
    },

    mount(root, ctx) {
      const toast = ctx.toast;

      /* 首屏预取可能稍慢（用户秒进设置页）：模型配置缺失时补取一次；
         风控 / 环境两块若为空也补取，避免停留在空态。 */
      if (WB.api && WB.api.available()) {
        if (!S.providers || !S.providers.length) {
          WB.api.request('GET', '/api/llm/settings')
            .then(function (res) {
              if (res.ok) applySnapshot(res.data);
            })
            .catch(function () {});
        }
        if (!(S.riskPolicy || []).length || !(S.environment || []).length) {
          Promise.resolve(WB.api.refreshSettings()).then(() => {
            if ((S.riskPolicy || []).length) WB.go('settings');
          });
        }
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

      /* ---------- 供应商卡：编辑（含 API Key）/ 删除 / 模型管理 ---------- */
      ui.bind(root, '[data-set-edit]', 'click', (e) => {
        const provider = findProvider(e.currentTarget.dataset.setEdit);
        if (provider) openProviderModal(provider, toast);
      });

      ui.bind(root, '[data-set-delete]', 'click', async (e) => {
        const id = e.currentTarget.dataset.setDelete;
        const provider = findProvider(id);
        const ok = await ui.confirm({
          title: '删除供应商',
          desc: `将删除「${provider ? provider.name : id}」及其支持模型，且不可恢复。`,
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

      /* ---------- 风控开关：真实写库，保存后立即影响工具审批判定 ---------- */
      ui.bind(root, '[data-risk-toggle]', 'change', async (e) => {
        const input = e.currentTarget;
        const id = input.dataset.riskToggle;
        const item = (S.riskPolicy || []).find((r) => r.id === id);
        const state = input.closest('.switch');
        const label = state && state.querySelector('.set-risk-state');
        const want = input.checked;

        if (label) label.textContent = want ? '自动执行' : '需人工审批';
        input.disabled = true;

        const res = await WB.api.request('PUT', '/api/settings/risk/' + encodeURIComponent(id), { auto: want });

        input.disabled = false;

        if (!res.ok) {
          // 回滚界面到真实值，不做「假成功」
          input.checked = !want;
          if (label) label.textContent = !want ? '自动执行' : '需人工审批';
          toast('保存失败：' + (res.error || '服务未连接'), 'warn');
          return;
        }

        await WB.api.refreshSettings();
        toast(
          `${item ? `${item.level} ${item.title}` : '风控策略'} 已保存为「${want ? '自动执行' : '需人工审批'}」`,
          want ? 'success' : 'info'
        );
      });

      /* ---------- 环境开关：真实写库 ---------- */
      ui.bind(root, '[data-toggle]', 'change', async (e) => {
        const input = e.currentTarget;
        const id = input.dataset.toggle;
        const item = (S.toggles || []).find((t) => t.id === id);
        const want = input.checked;

        input.disabled = true;
        const res = await WB.api.request('PUT', '/api/settings/environment/' + encodeURIComponent(id), {
          checked: want,
        });
        input.disabled = false;

        if (!res.ok) {
          input.checked = !want;
          toast('保存失败：' + (res.error || '服务未连接'), 'warn');
          return;
        }

        await WB.api.refreshSettings();
        const tip = res.data && res.data.effective ? '（' + res.data.effective + '）' : '';
        toast(`${item ? item.label : '配置项'}：已${want ? '开启' : '关闭'}${tip}`, want ? 'success' : 'info');
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
