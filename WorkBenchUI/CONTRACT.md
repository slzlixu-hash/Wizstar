# WorkBenchUI 页面实现契约

本文件是页面实现的**唯一约定**。新增或修改页面前完整读一遍，严格按此实现。
接口与数据口径见 `INTEGRATION.md`，架构与进程模型见 `ARCHITECTURE.md`。

## 1. 目标与边界

- 目标：Electron + 原生 HTML/CSS/JS 实现智多星电商智能体协同平台的桌面控制台，视觉基准是 `design-refs/` 的 5 张设计稿。
- **全真实数据**：所有业务数字来自本机 `127.0.0.1:5301` 的 Wizstar.Api，**禁止演示兜底**。
  拿不到数据就渲染空态（文案写清来源表名 / 接口），不许填假数字假装有数据。
- 技术栈锁定：纯 HTML/CSS/JS，**无构建工具、无 npm 依赖、无框架**，Electron 45 通过 `file://` 加载。
  不得引入任何外部 CDN、字体、图片（离线环境）。
- 界面语言：简体中文。

## 2. 运行与自检

在 `D:\WorkCode\Wizstar\WorkBenchUI` 下执行：

```bat
node scripts/start-electron.js --capture --only=<pageId>
```

- `<pageId>` ∈ `login` / `dashboard` / `products` / `orders` / `shops` / `agents` / `mcp` / `settings`。
- 输出：`artifacts/<pageId>.png` + `artifacts/capture-report-<pageId>.json`。
- **截图前必须起后端**（`dotnet run --no-launch-profile --urls http://127.0.0.1:5301`），
  否则 8 页全部落到 `offline` 态，截到的是重试页而不是真实页面。
- 截图窗口 **1440×900**（login 为 1180×720），内容区宽度 = 1440 − 236 侧栏 − 64 内边距 ≈ **1140px**。按此宽度设计，不允许横向滚动。
- 报告里 `errors` 非空即失败（脚本退出码 1）。**页面里禁止 `console.error`**。

## 3. 文件职责

| 文件 | 职责 |
| --- | --- |
| `renderer/index.html` | 主窗外壳：标题栏 / 侧边栏 / `#page-body` 容器 |
| `renderer/js/icons.js` | 内联 SVG 图标库 + 品牌标识 |
| `renderer/js/data.js` | **空骨架**：`WB.data` 结构定义 + 纯元信息（`nav`、`app.user`、`modelOptions`），零业务数据 |
| `renderer/js/api-client.js` | 唯一数据来源：12 路并行加载 → 构建 `WB.data`；`WB.api.request` 写通道；三态状态机 |
| `renderer/js/components.js` | `WB.ui` 组件库（返回 HTML 字符串） |
| `renderer/js/app.js` | 外壳渲染 + 哈希路由 + 三态分支（loading / live / offline）+ 全局事件委托 |
| `renderer/js/pages/*.js` | 各页 `render` / `mount` |
| `renderer/styles/tokens.css`、`shell.css` | 设计令牌 + 外壳与通用组件 |
| `renderer/styles/pages/*.css` | 各页专属样式 |

- 公共样式/组件不够用时：**先在自己的页面 CSS 里加类**（统一前缀 `.dash-` `.team-` `.mcp-` `.set-` `.login-` `.biz-`），
  不要改公共文件；确需公共改动，在提交说明里写明。
- 不要新增第三方文件、不要 `npm install`、不要动 `node_modules`。

## 4. 页面注册契约

```js
'use strict';
(function () {
  const WB = window.WB;          // 必须取 window.WB
  const ui = WB.ui;              // 组件库
  const pages = (WB.pages = WB.pages || {});

  pages.dashboard = {
    title: '运营指挥工作台',        // 左上角大标题（纯文本）
    subtitle: '数据来自本机 API',    // 标题下方副标题，可含 HTML
    actions: '<HTML 字符串>',      // 右上角操作区（可空字符串）
    render(ctx) {
      // 返回页面主体 HTML 字符串；ctx = { data, ui, id, go, toast, version }
      return `<div class="stack">...</div>`;
    },
    mount(root, ctx) {
      // 可选：DOM 插入后绑定交互。root = #page-body
    },
  };
})();
```

- 页面主体根元素推荐 `<div class="stack">`（纵向 gap 18px）或 `<div class="grid ...">`。
- `ctx.data === WB.data`；`ctx.go('agents')` 跳页；`ctx.toast('文案', 'success')`。
- 禁止在页面里 `document.body.innerHTML = ...` 或改标题栏/侧栏。
- 页面 CSS 只写本页专属规则，不要重定义 `.card` `.btn` 等公共类整体样式（可用 `.dash-xxx .card` 局部覆盖）。

## 5. 公共组件（`WB.ui.*`，全部返回 HTML 字符串）

