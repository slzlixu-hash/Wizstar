# 架构说明 · AgentWorkBench Desktop UI（Electron 纯界面）

> 本阶段目标只有一个：把 5 张设计稿还原成可运行的 Electron 桌面界面。
> **不接后端、不写业务逻辑、不引入构建链**——所有数据来自 `renderer/js/mock-data.js`，
> 所有交互都是本地演示（切页 / 切 tab / 过滤 / 开关 / toast / 抽屉 / 模拟登录）。

## 1. 进程与窗口模型

```
main process (electron/main.js)
├── loginWindow  1180×720  min 980×620   renderer/login.html   （首次启动即显示）
└── mainWindow   1440×920  min 1200×760  renderer/index.html   （登录成功后显示）
        │
        └── renderer (sandbox: true, contextIsolation: true, nodeIntegration: false)
                └── preload.js → contextBridge → window.workbench
```

- 两个窗口都是 `frame: false` + `backgroundColor: #060a13`，标题栏、最小化/最大化/关闭按钮全部自绘。
- `ready-to-show` 后才 `show()`，避免白屏闪烁。
- 单页面结构：主窗口内的 7 个「页面」是同一个 `index.html` 里由哈希路由切换的视图，不是多窗口。
- 退出登录会销毁主窗口并重建登录窗口；所有窗口关闭后（非 macOS）进程退出。
- 安全边界：`will-navigate` 只允许 `file://`；`setWindowOpenHandler` 把 http(s) 外链交给系统浏览器并拒绝应用内打开。

## 2. IPC 契约（`preload.js` → `window.workbench`）

| 方法 | 主进程通道 | 行为 |
| --- | --- | --- |
| `workbench.minimize()` | `win:minimize` | 最小化当前窗口 |
| `workbench.toggleMaximize()` | `win:toggle-maximize` | 最大化 / 还原 |
| `workbench.close()` | `win:close` | 关闭当前窗口 |
| `workbench.login()` | `auth:login` | 打开主窗口，关闭登录窗口（演示：不校验账号密码） |
| `workbench.logout()` | `auth:logout` | 打开登录窗口，关闭主窗口 |
| `workbench.platform / versions` | — | 只读环境信息（展示用） |

渲染进程通过 `contextBridge.exposeInMainWorld('workbench', ...)` 拿到上述方法，页面脚本不直接接触 Node/Electron API。

## 3. 渲染层结构（无 bundler）

`renderer/index.html` 按固定顺序引入样式与脚本：

```
styles/tokens.css → styles/shell.css
styles/pages/{dashboard,agents,mcp,settings,placeholders}.css

js/icons.js → js/mock-data.js → js/components.js
js/pages/placeholders.js → dashboard.js → agents.js → mcp.js → settings.js
js/app.js
```

- 全部为普通 `<script>`（非 module），共享一个全局命名空间 `window.WB`：
  - `WB.icon(name,size,cls)` / `WB.brandLogo(size)` —— 内联 SVG 图标与品牌标识；
  - `WB.data` —— 演示数据（应用信息、6 个 Agent、工作台指标、MCP 插件、系统设置、占位页表格）；
  - `WB.ui` —— HTML 字符串组件库（卡片、按钮、表格、徽章、toast、modal、drawer…）；
  - `WB.pages` —— 页面注册表。
- `app.js` 负责外壳：渲染标题栏图标、侧边导航、窗口按钮事件、哈希路由（`#/<pageId>`，默认 `dashboard`）、
  页面头部/主体挂载、全局点击委托（`[data-nav] [data-go] [data-toast] [data-logout]`）。
  页面渲染抛错时降级为错误占位卡并 `console.error`，不会整屏白掉。
- 页面契约（详见 `CONTRACT.md`）：`WB.pages.<id> = { title, subtitle, actions, render(ctx), mount(root, ctx) }`，
  `ctx = { data, ui, id, go, toast, version }`。页面只返回 HTML 字符串 + 可选交互绑定，
  不允许改标题栏/侧栏，不允许写死业务数据。
- 登录页是独立文档 `renderer/login.html`（自绘标题栏 + 左侧品牌插画 + 右侧玻璃登录卡），
  只引自己的 `styles/login.css` 与 `js/login.js`；登录按钮调用 `window.workbench.login()`。

## 4. 资产

| 资产 | 生成方式 | 说明 |
| --- | --- | --- |
| `renderer/assets/app-icon.png` | `python scripts/gen_app_icon.py`（Pillow） | 256×256 应用图标，打包时使用 |
| `renderer/assets/avatars/*.svg` | `node scripts/gen-avatars.js` | 6 个 Agent 全息胸像，按 Agent id 命名 |
| `design-refs/ref-01..05` | 设计稿原图 | 视觉对照基准，不参与运行 |

头像/图标全部是仓库内文本或小图，不依赖网络与第三方图标库。

## 5. 启动与验收工具链

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

## 6. 与完整产品的关系

`D:\WorkCode\Wizstar` 是 .NET 后端 + Agent 运行时的正式工程。本目录只是它的桌面端界面壳：

- 现在：静态演示数据 + 本地交互，可独立运行、可截图验收；
- 之后：把 `WB.data` 换成 IPC/HTTP 数据源、把页面 `mount()` 里的演示交互换成真实命令，
  界面层与数据层即可解耦对接（`preload.js` 是唯一需要扩展的桥）。
