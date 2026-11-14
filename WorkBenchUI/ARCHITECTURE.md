# 架构说明 · AgentWorkBench Desktop UI（Electron + 本地 API）

> 本目录是 `D:\WorkCode\Wizstar`（.NET 后端 + Agent 运行时）的桌面端界面壳。
> 界面**没有任何演示数据**：所有业务数字来自本机 `127.0.0.1:5301` 的 Wizstar.Api，
> 拿不到就渲染空态或离线重试页，**不伪造、不回退演示值**。

## 1. 进程与窗口模型

```
main process (electron/main.js)
├── loginWindow  1180×720  min 980×620   renderer/login.html   （首次启动即显示）
└── mainWindow   1440×920  min 1200×760  renderer/index.html   （登录成功后显示）
        │
        ├── renderer (sandbox: true, contextIsolation: true, nodeIntegration: false)
        │       └── preload.js → contextBridge → window.workbench
        │
        └── api-proxy.js  → fetch http://127.0.0.1:5301
```

- 两个窗口都是 `frame: false` + `backgroundColor: #060a13`，标题栏、最小化/最大化/关闭按钮全部自绘。
- `ready-to-show` 后才 `show()`，避免白屏闪烁。
- 单页面结构：主窗口内的 8 个「页面」是同一个 `index.html` 里由哈希路由切换的视图，不是多窗口。
- 退出登录会销毁主窗口并重建登录窗口；所有窗口关闭后（非 macOS）进程退出。
- 安全边界：`will-navigate` 只允许 `file://`；`setWindowOpenHandler` 把 http(s) 外链交给系统浏览器并拒绝应用内打开。

## 2. IPC 契约（`preload.js` → `window.workbench`）

| 方法 | 主进程通道 | 行为 |
| --- | --- | --- |
| `workbench.minimize()` | `win:minimize` | 最小化当前窗口 |
| `workbench.toggleMaximize()` | `win:toggle-maximize` | 最大化 / 还原 |
| `workbench.close()` | `win:close` | 关闭当前窗口 |
| `workbench.login()` | `auth:login` | 打开主窗口，关闭登录窗口（本地会话，不做账号校验） |
| `workbench.logout()` | `auth:logout` | 打开登录窗口，关闭主窗口 |
| `workbench.apiRequest(method, path, body)` | `api:request` | 读写通道，见 §3 |
| `workbench.platform / versions` | — | 只读环境信息（展示用） |

渲染进程通过 `contextBridge.exposeInMainWorld('workbench', ...)` 拿到上述方法，页面脚本不直接接触 Node/Electron API。

## 3. 数据通道（`electron/api-proxy.js`）

渲染进程 `sandbox: true`，**不直接发网络请求**，全部经主进程代理：

```
页面 → WB.api.request(method, path, body)
     → window.workbench.apiRequest(...)
     → ipcMain.handle('api:request')
     → api-proxy.js: fetch(API_BASE + path)
     → 统一信封 { success, data, error, traceId }
```

- 只放行 `/api/` 开头的相对路径 + `GET/POST/PUT/DELETE`，拒绝 `..`、`\`、`://`。
- 超时：GET 2.5s，写操作 12s。
- 基址默认 `http://127.0.0.1:5301`，可用环境变量 `WIZSTAR_API_BASE` 覆盖。
- **本地回环绕过代理**：本机常驻 `HTTP_PROXY=127.0.0.1:xxxxx`，Node 的 `fetch` 会把 127.0.0.1 请求
  转成绝对地址转发给代理，表现为 404 / 串服务。`api-proxy.js` 显式 `proxy: undefined` 并绕过
  `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`。（.NET 侧对应 `Wizstar.Mcp/LoopbackBypassProxy`。）
- `apiRequest` **永不 reject**，失败返回 `{ ok: false, error }`；`WB.api.request` 再拆统一信封，
  收敛成 `{ ok, data?, error?, status? }`，页面据此决定成功 / 回滚 / 报错。

## 4. 渲染层结构（无 bundler）

`renderer/index.html` 按固定顺序引入样式与脚本：

```
styles/tokens.css → styles/shell.css
styles/pages/{dashboard,agents,mcp,settings,placeholders}.css

js/icons.js → js/data.js → js/api-client.js → js/components.js
js/pages/placeholders.js → dashboard.js → agents.js → mcp.js → settings.js
js/app.js
```

- 全部为普通 `<script>`（非 module），共享一个全局命名空间 `window.WB`：
  - `WB.icon(name,size,cls)` / `WB.brandLogo(size)` —— 内联 SVG 图标与品牌标识；
  - `WB.data` —— **空骨架**（见 §5），由 `api-client.js` 从真实快照填充；
  - `WB.api` —— 请求通道与刷新入口（`request / reload / refreshSettings / refreshBusiness / applyLlm / mcp.*`）；
  - `WB.ui` —— HTML 字符串组件库（卡片、按钮、表格、徽章、toast、modal、drawer…）；
  - `WB.pages` —— 页面注册表。
- `app.js` 负责外壳：渲染标题栏图标、侧边导航、窗口按钮事件、哈希路由（`#/<pageId>`，默认 `dashboard`）、
  页面头部/主体挂载、全局点击委托（`[data-nav] [data-go] [data-toast] [data-logout] [data-api-retry]`）。
  页面渲染抛错时降级为错误占位卡并 `console.error`，不会整屏白掉。