```js
ui.esc(v)                          // HTML 转义，所有插值必须用
ui.num(2840)                       // → "2,840"
ui.icon(name, size=18, cls='')     // 内联 SVG 图标
ui.badge(text, {tone, dot, cls})   // tone: green|cyan|blue|violet|amber|rose|slate
ui.chip(text, {icon, tone})        // 描边小胶囊
ui.tag(text)                       // 等宽小标签
ui.statusDot(kind, label)          // kind: online|cyan|amber|busy|offline
ui.avatar(entity, size)            // entity: {id,name,initial,photo:false,avatar}；size: sm|md|lg|xl
ui.userCluster(user)               // 右上角「齿轮 / 通知 / 用户胶囊」组
ui.btn({label, icon, tone, size, attrs, id, cls, block, caret})
//   tone: primary|gradient|ghost|outline|danger|link（空=默认）
//   size: sm|xs|lg|icon
ui.iconBtn(name, {title, dot, attrs})
ui.input({type, placeholder, value, attrs})
ui.select({options:[string|{value,label}], value, attrs})
ui.searchBox({placeholder, width, attrs})
ui.switchControl({label, checked, attrs})
ui.checkbox({label, checked, attrs})
ui.card({title, sub, actions, body, cls, id})
ui.statTile({label, value, unit, prefix, delta, deltaTone, meta, warn, icon})
ui.kv([['label', '值HTML'], ...])
ui.table({columns:[{label, key|render(row,i), width, align, cls}], rows, rowAttrs, empty})
ui.tabs([{id,label,icon}], activeId, 'data-tab')   // 返回 .tabs，选中类 .active
ui.segmented([{id,label}], activeId, 'data-seg')
ui.toast(text, 'success'|'info'|'warn'|'error')
ui.modal({title, desc, body, actions})             // 返回 overlay 元素（可 .remove()）
ui.confirm({title, desc, ok, cancel, tone})        // → Promise<boolean>
ui.bind(root, selector, event, handler)            // 批量绑定
```

图标名可用 `WB.iconNames` 查看，常用：`home box clipboard shop robot plugin settings plus close search filter bell chevron-down chevron-right arrow-right arrow-up-right check eye pencil key refresh shield lock user play power terminal wifi link alert trash chart image tag cart truck server globe database sparkles clock more more-vertical zap layers target download upload log-out info cpu wand route inbox command`。

可用的通用工具类（见 `tokens.css`）：`.row .col .between .wrap .grow`、`.gap-{2,4,6,8,10,12,14,16,20,24}`、`.mt-{4,8,12,16,20,24}`、`.muted .dim .tiny .mono .num .nowrap`、`.grid .grid-2 .grid-3 .grid-4`、`.split-main`、`.stack`、`.divider`。

## 6. 设计语言（必须遵守）

- 底色 `#060a13`，卡片是「玻璃深蓝渐变 + 1px 淡边框 + 大圆角 18px」；主色青 `#22d3ee`、蓝 `#3b82f6`，辅助紫 `#a78bfa`、绿 `#34d399`、琥珀 `#fbbf24`、玫红 `#fb7185`。
- 文字三级：`#e8eefb` / `#9db0ca` / `#6b7f9e`；数字用 `.num`（tabular-nums），标签用 11.5–12.5px。
- 卡片内边距 20–26px，卡片间距 18px；页面左右内边距由外壳提供（32px），不要再加。
- 发光克制：只在激活态、关键数字、状态点、主按钮上使用；不要满屏 glow。
- 所有可点击元素都要有 hover/active 反馈；过渡 0.16–0.25s `cubic-bezier(.22,.61,.36,1)`。
- 滚动发生在 `#page-body`，页面不要自己设 `height: 100vh` 或 `overflow: hidden`。

## 7. 各页当前行为（改动前先对照）

参考图在 `WorkBenchUI/design-refs/`，视觉基准；**行为以下表为准**。

### dashboard —— `ref-03-dashboard.jpg`

- 4 张 KPI 来自 `GET /api/business/dashboard`：今日总销售额 / 今日订单量 / 今日预估毛利 / HITL 待审批。
  全部真实聚合，无数据即 0，不编造。
- 「全链路智能体协同流」5 段 pipeline 按 `SkuProject.Status` 计数。
- 左「待处理高优先任务」= `GET /api/approvals?status=pending`，审批按钮走
  `POST /api/approvals/{id}/approve|reject`，失败回滚行状态并 toast 真实错误。
- 右「Agent 名册与工具授权」显示真实 Agent，工具列显示 `全部工具`（通配 `*`）或 `N 工具`。
- 头部操作：「刷新」重取当前区块，「重新加载全部数据」走 `WB.api.reload()`。
- 不再有「委派」「一键自动测款」等无后端支撑的假操作。

### agents —— `ref-04-agents.webp`

- 名册来自 `GET /api/agents`；统计条来自 `GET /api/agents/stats`（真实账本口径，文案写「账本操作」）。
- 筛选三态：全部 / 仅启用 / 仅停用（本地过滤真实字段，不做假分类）。
- 「查看配置」走 `GET /api/agents/{key}`，弹窗展示完整 `systemPrompt`（只读）。
- 「进入工作台」走 `POST /api/agents/{key}/chat`，对话弹框；模型离线时如实提示原因。
- 通配授权显示「全部（通配 *）」，不再显示成「1 条」。
- 不再有「+ 新建 Agent」（后端无写端点）。

