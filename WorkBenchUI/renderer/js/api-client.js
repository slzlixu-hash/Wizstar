'use strict';

/**
 * 前后端联调数据层（A1）。
 *
 * 职责：
 *  1. 同步修正 WB.data.app.endpoint，让随后加载的 login.js / app.js 拿到真实地址；
 *  2. DOMContentLoaded 后经 workbench.apiGet('/api/ui/bootstrap') 预取后端只读快照；
 *  3. 成功 → 拆统一信封 → 适配成 WB.data 现有形状 → 覆盖字段 → 触发重渲染；
 *  4. 失败 / 超时 / 无 Electron 桥接 → 完整保留 mock 演示数据，界面不白屏。
 *
 * 口径（见 WorkBenchUI/INTEGRATION.md）：真实数据覆盖对应字段，其余保留演示数据，
 * 由角标明确标注「部分演示数据」。mock-data.js 保持只读，不在本文件里被写入。
 *
 * 约束：本文件不产生 console.error（截图验收把 console 错误视为失败），不抛未捕获异常。
 */
(function () {
  const WB = window.WB || (window.WB = {});
  const data = WB.data || null;
  const bridge = window.workbench || null;

  const API_ENDPOINT = '127.0.0.1:5301';
  const BOOTSTRAP_PATH = '/api/ui/bootstrap';
  const LLM_SETTINGS_PATH = '/api/llm/settings';

  // 演示分派表快照：真实名册只有 2 个 Agent，按「真实覆盖 + 保留演示」口径，
  // 每次刷新都以这 6 行为基底覆盖真实行，避免界面元素被真实数据越刷越少。
  const DEMO_MAPPING = (data && data.settings && Array.isArray(data.settings.modelMapping))
    ? data.settings.modelMapping.map(function (r) { return Object.assign({}, r); })
    : [];

  // ① 同步修正：login.js / app.js 在本文件之后加载，能直接读到正确端口
  if (data && data.app) {
    data.app.endpoint = API_ENDPOINT;
    data.app.source = 'demo';
  }

  /* ------------------------------ 通用请求层（A2） ------------------------------ */
  /**
   * 统一读写通道。返回 { ok, data?, error? }；任何失败都收敛成 demo 降级信号，
   * 不 reject、不产生 console.error（截图验收把 console 错误视为失败）。
   */
  WB.api = {
    available: function () {
      return !!(bridge && typeof bridge.apiRequest === 'function');
    },
    // 复用同一套适配：写操作返回的快照可直接刷新设置页，无需二次 GET。
    applyLlm: function (snapshot) { applyLlmSettings(snapshot); },
    request: async function (method, path, body) {
      if (!bridge || typeof bridge.apiRequest !== 'function') {
        return { ok: false, status: 0, error: 'API 未连接', demo: true };
      }
      try {
        const res = await bridge.apiRequest(method, path, body === undefined ? null : body);
        if (!res || !res.ok || !res.body || res.body.success !== true) {
          const envelopeError = res && res.body && res.body.error && res.body.error.message;
          return {
            ok: false,
            status: (res && res.status) || 0,
            error: envelopeError || (res && res.error) || '请求失败',
            demo: true,
          };
        }
        return { ok: true, data: res.body.data, status: res.status };
      } catch (_) {
        return { ok: false, status: 0, error: 'API 未连接', demo: true };
      }
    },
  };

  /* ------------------------------ 界面标记 ------------------------------ */

  function setBadge(text, tone) {
    const anchor = document.getElementById('sidebar-version') || document.getElementById('login-endpoint');
    if (!anchor || !anchor.parentNode) return;

    let badge = document.getElementById('wb-data-source');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'wb-data-source';
      badge.style.cssText =
        'display:inline-block;margin-left:6px;font-size:10px;line-height:1.5;' +
        'padding:1px 6px;border-radius:4px;letter-spacing:.02em;vertical-align:middle;white-space:nowrap;';
      anchor.parentNode.insertBefore(badge, anchor.nextSibling);
    }
    badge.textContent = text;
    badge.style.color = tone === 'live' ? '#7ee2a8' : '#e5b567';
    badge.style.background = tone === 'live' ? 'rgba(46,160,96,.16)' : 'rgba(220,160,60,.14)';
    badge.style.border = '1px solid ' + (tone === 'live' ? 'rgba(46,160,96,.35)' : 'rgba(220,160,60,.30)');
  }

  function setServiceStatus(online) {
    const dot = document.querySelector('.status-dot');
    if (dot) dot.className = 'status-dot ' + (online ? 'online' : 'offline');

    // 登录页静态文案与状态灯保持一致（不改 HTML 结构）
    const label = document.querySelector('.login-service > span:not(.login-endpoint)');
    if (label) label.textContent = online ? '本地服务连接正常' : '本地服务离线';

    const endpointEl = document.getElementById('login-endpoint');
    if (endpointEl) {
      endpointEl.textContent = '(' + ((data && data.app && data.app.endpoint) || API_ENDPOINT) + ')';
    }
  }

  function markDemo() {
    if (data && data.app) data.app.source = 'demo';
    setBadge('演示 · API 未连接', 'demo');
    setServiceStatus(false);
  }

  function markLive() {
    if (data && data.app) data.app.source = 'live';
    setBadge('实时 · 部分演示', 'live');
    setServiceStatus(true);
  }

  /* ------------------------------ 数据适配 ------------------------------ */

  function applyAgentSnapshot(realAgents) {
    const list = (data && Array.isArray(data.agents)) ? data.agents : [];
    realAgents.forEach(function (real) {
      const target = list.find(function (a) { return a.id === real.key; });
      if (!target) return; // 不在演示名册里的真实 Agent 不新增，界面保持 6 卡布局

      target.name = real.displayName || real.name || target.name;
      target.desc = real.description || target.desc;
      target.online = real.enabled !== false;
      target.status = target.online ? '待命中' : '已停用';
      target.dot = target.online ? 'online' : 'slate';
      if (!target.online) target.tone = 'slate';
      if (Array.isArray(real.allowedTools)) {
        if (real.allowedTools.length) target.mcp = real.allowedTools.join(' · ');
        target.rules = real.allowedTools.length;
      }
      target.live = true;
    });
  }

  function applyMcpSnapshot(mcp) {
    if (!data || !data.mcp) return;

    const list = Array.isArray(data.mcp.servers) ? data.mcp.servers : [];
    const template = list[0] || null; // 借演示卡作基底，保证页面所需字段齐全
    const realServers = Array.isArray(mcp.servers) ? mcp.servers : [];
    const realTools = Array.isArray(mcp.tools) ? mcp.tools : [];

    realServers.forEach(function (rs) {
      const online = rs.state === 'connected';
      const toolCount = Number(rs.toolCount || rs.toolsCount) || 0;
      const patch = {
        id: rs.id || rs.serverId || 'unknown',
        name: rs.name || rs.id || '未命名服务',
        slug: rs.id || rs.serverId || 'unknown',
        online: online,
        transport: String(rs.transport || 'http').toUpperCase() + ' · 实时',
        tools: online ? '已连接 · ' + toolCount + ' 个工具' : (rs.state || '离线'),
        toolsCount: toolCount,
        bind: '实时接入',
        risk: '实时快照',
        riskTone: online ? 'green' : 'amber',
        health: online ? '正常' : (rs.lastError || rs.state || '离线'),
        note: rs.serverName ? String(rs.serverName + ' ' + (rs.serverVersion || '')).trim() : '来自 /api/ui/bootstrap',
        log: realTools.slice(0, 6).map(function (t) {
          return [JSON.stringify({ name: t.name, serverId: t.serverId, risk: t.declaredRisk || t.risk })];
        }),
        live: true,
      };

      const idx = list.findIndex(function (s) { return s.id === patch.id || s.slug === patch.slug; });
      if (idx >= 0) {
        list[idx] = Object.assign({}, list[idx], patch);
      } else {
        // 真实服务置顶，其余演示卡保留（口径：真实覆盖 + 保留演示）
        list.unshift(template ? Object.assign({}, template, patch) : patch);
      }
    });

    if (Array.isArray(data.mcp.stats) && data.mcp.stats.length >= 2) {
      data.mcp.stats[0].value = String(realServers.length);
      data.mcp.stats[1].value = String(Number(mcp.connected) || 0);
    }
  }

  function applyBootstrap(snapshot) {
    if (!data || !snapshot) return;
    data.bootstrap = snapshot;
    if (snapshot.endpoint) data.app.endpoint = snapshot.endpoint;
    if (Array.isArray(snapshot.agents)) applyAgentSnapshot(snapshot.agents);
    if (snapshot.mcp) applyMcpSnapshot(snapshot.mcp);
  }

  /**
   * 系统设置 → 模型与 API Key：真实配置覆盖 WB.data.settings 的对应字段（A2）。
   * 口径与 A1 一致：真实覆盖 + 保留演示（此处为整体字段替换，风控 / 环境 tab 仍是演示数据）。
   */
  function applyLlmSettings(snapshot) {
    if (!data || !data.settings || !snapshot) return;
    const S = data.settings;

    S.providers = (Array.isArray(snapshot.providers) ? snapshot.providers : []).map(function (p) {
      const ready = !!p.enabled && !!p.hasKey;
      return {
        id: p.code,
        name: p.name,
        builtin: !!p.isSeed,
        badge: {
          text: !p.enabled ? '已停用' : ready ? '已启用' : '待配置 Key',
          tone: ready ? 'green' : 'amber',
          dot: ready,
        },
        enabled: !!p.enabled,
        baseUrl: p.baseUrl || '',
        apiKey: p.apiKeyHint || '未配置',
        hasKey: !!p.hasKey,
        keyNote: '密文落库，仅在主动查看时取回明文',
        models: (Array.isArray(p.models) ? p.models : []).map(function (m) {
          return { id: m.id, name: m.name || m.id };
        }),
        primaryAction: '配置 API Key',
        secondaryAction: '编辑供应商',
      };
    });

    S.modelOptions = Array.isArray(snapshot.modelOptions) ? snapshot.modelOptions.slice() : [];
    const realBindings = Array.isArray(snapshot.bindings) ? snapshot.bindings : [];
    S.modelMapping = DEMO_MAPPING.map(function (row) {
      const real = realBindings.find(function (b) { return b.agentId === row.agentId; });
      if (!real) return Object.assign({}, row);
      return {
        agentId: row.agentId,
        label: real.label || row.label,
        model: real.model || snapshot.defaultModel || row.model,
        live: true,
      };
    });
    // 真实名册里出现、演示数据没有的 Agent 追加到末尾（不删任何演示行）。
    realBindings.forEach(function (b) {
      if (!S.modelMapping.some(function (r) { return r.agentId === b.agentId; })) {
        S.modelMapping.push({
          agentId: b.agentId,
          label: b.label || b.agentId,
          model: b.model || snapshot.defaultModel || (S.modelOptions[0] || ''),
          live: true,
        });
      }
    });

    if (data.app) {
      data.app.globalModels = S.modelOptions.slice();
      data.app.globalModel = snapshot.defaultModel || (S.modelOptions[0] || data.app.globalModel);
      data.app.globalModelLabel = '默认全局模型：' + data.app.globalModel;
    }

    data.llm = snapshot;
    data.llmSource = 'live';
  }

  /* ------------------------------ 重渲染 ------------------------------ */

  function refresh() {
    if (!document.getElementById('page-body')) return; // 登录页无需重渲染
    if (typeof WB.go === 'function') {
      const id = (location.hash || '').replace(/^#\/?/, '').split('?')[0] || 'dashboard';
      WB.go(WB.pages && WB.pages[id] ? id : 'dashboard');
    } else {
      window.dispatchEvent(new Event('hashchange'));
    }
  }

  /* ------------------------------ 启动探测 ------------------------------ */

  function start() {
    if (!bridge || typeof bridge.apiGet !== 'function') {
      markDemo();
      if (data) data.llmSource = 'demo';
      return;
    }

    // A1 bootstrap 与 A2 LLM 配置并行预取，都结束后再统一重渲染，避免设置页先渲染 mock 再被覆盖。
    Promise.all([
      Promise.resolve()
        .then(function () { return bridge.apiGet(BOOTSTRAP_PATH); })
        .catch(function () { return null; }),
      Promise.resolve()
        .then(function () { return WB.api.request('GET', LLM_SETTINGS_PATH); })
        .catch(function () { return { ok: false }; }),
    ])
      .then(function (results) {
        const bootstrapRes = results[0];
        const llmRes = results[1];
        let bootstrapLive = false;

        const env = bootstrapRes && bootstrapRes.ok ? bootstrapRes.body : null;
        if (env && env.success === true && env.data) {
          try {
            applyBootstrap(env.data);
            bootstrapLive = true;
          } catch (_) {
            bootstrapLive = false;
          }
        }

        if (llmRes && llmRes.ok) {
          try {
            applyLlmSettings(llmRes.data);
            if (data) data.llmError = null;
          } catch (err) {
            if (data) {
              data.llmSource = 'demo';
              data.llmError = String((err && err.message) || err);
            }
          }
        } else if (data) {
          data.llmSource = 'demo';
          data.llmError = llmRes ? llmRes.error || '请求失败' : '无响应';
        }

        if (bootstrapLive) markLive();
        else markDemo();

        if (bootstrapLive || (llmRes && llmRes.ok)) refresh();
      })
      .catch(function () {
        markDemo();
        if (data) data.llmSource = 'demo';
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