- 页面契约（详见 `CONTRACT.md`）：`WB.pages.<id> = { title, subtitle, actions, render(ctx), mount(root, ctx) }`，
  `ctx = { data, ui, id, go, toast, version }`。页面只返回 HTML 字符串 + 可选交互绑定，
  不允许改标题栏/侧栏，不允许写死业务数据。
- 登录页是独立文档 `renderer/login.html`（自绘标题栏 + 左侧品牌插画 + 右侧玻璃登录卡），
  只引自己的 `styles/login.css` 与 `js/login.js`；登录按钮调用 `window.workbench.login()`。

## 5. 数据层三态状态机（`js/api-client.js`）

`WB.data.app.source ∈ { loading, live, offline }`，`app.js` 的 `render()` 据此三分支：

| source | 触发 | 界面表现 |
| --- | --- | --- |
| `loading` | 首屏 / 重试中 | 骨架加载态，侧栏角标「加载中」、模式「连接中」 |
| `live` | `GET /api/ui/bootstrap` 成功 | 正常渲染真实页面，角标「实时」 |
| `offline` | bootstrap 失败 | `renderOffline(page)`：明确错误原因 + 重试按钮 |

- bootstrap 是**唯一**的「后端可用」判据；其余接口单个失败只清空对应区块，不整站下线。
- `loadAll()` 在 `DOMContentLoaded` 后并行拉 12 路（见 `INTEGRATION.md` §2），
  串成一份 `WB.data` 后 `markLive()` + 重渲染。
- `js/data.js` 只是**结构骨架**（`agents: []`、`dashboard.kpis: []`、`mcp.servers: []` 等），
  零业务数据；`nav`、`app.user`、`settings.modelOptions` 这类纯结构/元信息保留。

## 6. 资产

| 资产 | 生成方式 | 说明 |
| --- | --- | --- |
| `renderer/assets/app-icon.png` | `python scripts/gen_app_icon.py`（Pillow） | 256×256 应用图标，打包时使用 |
| `renderer/assets/avatars/*.svg` | `node scripts/gen-avatars.js` | Agent 全息胸像，按 Agent id 命名 |
| `design-refs/ref-01..05` | 设计稿原图 | 视觉对照基准，不参与运行 |

头像/图标全部是仓库内文本或小图，不依赖网络与第三方图标库。

## 7. 启动与验收工具链

| 脚本 | 用途 |
| --- | --- |
| `scripts/start-electron.js` | 定位本地 Electron 可执行文件并启动应用（`--capture` 转截图模式）。会显式删除 `ELECTRON_RUN_AS_NODE`，否则 electron.exe 退化成纯 Node |
| `scripts/capture.js` | Electron 主进程内截图：登录窗口 + 主窗口各页，输出 `artifacts/*.png` 与 `artifacts/capture-report*.json`；捕获 console error / preload error / 渲染进程崩溃，有错误则退出码 1 |
| `scripts/debug-render.js` | 临时诊断脚本：加载 index.html 并打印 `window.WB` 状态与脚本错误来源（排查空白页用） |

截图实现要点：

- 每个捕获窗口使用独立 `userData`（`os.tmpdir()/workbench-capture-<pid>`），避免实例锁，允许并行截图；
- 主窗口只创建一次，后续页面通过 `location.hash` 切换（与真实用户路径一致），
  避免「销毁窗口后立刻 load 新窗口」在 Windows 上偶发 `ERR_FAILED (-2)`；
- 用 `pathToFileURL(...).href + hash` 代替 `loadFile(..., { hash })`——后者在 Windows 上会拼出
  `file:///D:\...\index.html#/x` 混合分隔符地址而加载失败；
- 截图分辨率固定 1×（`force-device-scale-factor=1`），隐藏窗口但 `paintWhenInitiallyHidden: true`。

**截图前必须先起后端**（`dotnet run --no-launch-profile --urls http://127.0.0.1:5301`），
否则 8 页会全部落到 `offline` 态。验收完立刻停掉进程——运行中的 `Wizstar.Api` 会独占
`bin\Debug\net10.0\Wizstar.*.dll`，在 Visual Studio 里编译会报 MSB3027「文件正由另一进程使用」。

## 8. 与完整产品的关系

```
Wizstar.Api（127.0.0.1:5301）
├── /api/ui/bootstrap     聚合快照（health + agents + mcp + chatMode）
├── /api/agents/*         Agent 名册 / 统计 / 详情 / 对话
├── /api/approvals/*      HITL 审批队列与决策
├── /api/mcp/*            MCP 服务注册、握手、工具清单与只读调用
├── /api/llm/*            供应商 / 模型 / API Key / 默认模型 / 分派
├── /api/business/*       商品 / 订单 / 店铺 / 工作台 KPI（真实业务表）
├── /api/settings/*       风控策略 / 环境配置（sys_risk_policy KV）
└── /api/operations/*     幂等账本查询
```

界面层只消费上述端点，不直接连 MySQL、不直接调模型、不直接握手 MCP。
完整端点清单与写操作语义见 `INTEGRATION.md`。