### mcp —— `ref-05-mcp.webp`

- **纯真实页**：`ctx.data.mcpSource === 'live'` 才渲染服务卡，否则空态 + 重试。
- 统计卡、服务卡网格、工具清单全部来自 `GET /api/mcp/servers` + `/api/mcp/tools`。
- 8 个交互全接真实端点：握手 / 断开 / 新建 / 编辑 / 停用 / 调试抽屉 `tools/call` / 对账 / 刷新。
- 调试抽屉只允许调用 **read** 工具；写入类由后端 `43002` 拒绝，前端如实展示错误。

### settings —— `ref-01-settings.jpg`

- 页头无按钮；三 Tab：`模型与 API Key 设置` / `全局业务风控` / `环境与网络配置`。
- 模型 Tab 全部接 `/api/llm/*`：
  - 供应商卡：名称（小字）+ 卡头右侧平排「内置」badge（仅 DeepSeek）+「已启用」状态；
    Base URL；API Key 掩码回显（头 4 + `****` + 尾 4）；支持模型 chip；
    底部「编辑供应商」（API Key 录入合并进此弹框，留空=不修改）+「模型管理」+ 非内置卡「删除供应商」。
  - **本机私有化部署不在支持范围**，无本地供应商卡、无免密探测。
  - 全局「Agent 默认模型映射分派表」已移除（由各 Agent 自有界面承载）。
- 风控 Tab：三级（read / write / irreversible）开关走 `PUT /api/settings/risk/{id}`；
  `irreversible` 卡 `locked`，开关 disabled + 文案「强制人工审批」，后端写入返回 `43002`。
  底部说明「服务端不自动批准 HITL」。
- 环境 Tab：KV 列表 + 开关行，走 `PUT /api/settings/environment/{id}`，
  成功后 `WB.api.refreshSettings()`；返回 `effective` 区分「已实时生效 / 需重启进程生效」。
  连接串密码由后端脱敏成 `password=****`。
- 所有写操作失败**回滚界面**，不假装成功。

### products / orders / shops —— 沿用同一设计语言

- 数据来自 `GET /api/business/{products|orders|shops}`，页面不再有假数据。
- 筛选按真实字段：商品 `rawStatus`、订单 `aftersale`、店铺 `rawAuth`。
- 「导出 CSV」（BOM + Blob）与「刷新」（`WB.api.refreshBusiness(key)`）为真实功能。
- 空态文案写明业务表名，例如「业务表 `sku_project` 当前为空」。
- 不再有「新增商品 / 手动补单 / 绑定店铺 / 重新授权」（无对应写端点）。

### login —— `ref-02-login.jpg`

- 独立窗口 `renderer/login.html`（1180×720，无侧边栏），自绘标题栏（最小化 / 关闭）。
- 左侧插画全部内联 SVG + CSS 渐变，不引用外部图片。
- 右侧玻璃登录卡：账号 / 密码输入框（密码眼睛切换）、记住账号和密码、`立即登录` 渐变大按钮。
- 「记住账号和密码」由主进程 `electron/credentials.js` 用 Electron `safeStorage`（Windows DPAPI）
  加密落盘到 userData，登录页经 IPC 读取后自动预填；取消勾选并登录成功会清除已存凭据。
- 卡片下方一行：绿点 `本地服务连接正常 (127.0.0.1:5301)` + 右侧真实版本号。
- **真实鉴权**：登录按钮调 `window.workbench.login(username, password)` → 主进程请求
  `POST /api/auth/login`；成功才切主窗口，令牌只留在主进程（`electron/api-proxy.js`），
  渲染层不可见。默认管理员 `admin / admin123` 由服务端首次启动种子到 `sys_user`。
- 失败提示沿用服务端文案（`账号或密码错误` / `账号已停用`）：密码框红边 + 抖动 + toast。
- 主窗口所有 `/api/*` 请求由主进程注入 `Authorization: Bearer <token>`；令牌过期（401）自动回登录页。
- 空账号/密码 → 输入框红边 + 抖动 + toast；回车提交。

## 8. 自检清单（提交前逐条确认）

1. `node scripts/start-electron.js --capture` 退出码 0，report 里 `errors` 为空。
2. 打开 `artifacts/<id>.png`：无横向滚动、无文字溢出、无图片 404、无重叠。
3. 页面切换正常：从侧栏点进来、切走再回来，交互仍可用（`mount` 每次重新绑定，不要累加全局监听）。
4. 控制台无 error；没有 `TODO`/占位英文/假链接。
5. **页面里没有硬编码业务数字**；空数据时是空态而非 0 或假值。
6. 写操作失败后界面回到操作前状态，并展示了真实错误信息。

## 9. 交付报告

- 改动/新增文件清单（绝对路径）
- 实现内容要点 + 与参考稿的差异说明
- 截图路径（`artifacts/<id>.png`）与自检结论（退出码、errors）
- 剩余问题 / 需要额外处理的公共改动
