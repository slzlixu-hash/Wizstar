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

  // ① 同步修正：login.js / app.js 在本文件之后加载，能直接读到正确端口
  if (data && data.app) {
    data.app.endpoint = API_ENDPOINT;
    data.app.source = 'demo';
  }

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
      return;
    }

    Promise.resolve()
      .then(function () { return bridge.apiGet(BOOTSTRAP_PATH); })
      .then(function (res) {
        const env = res && res.ok ? res.body : null;
        if (!env || env.success !== true || !env.data) {
          markDemo();
          return;
        }
        try {
          applyBootstrap(env.data);
          markLive();
          refresh();
        } catch (_) {
          markDemo();
        }
      })
      .catch(function () { markDemo(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
