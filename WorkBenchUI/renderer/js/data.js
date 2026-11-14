'use strict';

/**
 * 数据骨架（**不含任何业务数据**）。
 *
 * 本文件只定义 `WB.data` 的结构与产品元信息，所有业务值一律由 `api-client.js`
 * 在启动时从真实后端接口填充：
 *   - agents / team / dashboard / mcp / products / orders / shops 初始为空集合
 *   - app.version / endpoint / globalModel 由 `/api/ui/bootstrap` 与 `/api/llm/settings` 覆盖
 *   - source = 'loading' | 'live' | 'offline'，由数据层根据真实请求结果置位
 *
 * 页面只读 WB.data，不在页内硬编码业务数据；数据为空时页面必须渲染真实空态，
 * 不允许回退到任何内置示例值（历史 mock-data.js 已删除）。
 */
(function () {
  const WB = (window.WB = window.WB || {});

  WB.data = {
    /* 产品元信息（非业务数据）+ 运行时状态（由数据层填充） */
    app: {
      brand: '商品汇商',
      product: 'AgentWorkBench',
      platform: '智多星电商智能体协同平台',
      tagline: '多智能体协同 · 驱动矩阵电商全自动闭环',
      version: '—',
      endpoint: '127.0.0.1:5301',
      // 登录后由主进程切换窗口；账号信息不进渲染层静态数据
      user: { name: '本机管理员', role: '已登录', initial: '本' },
      globalModel: '',
      globalModelLabel: '',
      globalModels: [],
      source: 'loading',
      error: null,
    },

    /* 导航结构（界面骨架，非业务数据） */
    nav: [
      { id: 'dashboard', label: '工作台', icon: 'home' },
      { id: 'products', label: '商品管理', icon: 'box' },
      { id: 'orders', label: '订单履约', icon: 'clipboard' },
      { id: 'shops', label: '店铺管理', icon: 'shop' },
      { id: 'agents', label: 'Agent 团队', icon: 'robot' },
      { id: 'mcp', label: 'MCP 插件', icon: 'plugin' },
      { id: 'settings', label: '系统设置', icon: 'settings' },
    ],

    /* 业务数据：初始空，全部由接口填充 */
    agents: [],
    team: { stats: [] },
    dashboard: { kpis: [], pipeline: [], tasks: [] },
    mcp: { stats: [], servers: [] },
    settings: {
      providers: [],
      modelOptions: [],
      modelMapping: [],
      riskPolicy: [],
      environment: [],
      toggles: [],
    },
    products: { stats: [], rows: [] },
    orders: { stats: [], rows: [] },
    shops: { stats: [], rows: [] },

    /* 数据来源标记，供页面决定渲染空态 / 错误态 */
    bootstrap: null,
    llm: null,
    llmSource: 'loading',
    llmError: null,
    mcpSource: 'loading',
    businessSource: 'loading',
    settingsSource: 'loading',
  };
})();
