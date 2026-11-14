# AgentWorkBench · WorkBenchUI

智多星电商智能体协同平台（AgentWorkBench）的 **Electron 桌面控制台**。

界面**无演示数据**：所有业务数字来自本机 `127.0.0.1:5301` 的 Wizstar.Api，
拿不到就渲染空态或离线重试页，不伪造、不回退演示值。视觉按 `design-refs/` 的 5 张设计稿还原。

![运营指挥工作台](artifacts/dashboard.png)

## 快速开始

环境要求：Windows + Node.js ≥ 18（无需 pnpm、无需全局 Electron）。
本仓库已内置 `node_modules/electron`，**不需要 `npm install`，也不依赖网络**。

```powershell
# 1) 先起后端（另开终端）
cd D:\WorkCode\Wizstar\src\Wizstar.Api
dotnet run --no-launch-profile --urls http://127.0.0.1:5301

# 2) 可选：抖店罗盘 MCP 服务（MCP 页要显示在线就得起）
cd D:\WorkCode\Wizstar\tools\mcp-douyin-compass
node server/index.js          # 5206

# 3) 启动界面
cd D:\WorkCode\Wizstar\WorkBenchUI
node scripts/start-electron.js
```

登录页点击「立即登录」即进入主窗口（本地会话，不做账号校验）。

> 后端没起时界面会进「服务离线」页并给出重试按钮，不会白屏也不会显示假数据。
>
> 若终端里存在 `ELECTRON_RUN_AS_NODE=1`，electron.exe 会退化成纯 Node。
> `scripts/start-electron.js` 已在 spawn 时删除该变量；若你直接用 electron.exe 调试，请自行清除。

## 截图验收

```powershell
node scripts/start-electron.js --capture                      # 全部页面 → artifacts/*.png
node scripts/start-electron.js --capture --only=dashboard     # 单页
node scripts/start-electron.js --capture --only=agents,mcp    # 多页
```

**截图前必须先起后端**，否则 8 页全部落到 `offline` 态。产物：

- `artifacts/login.png`、`artifacts/dashboard.png`、`artifacts/products.png`、`artifacts/orders.png`、
  `artifacts/shops.png`、`artifacts/agents.png`、`artifacts/mcp.png`、`artifacts/settings.png`
- `artifacts/capture-report.json`：逐页记录 console 错误、preload 错误、渲染进程崩溃；
  任一页报错时退出码为 1。

验收完**立刻停掉 `dotnet run`**——运行中的 Wizstar.Api 会独占
`bin\Debug\net10.0\Wizstar.*.dll`，在 Visual Studio 里编译会报 MSB3027「文件正由另一进程使用」。

## 页面清单

| 路由 | 页面 | 数据来源 |
| --- | --- | --- |
| — | 登录窗口 | bootstrap 状态灯 + 真实版本号 |
| `#/dashboard` | 运营指挥工作台 | `/api/business/dashboard` + `/api/approvals` + `/api/agents` |
| `#/products` | 商品管理 | `/api/business/products`（`sku_project` 等） |
| `#/orders` | 订单履约 | `/api/business/orders`（`ecom_order` 等） |
| `#/shops` | 店铺管理 | `/api/business/shops`（`store_instance`） |
| `#/agents` | Agent 团队管理 | `/api/agents` + `/api/agents/stats` + `/api/agents/{key}` |
| `#/mcp` | MCP 插件管理 | `/api/mcp/servers` + `/api/mcp/tools` |
| `#/settings` | 系统设置 | `/api/llm/*` + `/api/settings/risk` + `/api/settings/environment` |

## 目录结构

```
WorkBenchUI/
├── electron/
│   ├── main.js            # 主进程：双窗口 + 窗口控制 / 登录切换 IPC
│   ├── preload.js         # contextBridge → window.workbench
│   └── api-proxy.js       # 本地 API 代理（含回环绕过 HTTP_PROXY）
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
│   │   ├── data.js        # WB.data 空骨架（结构 + 纯元信息，零业务数据）
│   │   ├── api-client.js  # 唯一数据来源：12 路并行加载 + 写通道 + 三态状态机
│   │   ├── components.js  # WB.ui 组件库（返回 HTML 字符串）
│   │   ├── app.js         # 外壳渲染 + 哈希路由 + 三态分支 + 全局事件委托
│   │   ├── login.js
│   │   └── pages/         # dashboard / agents / mcp / settings / placeholders
│   └── assets/            # 应用图标 + Agent 头像（SVG）
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
├── ARCHITECTURE.md        # 架构说明（进程模型 / IPC / 数据通道 / 三态）
├── INTEGRATION.md         # 联调契约（端点清单 / 数据口径）
└── package.json
```

## 技术约定

- **无构建链**：纯 HTML/CSS/JS，普通 `<script>` 顺序加载，共享 `window.WB` 命名空间。
- **无第三方依赖**：图标、插画、头像全部用内联 SVG / CSS 渐变生成，字体走系统字体栈。
- **数据全部经主进程代理**：渲染进程 `sandbox: true` 不直接 fetch，统一走
  `WB.api.request → workbench.apiRequest → ipcMain('api:request') → api-proxy.js`。
  代理只放行 `/api/` 相对路径与 `GET/POST/PUT/DELETE`，并**绕过本机 HTTP_PROXY**
  （否则 127.0.0.1 请求会被转发成绝对地址，表现为 404 / 串服务）。
- **三态状态机**：`app.source ∈ {loading, live, offline}`，`app.js` 据此渲染骨架 / 真实页 / 离线重试页。
  bootstrap 是唯一的「后端可用」判据；单接口失败只清空对应区块。
- **安全默认**：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，
  渲染进程只通过 `window.workbench` 使用窗口控制；禁止应用内打开外部链接。

## 相关文档

- 接口与数据口径 → [INTEGRATION.md](INTEGRATION.md)
- 架构与进程模型 → [ARCHITECTURE.md](ARCHITECTURE.md)
- 页面实现契约 → [CONTRACT.md](CONTRACT.md)
- 设计规范 → [DESIGN.md](DESIGN.md)
