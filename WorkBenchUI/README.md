# AgentWorkBench · WorkBenchUI

智多星电商智能体协同平台（AgentWorkBench）的 **Electron 桌面端界面**。

当前阶段只做界面：**不接后端接口、不写业务逻辑**。所有数据来自本地演示数据，
所有交互都是前端演示（切页、切 tab、过滤、开关、toast、抽屉、模拟登录）。
视觉按 `design-refs/` 里的 5 张设计稿 1:1 还原。

![运营指挥工作台](artifacts/dashboard.png)

## 快速开始

环境要求：Windows + Node.js ≥ 18（无需 pnpm、无需全局 Electron）。
本仓库已内置 `node_modules/electron`，**不需要 `npm install`，也不依赖网络**。

```powershell
cd D:\WorkCode\Wizstar\WorkBenchUI
node scripts/start-electron.js          # 启动应用（先显示登录窗口）
```

登录页点击「立即登录」即进入主窗口（演示模式：任意账号密码都可通过）。

> 若终端里存在 `ELECTRON_RUN_AS_NODE=1`，electron.exe 会退化成纯 Node。
> `scripts/start-electron.js` 已在 spawn 时删除该变量；若你直接用 electron.exe 调试，请自行清除。

## 截图验收

```powershell
node scripts/start-electron.js --capture                      # 全部页面 → artifacts/*.png
node scripts/start-electron.js --capture --only=dashboard     # 单页
node scripts/start-electron.js --capture --only=agents,mcp    # 多页
```

产物：

- `artifacts/login.png`、`artifacts/dashboard.png`、`artifacts/products.png`、`artifacts/orders.png`、
  `artifacts/shops.png`、`artifacts/agents.png`、`artifacts/mcp.png`、`artifacts/settings.png`
- `artifacts/capture-report.json`（或 `capture-report-<pages>.json`）：逐页记录 console 错误、preload 错误、渲染进程崩溃；
  任一页报错时退出码为 1。

截图脚本会捕获标题栏/抽屉等全部自绘元素，可直接用于设计走查。

## 页面清单

| 路由 | 页面 | 说明 | 参考稿 |
| --- | --- | --- | --- |
| — | 登录窗口 | 品牌插画 + 玻璃登录卡 + 本地服务状态 | `ref-02-login.jpg` |
| `#/dashboard` | 运营指挥工作台 | 4 KPI、全链路智能体协同流、待处理高优先任务、6 Agent 实时负载 | `ref-03-dashboard.jpg` |
| `#/agents` | Agent 团队管理 | 团队统计条 + 3×2 Agent 卡（状态/MCP 工具/规则数/今日数据/操作） | `ref-04-agents.webp` |
| `#/mcp` | MCP 插件管理 | 插件统计、健康探测、插件卡网格、右侧调试抽屉（终端 JSON + 运行测试） | `ref-05-mcp.webp` |
| `#/settings` | 系统设置 | 模型与 API Key、全局业务风控、环境与网络配置三个 tab | `ref-01-settings.jpg` |
| `#/products` | 商品管理 | 占位页：统计卡 + 筛选 + 商品表 | 沿用同一设计语言 |
| `#/orders` | 订单履约 | 占位页：统计卡 + 筛选 + 订单表 | 同上 |
| `#/shops` | 店铺管理 | 占位页：统计卡 + 筛选 + 店铺表 | 同上 |

## 目录结构

```
WorkBenchUI/
├── electron/
│   ├── main.js            # 主进程：双窗口（登录 / 主窗）+ 窗口控制与登录切换 IPC
│   └── preload.js         # contextBridge → window.workbench
├── renderer/
│   ├── index.html         # 主窗口外壳：标题栏 / 侧边栏 / 页面容器
│   ├── login.html         # 登录窗口
│   ├── styles/
│   │   ├── tokens.css     # 设计令牌（颜色/尺寸/字体/动效/工具类）
│   │   ├── shell.css      # 外壳 + 通用组件样式
│   │   ├── login.css
│   │   └── pages/         # 每页专属样式
│   ├── js/
│   │   ├── icons.js       # 内联 SVG 图标库 + 品牌标识
│   │   ├── mock-data.js   # 演示数据（Agent / 工作台 / MCP / 设置 / 占位页）
│   │   ├── components.js  # WB.ui 组件库（返回 HTML 字符串）
│   │   ├── app.js         # 外壳渲染 + 哈希路由 + 全局事件委托
│   │   ├── login.js
│   │   └── pages/         # dashboard / agents / mcp / settings / placeholders
│   └── assets/            # 应用图标 + 6 个 Agent 头像（SVG）
├── scripts/
│   ├── start-electron.js  # 定位并启动本地 Electron
│   ├── capture.js         # 无头截图自检
│   ├── debug-render.js    # 空白页排查
│   ├── gen-avatars.js     # 生成 Agent 头像 SVG
│   └── gen_app_icon.py    # 生成应用图标 PNG
├── design-refs/           # 5 张设计参考稿
├── artifacts/             # 截图产物
├── CONTRACT.md            # 页面实现契约（新增页面必读）
├── DESIGN.md              # 设计规范（令牌 / 组件 / 动效）
├── ARCHITECTURE.md        # 架构说明（进程模型 / IPC / 渲染层）
└── package.json
```

## 技术约定

- **无构建链**：纯 HTML/CSS/JS，普通 `<script>` 顺序加载，共享 `window.WB` 命名空间。
- **无第三方依赖**：图标、插画、头像全部用内联 SVG / CSS 渐变生成，字体走系统字体栈。
- **无网络请求**：页面不 fetch、不连后端；演示数据集中在 `renderer/js/mock-data.js`。
- **安全默认**：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，
  渲染进程只通过 `window.workbench` 使用窗口控制；禁止应用内打开外部链接。

## 后续对接

界面层与数据层已解耦：

1. 把 `WB.data` 的静态数据换成 IPC / HTTP 拉取结果；
2. 在 `preload.js` 增加真实命令通道（或由渲染层调用本地 API `127.0.0.1:5210`）；
3. 把各页面 `mount()` 中的演示交互替换为真实提交动作。

详见 [ARCHITECTURE.md](ARCHITECTURE.md) 第 6 节。
