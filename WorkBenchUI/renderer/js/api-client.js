'use strict';

/**
 * 前端数据层（唯一数据来源，**无演示回退**）。
 *
 * 职责：
 *  1. 同步修正 WB.data.app.endpoint，让随后加载的 login.js / app.js 拿到真实地址；
 *  2. DOMContentLoaded 后并行拉取全部真实接口，一次性构建 WB.data；
 *  3. 任一接口失败 → 该部分置空并记录错误，页面渲染真实空态 / 错误态；
 *     bootstrap 失败视为后端不可用，整站进入离线态（带重试）；
 *  4. 提供统一请求通道 WB.api.request，供页面写操作复用。
 *
 * 约束：不产生 console.error（截图验收把 console 错误视为失败），不抛未捕获异常，
 * 不内置任何业务示例值——mock-data.js 已删除，`js/data.js` 只提供空骨架。
 */
(function () {
  const WB = window.WB || (window.WB = {});
  const data = WB.data || null;
  const bridge = window.workbench || null;

  const API_ENDPOINT = '127.0.0.1:5301';

  /* Agent 卡片配色：按名册顺序循环取色（纯视觉，不含业务语义）。 */
  const TONES = ['green', 'cyan', 'violet', 'amber', 'rose', 'blue'];

  const MCP_STATE_LABELS = {
    connected: '在线',
    connecting: '握手中',
    offline: '离线',
    error: '异常',
    disabled: '已停用',
  };

  if (data && data.app) {
    data.app.endpoint = API_ENDPOINT;
    data.app.source = 'loading';
  }

  /* ------------------------------ 请求层 ------------------------------ */

  /**
   * 统一读写通道。返回 { ok, data?, error?, status? }；
   * 任何异常都收敛成 { ok:false }，不 reject、不产生 console.error。
   */
  WB.api = {
    available: function () {
      return !!(bridge && typeof bridge.apiRequest === 'function');
    },
    request: async function (method, path, body) {
      if (!bridge || typeof bridge.apiRequest !== 'function') {
        return { ok: false, status: 0, error: 'API 未连接（Electron 桥接不可用）' };
      }
      try {
        const res = await bridge.apiRequest(method, path, body === undefined ? null : body);
        if (!res || !res.ok || !res.body || res.body.success !== true) {
          const envelopeError = res && res.body && res.body.error && res.body.error.message;
          return {
            ok: false,
            status: (res && res.status) || 0,
            error: envelopeError || (res && res.error) || '请求失败',
          };
        }
        return { ok: true, data: res.body.data, status: res.status };
      } catch (err) {
        return { ok: false, status: 0, error: String((err && err.message) || err || 'API 未连接') };
      }
    },
    applyLlm: function (snapshot) { applyLlmSettings(snapshot); },
    /** 离线态重试：重新拉取全部数据并重渲染。 */
    reload: function () { return loadAll(); },
  };

  /* ------------------------------ 状态标记 ------------------------------ */

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
    badge.style.color = tone === 'live' ? '#7ee2a8' : tone === 'loading' ? '#9fb4cc' : '#e5b567';
    badge.style.background =
      tone === 'live' ? 'rgba(46,160,96,.16)' : tone === 'loading' ? 'rgba(120,150,180,.14)' : 'rgba(220,160,60,.14)';
    badge.style.border =
      '1px solid ' + (tone === 'live' ? 'rgba(46,160,96,.35)' : tone === 'loading' ? 'rgba(120,150,180,.30)' : 'rgba(220,160,60,.30)');
  }

  function setServiceStatus(online) {
    const dot = document.querySelector('.status-dot');
    if (dot) dot.className = 'status-dot ' + (online ? 'online' : 'offline');

    const label = document.querySelector('.login-service > span:not(.login-endpoint)');
    if (label) label.textContent = online ? '本地服务连接正常' : '本地服务离线';

    const endpointEl = document.getElementById('login-endpoint');
    if (endpointEl) {
      endpointEl.textContent = '(' + ((data && data.app && data.app.endpoint) || API_ENDPOINT) + ')';
    }
  }

  /** 侧边栏运行模式文案：反映真实模型通道（chatMode），不再是静态「界面演示」。 */
  function setSidebarMode(text) {
    const el = document.getElementById('sidebar-mode');
    if (el) el.textContent = text || '';
  }

  function markLoading() {
    if (data && data.app) data.app.source = 'loading';
    setBadge('加载中', 'loading');
    setSidebarMode('连接中');
  }

  function markLive() {
    if (data && data.app) {
      data.app.source = 'live';
      data.app.error = null;
    }
    setBadge('实时', 'live');
    setServiceStatus(true);
    setSidebarMode(data && data.chatMode === 'live' ? '模型在线' : '模型离线');

    // 登录页 / 侧边栏都在数据层异步完成前就已渲染（骨架里是占位「—」），
    // 这里补一次真实版本号与端点，避免外壳静态文案停留在占位值。
    const version = data && data.app && data.app.version;
    if (version && version !== '—') {
      const loginVersion = document.getElementById('login-version');
      if (loginVersion) loginVersion.textContent = version;
      const sidebarVersion = document.getElementById('sidebar-version');
      if (sidebarVersion) sidebarVersion.textContent = version;
    }
    const endpoint = document.getElementById('sidebar-endpoint');
    if (endpoint && data && data.app && data.app.endpoint) {
      endpoint.textContent = data.app.endpoint;
    }
  }

  function markOffline(reason) {
    if (data && data.app) {
      data.app.source = 'offline';
      data.app.error = reason || '后端服务未连接';
    }
    setBadge('离线 · 后端未连接', 'offline');
    setServiceStatus(false);
    setSidebarMode('服务离线');
  }

  /* ------------------------------ 适配：Agent 名册 ------------------------------ */

  function adaptAgents(list) {
    return (Array.isArray(list) ? list : []).map(function (a, i) {
      const key = String(a.key || a.Key || 'agent-' + i);
      const tools = Array.isArray(a.allowedTools || a.AllowedTools) ? (a.allowedTools || a.AllowedTools) : [];
      const enabled = a.enabled !== false && a.Enabled !== false;
      const display = String(a.displayName || a.DisplayName || a.name || a.Name || key);
      const en = String(a.name || a.Name || key);
      // "*" 是通配授权：实际可见工具数取决于已连接的服务，静态不可知，界面单独表述
      const wildcard = tools.includes('*');

      return {
        id: key,
        name: display,
        en: en.charAt(0).toUpperCase() + en.slice(1),
        desc: String(a.description || a.Description || ''),
        status: enabled ? '待命中' : '已停用',
        tone: enabled ? TONES[i % TONES.length] : 'slate',
        dot: enabled ? 'online' : 'slate',
        mcp: wildcard
          ? '全部工具（通配授权 *）'
          : tools.length
            ? tools.join(' · ')
            : '未授权任何工具',
        wildcard: wildcard,
        rules: tools.length,
        todayLabel: '最大步数',
        today: Number(a.maxSteps || a.MaxSteps) || 0,
        load: null,
        online: enabled,
        avatar: true,
        photo: false,
      };
    });
  }

  /* ------------------------------ 适配：HITL 审批 → 工作台任务 ------------------------------ */

  function adaptApprovals(list, agents) {
    const nameOf = {};
    (agents || []).forEach(function (a) { nameOf[a.id] = a.name; });

    return (Array.isArray(list) ? list : []).map(function (a) {
      const agentKey = String(a.agentKey || a.AgentKey || '');
      const risk = String(a.risk || a.Risk || '');
      const created = a.createdAt || a.CreatedAt;
      const id = String(a.id || a.Id || '');
      const time = created ? String(created).slice(11, 16) : '—';
      const toolName = String(a.toolName || a.ToolName || '');

      return {
        id: id.slice(0, 8),
        approvalId: id,
        operationId: String(a.operationId || a.OperationId || ''),
        source: nameOf[agentKey] || agentKey || '未知 Agent',
        desc: '调用工具 ' + (toolName || '—') + '：' + (String(a.argumentsJson || a.ArgumentsJson || '{}').slice(0, 120)),
        time: time,
        type: risk === 'irreversible' ? '不可逆操作' : risk === 'write' ? '写操作' : '只读复核',
        status: String(a.status || a.Status || 'pending'),
      };
    });
  }

  /* ------------------------------ 适配：MCP ------------------------------ */

  function mcpStateLabel(state) {
    return MCP_STATE_LABELS[String(state || '').toLowerCase()] || String(state || '未知状态');
  }

  function mcpToolsOf(tools, id) {
    return (Array.isArray(tools) ? tools : []).filter(function (t) {
      return String((t && (t.serverId || t.ServerId)) || '') === String(id);
    });
  }

  /** 后端 McpServiceSnapshot + ToolDescriptor[] → MCP 页卡片形状。 */
  function mcpCard(rs, tools) {
    const id = String((rs && (rs.id || rs.Id)) || 'unknown');
    const state = String((rs && (rs.state || rs.State)) || 'offline').toLowerCase();
    const online = state === 'connected';
    const own = mcpToolsOf(tools, id);
    const toolCount = Number(rs && (rs.toolCount || rs.ToolCount)) || own.length;
    const risky = own.some(function (t) {
      const r = String((t && (t.declaredRisk || t.DeclaredRisk)) || '').toLowerCase();
      return r === 'write' || r === 'irreversible';
    });
    const serverName = String((rs && (rs.serverName || rs.ServerName)) || '');
    const serverVersion = String((rs && (rs.serverVersion || rs.ServerVersion)) || '');
    const protocol = String((rs && (rs.protocolVersion || rs.ProtocolVersion)) || '');
    const lastError = String((rs && (rs.lastError || rs.LastError)) || '');
    const url = String((rs && (rs.url || rs.Url)) || '');
    // 服务级启动握手开关：false 是有效值，不能用 || 兜底
    const autoStart = !!(rs && (rs.autoStart !== undefined ? rs.autoStart : rs.AutoStart));
    // HMAC 凭证：keyId 可回显，secret 只暴露「是否已配置」（明文永不下发）
    const authKeyId = String((rs && (rs.authKeyId || rs.AuthKeyId)) || '');
    const hasAuthSecret = !!(rs && (rs.hasAuthSecret !== undefined ? rs.hasAuthSecret : rs.HasAuthSecret));
    // 四档鉴权模式：none / bearer / header / hmac
    const authType = String((rs && (rs.authType || rs.AuthType)) || 'none').toLowerCase();
    const authHeaderName = String((rs && (rs.authHeaderName || rs.AuthHeaderName)) || '');
    // 内置/外部：清单 builtin 标记（内置可改不可删，外部全 CRUD）
    const builtin = !!(rs && (rs.builtin !== undefined ? rs.builtin : rs.Builtin));

    const meta = own.map(function (t) {
      return {
        name: String((t && (t.name || t.Name)) || ''),
        risk: String((t && (t.declaredRisk || t.DeclaredRisk)) || ''),
        description: String((t && (t.description || t.Description)) || ''),
        schema: String((t && (t.inputSchemaJson || t.InputSchemaJson)) || ''),
      };
    }).filter(function (t) { return t.name; });

    const logLines = ['{', '  "method": "tools/list",', '  "server": ' + JSON.stringify(id) + ',', '  "tools": ['];
    meta.forEach(function (t, i) {
      logLines.push('    ' + JSON.stringify({ name: t.name, risk: t.risk || null, description: t.description }) +
        (i < meta.length - 1 ? ',' : ''));
    });
    logLines.push('  ]', '}');

    return {
      id: id,
      name: String((rs && (rs.name || rs.Name)) || id),
      slug: id,
      url: url,
      online: online,
      state: state,
      stateLabel: mcpStateLabel(state),
      autoStart: autoStart,
      authKeyId: authKeyId,
      hasAuthSecret: hasAuthSecret,
      authType: authType,
      authHeaderName: authHeaderName,
      authLabel: ({ none: '免鉴权', bearer: 'Bearer Key', header: '自定义 Header', hmac: 'MCP-HMAC' })[authType] || authType,
      builtin: builtin,
      transport: url || (String((rs && (rs.transport || rs.Transport)) || 'http').toUpperCase()),
      transportType: state === 'disabled' ? 'pending' : 'http',
      tools: online ? '已连接 · ' + toolCount + ' 个工具' : mcpStateLabel(state),
      toolsCount: toolCount,
      bind: serverName || '平台声明式注册',
      risk: risky ? '含写操作 (HITL)' : '只读 (Read)',
      riskTone: risky ? 'amber' : 'green',
      health: lastError || (online ? '正常' : mcpStateLabel(state)),
      note: [serverName, serverVersion, protocol].filter(Boolean).join(' · ') || '来自 /api/mcp/servers',
      protocolVersion: protocol,
      serverVersion: serverVersion,
      connectedAt: (rs && (rs.connectedAt || rs.ConnectedAt)) || null,
      toolsFetchedAt: (rs && (rs.toolsFetchedAt || rs.ToolsFetchedAt)) || null,
      lastError: lastError,
      toolsMeta: meta,
      toolNames: meta.map(function (t) { return t.name; }),
      log: logLines.map(function (line) { return [line]; }),
      live: true,
    };
  }

  /** 真实清单整体替换 + 重算 4 张统计卡。 */
  function applyMcpLive(servers, tools) {
    if (!data) return [];
    const cards = (Array.isArray(servers) ? servers : []).map(function (rs) { return mcpCard(rs, tools); });
    const connected = cards.filter(function (c) { return c.online; }).length;

    data.mcp.servers = cards;
    data.mcp.stats = [
      { label: '已登记插件', value: String(cards.length), unit: '个', tone: 'cyan' },
      { label: '握手在线', value: String(connected), unit: '个', tone: 'green' },
      { label: '异常 / 待接入', value: String(cards.length - connected), unit: '个', tone: 'amber' },
      { label: '可用工具', value: String((Array.isArray(tools) ? tools : []).length), unit: '个', tone: 'violet' },
    ];
    data.mcpSource = 'live';
    return cards;
  }

  /** MCP 数据层（页面写操作复用）。 */
  WB.api.mcp = {
    isLive: function () {
      return !!(data && data.app && data.app.source === 'live' && WB.api.available());
    },
    load: async function () {
      const results = await Promise.all([
        WB.api.request('GET', '/api/mcp/servers'),
        WB.api.request('GET', '/api/mcp/tools'),
      ]);
      const sr = results[0];
      const tr = results[1];
      if (!sr.ok) return { ok: false, error: sr.error || '服务清单读取失败' };
      return {
        ok: true,
        servers: Array.isArray(sr.data) ? sr.data : [],
        tools: tr.ok && Array.isArray(tr.data) ? tr.data : [],
        toolsOk: !!tr.ok,
        toolsError: tr.ok ? null : (tr.error || '工具清单读取失败'),
      };
    },
    reconcile: function () { return WB.api.request('POST', '/api/mcp/reconcile', {}); },
    handshake: function (id) {
      return WB.api.request('POST', '/api/mcp/servers/' + encodeURIComponent(id) + '/handshake', {});
    },
    create: function (body) { return WB.api.request('POST', '/api/mcp/servers', body); },
    update: function (id, body) {
      return WB.api.request('PUT', '/api/mcp/servers/' + encodeURIComponent(id), body);
    },
    remove: function (id) {
      return WB.api.request('DELETE', '/api/mcp/servers/' + encodeURIComponent(id), null);
    },
    disconnect: function (id) {
      return WB.api.request('POST', '/api/mcp/servers/' + encodeURIComponent(id) + '/disconnect', {});
    },
    callTool: function (body) { return WB.api.request('POST', '/api/mcp/tools/call', body); },
    debugCurl: function (id, tool) {
      const q = tool ? '?tool=' + encodeURIComponent(tool) : '';
      return WB.api.request('GET', '/api/mcp/servers/' + encodeURIComponent(id) + '/debug-curl' + q);
    },
    apply: applyMcpLive,
    label: mcpStateLabel,
  };

  /* ------------------------------ 适配：模型与 API Key ------------------------------ */

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
        secondaryAction: '编辑供应商',
      };
    });

    S.modelOptions = Array.isArray(snapshot.modelOptions) ? snapshot.modelOptions.slice() : [];
    S.modelMapping = (Array.isArray(snapshot.bindings) ? snapshot.bindings : []).map(function (b) {
      return {
        agentId: b.agentId,
        label: b.label || b.agentId,
        model: b.model || snapshot.defaultModel || '',
        live: true,
      };
    });

    if (data.app) {
      data.app.globalModels = S.modelOptions.slice();
      data.app.globalModel = snapshot.defaultModel || (S.modelOptions[0] || '');
      data.app.globalModelLabel = data.app.globalModel ? '默认全局模型：' + data.app.globalModel : '';
    }

    data.llm = snapshot;
    data.llmSource = 'live';
    data.llmError = null;
  }

  /* ------------------------------ 适配：业务域 ------------------------------ */

  function applyBusiness(key, payload) {
    if (!data || !data[key] || !payload) return;
    data[key].stats = Array.isArray(payload.stats) ? payload.stats : [];
    data[key].rows = Array.isArray(payload.rows) ? payload.rows : [];
  }

  /* ------------------------------ 适配：设置（风控 / 环境） ------------------------------ */

  function applyRisk(payload) {
    if (!data || !data.settings || !payload) return;
    data.settings.riskPolicy = (Array.isArray(payload.riskPolicy) ? payload.riskPolicy : []).map(function (r) {
      return {
        id: r.id,
        title: r.title,
        level: r.level,
        tone: r.tone,
        desc: r.desc,
        auto: !!r.auto,
        locked: !!r.locked,
      };
    });
    data.settingsSource = 'live';
  }

  function applyEnvironment(payload) {
    if (!data || !data.settings || !payload) return;
    data.settings.environment = Array.isArray(payload.environment) ? payload.environment : [];
    data.settings.toggles = (Array.isArray(payload.toggles) ? payload.toggles : []).map(function (t) {
      return { id: t.id, label: t.label, desc: t.desc, checked: !!t.checked, realTime: !!t.realTime };
    });
    data.settingsSource = 'live';
  }

  /* ------------------------------ 适配：工作台 ------------------------------ */

  function applyDashboard(payload, agents, tasks) {
    if (!data || !payload) return;
    data.dashboard.kpis = Array.isArray(payload.kpis) ? payload.kpis : [];
    data.dashboard.pipeline = Array.isArray(payload.pipeline) ? payload.pipeline : [];
    data.dashboard.tasks = adaptApprovals(tasks, agents);
  }

  function applyTeamStats(payload) {
    if (!data || !payload) return;
    data.team.stats = Array.isArray(payload.stats) ? payload.stats : [];
  }

  /* ------------------------------ 重渲染 ------------------------------ */

  function refresh() {
    if (!document.getElementById('page-body')) return;
    if (typeof WB.go === 'function') {
      const id = (location.hash || '').replace(/^#\/?/, '').split('?')[0] || 'dashboard';
      WB.go(WB.pages && WB.pages[id] ? id : 'dashboard');
    } else {
      window.dispatchEvent(new Event('hashchange'));
    }
  }

  /* ------------------------------ 全量加载 ------------------------------ */

  async function loadAll() {
    if (!data) return;

    if (!WB.api.available()) {
      markOffline('Electron 桥接不可用（请通过桌面端启动）');
      refresh();
      return;
    }

    markLoading();

    const req = WB.api.request;
    const results = await Promise.all([
      req('GET', '/api/ui/bootstrap'),
      req('GET', '/api/llm/settings'),
      req('GET', '/api/mcp/servers'),
      req('GET', '/api/mcp/tools'),
      req('GET', '/api/business/dashboard'),
      req('GET', '/api/business/products'),
      req('GET', '/api/business/orders'),
      req('GET', '/api/business/shops'),
      req('GET', '/api/settings/risk'),
      req('GET', '/api/settings/environment'),
      req('GET', '/api/agents/stats'),
      req('GET', '/api/approvals?status=pending&limit=20'),
    ]);

    const boot = results[0];

    // bootstrap 是唯一「后端可用」的判据：失败即整站离线，不展示任何伪造数据
    if (!boot.ok || !boot.data) {
      markOffline(boot.error || '/api/ui/bootstrap 无响应');
      refresh();
      return;
    }

    data.bootstrap = boot.data;
    if (boot.data.endpoint && data.app) data.app.endpoint = boot.data.endpoint;
    if (boot.data.version && data.app) data.app.version = boot.data.version;

    data.agents = adaptAgents(boot.data.agents);
    const chatMode = String(boot.data.chatMode || 'offline');
    data.chatMode = chatMode;
    data.chatOfflineReason = boot.data.chatOfflineReason || null;

    // 模型配置
    const llm = results[1];
    if (llm.ok) {
      applyLlmSettings(llm.data);
    } else {
      data.llmSource = 'error';
      data.llmError = llm.error || '模型配置读取失败';
    }

    // MCP
    const mcpServers = results[2];
    const mcpTools = results[3];
    if (mcpServers.ok) {
      applyMcpLive(mcpServers.data, mcpTools.ok ? mcpTools.data : []);
    } else {
      // 单端点失败：保留空清单并标记 error，页面据此显示「清单读取失败」，不伪装在线
      data.mcp.servers = [];
      data.mcp.stats = [];
      data.mcpSource = 'error';
      data.mcpError = mcpServers.error || 'MCP 服务清单读取失败';
    }

    // 业务域
    const [dash, prod, ord, shop] = results.slice(4, 8);
    const approvals = results[11];
    applyDashboard(dash.ok ? dash.data : null, data.agents, approvals.ok ? approvals.data : []);
    data.businessSource = dash.ok && prod.ok && ord.ok && shop.ok ? 'live' : 'error';
    if (prod.ok) applyBusiness('products', prod.data);
    if (ord.ok) applyBusiness('orders', ord.data);
    if (shop.ok) applyBusiness('shops', shop.data);

    // 设置：风控 / 环境
    const risk = results[8];
    const env = results[9];
    if (risk.ok) applyRisk(risk.data);
    if (env.ok) applyEnvironment(env.data);
    if (!risk.ok && !env.ok) data.settingsSource = 'error';

    // Agent 团队统计
    const team = results[10];
    if (team.ok) applyTeamStats(team.data);

    markLive();
    refresh();
  }

  /** 供页面写操作后局部刷新（例如保存风控后重取该 Tab 数据）。 */
  WB.api.refreshSettings = async function () {
    const results = await Promise.all([
      WB.api.request('GET', '/api/settings/risk'),
      WB.api.request('GET', '/api/settings/environment'),
    ]);
    if (results[0].ok) applyRisk(results[0].data);
    if (results[1].ok) applyEnvironment(results[1].data);
  };

  WB.api.refreshBusiness = async function (key) {
    const res = await WB.api.request('GET', '/api/business/' + key);
    if (res.ok) applyBusiness(key, res.data);
    return res;
  };

  /* ------------------------------ 启动 ------------------------------ */

  function start() {
    loadAll().catch(function (err) {
      markOffline(String((err && err.message) || err || '加载失败'));
      refresh();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
