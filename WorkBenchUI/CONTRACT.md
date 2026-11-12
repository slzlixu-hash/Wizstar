# WorkBenchUI 页面实现契约（v1.9.0-MVP · 纯界面阶段）

本文件是页面实现的**唯一约定**。开始写代码前完整读一遍，严格按此实现。

## 1. 目标与边界

- 目标：用 Electron + 原生 HTML/CSS/JS 复刻 5 张深色科技风设计稿（`design-refs/`），做出可运行的桌面端界面演示。
- **只做界面**：不接任何后端接口、不写业务逻辑、不连数据库、不调用真实模型或 MCP 服务。
- 所有数据来自 `renderer/js/mock-data.js`（已写好，禁止改）。
- 交互允许且鼓励做「本地演示级」效果：切 tab、搜索过滤、下拉、toast、抽屉、弹窗、按钮 hover/active，以及页面内的少量状态切换。
- 技术栈锁定：纯 HTML/CSS/JS，**无构建工具、无 npm 依赖、无框架**，Electron 45 通过 `file://` 加载。不得引入任何外部 CDN、字体、图片（离线环境）。
- 界面语言：简体中文。

## 2. 运行与自检

在 `D:\WorkCode\Wizstar\WorkBenchUI` 下执行：

```bat
node scripts/start-electron.js --capture --only=<pageId>
```

- `<pageId>` ∈ `login` / `dashboard` / `agents` / `mcp` / `settings`（商品/订单/店铺占位页由 Lead 负责）。
- 输出：`artifacts/<pageId>.png` + `artifacts/capture-report-<pageId>.json`。
- **必须用 `read_image` 打开 PNG 自检**，和 `design-refs/ref-0X-*.jpg` 对照，至少迭代 2 轮：先对齐布局与信息结构，再打磨间距/字号/发光/颜色。
- 截图窗口是 **1440×900**（login 为 1180×720），内容区宽度 = 1440 − 236 侧栏 − 64 内边距 ≈ **1140px**。请按此宽度设计，不要出现横向滚动。
- 报告里 `errors` 非空即失败（脚本退出码 1）。注意：**页面里禁止 `console.error`**；也不要引用不存在的图片/脚本，否则 Chromium 报错会让验收失败。

## 3. 文件所有权（严禁越界写文件）

| 文件 | 归属 |
| --- | --- |
| `renderer/index.html`、`renderer/js/{icons,mock-data,components,app}.js`、`renderer/js/pages/placeholders.js`、`renderer/styles/{tokens,shell}.css`、`renderer/styles/pages/placeholders.css`、`electron/*`、`scripts/*`、`package.json`、`design-refs/*` | **Lead**（你只读，不改） |
| `renderer/js/pages/dashboard.js` + `renderer/styles/pages/dashboard.css` | dashboard |
| `renderer/js/pages/agents.js` + `renderer/styles/pages/agents.css` | agents |
| `renderer/js/pages/mcp.js` + `renderer/styles/pages/mcp.css` | mcp |
| `renderer/js/pages/settings.js` + `renderer/styles/pages/settings.css` | settings |
| `renderer/login.html` + `renderer/styles/login.css` + `renderer/js/login.js` | login |

- 公共样式/组件不够用时：**先在自己的页面 CSS 里加类**（统一前缀，如 `.dash-` `.team-` `.mcp-` `.set-` `.login-`），不要改公共文件；确需公共改动，在报告里写明，由 Lead 处理。
- 不要新增第三方文件、不要 npm install、不要动 `node_modules`。
- `index.html` 已预留你的 `<script src="js/pages/<page>.js">` 和 `<link ... styles/pages/<page>.css">`，文件建好即可生效。

## 4. 页面注册契约

每个页面文件必须注册（IIFE 内执行，页面切换时由 `app.js` 调用）：

```js
'use strict';
(function () {
  const WB = window.WB;          // 注意：必须取 window.WB，不是 window
  const ui = WB.ui;              // 组件库
  const pages = (WB.pages = WB.pages || {});

  pages.dashboard = {
    title: '运营指挥工作台',        // 左上角大标题（纯文本）
    subtitle: '现在简体中文',       // 标题下方副标题，可含 HTML
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
- 页面 CSS 只写本页专属规则，避免污染公共类；不要重定义 `.card` `.btn` 等公共类的整体样式（可用 `.dash-xxx .card` 局部覆盖）。

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

图标名可用 `WB.iconNames` 查看，常用：`home box clipboard shop robot plugin settings plus close search filter bell chevron-down chevron-right arrow-right arrow-up-right check eye pencil key refresh shield lock user play power terminal wifi link alert trash chart image tag cart truck server globe database sparkles clock more more-vertical zap layers target download upload log-out info cpu wand route inbox command`.

可用的通用工具类（见 `tokens.css`）：`.row .col .between .wrap .grow`、`.gap-{2,4,6,8,10,12,14,16,20,24}`、`.mt-{4,8,12,16,20,24}`、`.muted .dim .tiny .mono .num .nowrap`、`.grid .grid-2 .grid-3 .grid-4`、`.split-main`、`.stack`、`.divider`。

## 6. 设计语言（必须遵守）

- 底色 `#060a13`，卡片是「玻璃深蓝渐变 + 1px 淡边框 + 大圆角 18px」；主色青 `#22d3ee`、蓝 `#3b82f6`，辅助紫 `#a78bfa`、绿 `#34d399`、琥珀 `#fbbf24`、玫红 `#fb7185`。
- 文字三级：`#e8eefb` / `#9db0ca` / `#6b7f9e`；数字用 `.num`（tabular-nums），标签用 11.5–12.5px。
- 卡片内边距 20–26px，卡片间距 18px；页面左右内边距由外壳提供（32px），不要再加。
- 发光克制：只在激活态、关键数字、状态点、主按钮上使用；不要满屏 glow。
- 所有可点击元素都要有 hover/active 反馈；过渡 0.16–0.25s `cubic-bezier(.22,.61,.36,1)`。
- 滚动发生在 `#page-body`，页面不要自己设 `height: 100vh` 或 `overflow: hidden`。

## 7. 各页参考稿与要点

参考图在 `renderer/../design-refs/`（即 `WorkBenchUI/design-refs/`），**先用 `read_image` 看清再动手**。

### dashboard —— `ref-03-dashboard.jpg`
- 页头：`运营指挥工作台` + 副标题小胶囊 `现在简体中文`（副标题里用图标 + 文案）；右上角无按钮。
- 4 张统计卡：今日总销售额 ¥48,650（↑14.2% 绿色）、今日订单量 328 单（已代发 312）、今日预估毛利 ¥19,860（毛利率 40.8%）、待我审批（HITL）3 项（琥珀色警示卡，右上角警示图标）。数据见 `WB.data.dashboard.kpis`。
- 「全链路智能体协同流」卡：5 个阶段胶囊（选品中 42 → 寻源比价 28 → 素材制作 19 → 待质检审核 3 → 今日已上架 85），阶段之间**箭头/流光连接**，每个胶囊右侧带大号数字。选品中为琥珀描边发光，素材制作为绿色。数据见 `pipeline`。
- 下方左右分栏（左宽右窄，约 1.6:1）：
  - 左：「待处理高优先任务」表格（任务 ID / 来源 / 任务描述 / 触发时间 / 操作「审批 + 委派」），数据 `dashboard.tasks`；表头右侧可放「查看全部」链接。
  - 右：「6 位 Agent 实时运行负载」：2 列 × 3 行小卡，每卡头像 + 名称 + 英文名 + 绿色在线点 + 细进度条（load%）；底部「一键启动自动测款」渐变大按钮。
- 交互演示：审批按钮 → toast/confirm；「一键启动」→ toast + 按钮 loading 0.8s 恢复。

### agents —— `ref-04-agents.webp`
- 页头：标题 `Agent 团队管理`；右上角 `ui.userCluster()`（齿轮/通知/头像）。
- 页头下方一条**统计条**：在线 Agent 6/6 全部就绪 · 今日协作任务 1,420 次 ↑ · 执行成功率 99.2% ↑（数据 `WB.data.team.stats`），右侧放筛选按钮 + 搜索框 + 「+ 新建 Agent」主按钮。参考图里这一段是标题栏的一部分，做成一条细长工具条即可。
- 主体：**3 列 × 2 行** Agent 卡（6 位，数据 `WB.data.agents`）。每卡：左上头像（用 `ui.avatar(agent,'lg')` 或自绘 44–56px 圆角头像）+ 名称 + 英文小字 + 右上状态徽标（带点）；下面「状态中：」一段斜体/淡色文字；「绑定的 MCP 工具：」一行 chip；底部两行小字（已沉淀规则 / 今日调用等），最后是「进入工作台」（主按钮）+「设置与记忆」（次按钮）。卡片要有顶部渐变光和细边框，hover 上浮。
- 交互：搜索过滤（按名称/英文名/工具）、「新建 Agent」→ modal 占位、「进入工作台」→ toast。

### mcp —— `ref-05-mcp.webp`
- 页头：标题 `MCP 插件管理`，副标题说明「本机 MCP 服务注册与握手状态（演示数据）」；右上角「+ 接入新 MCP 服务」主按钮。
- 4 张统计卡（已登记插件 8 / 握手在线 4 / 待接入配置 4 / 今日工具调用 2,840 次，数据 `WB.data.mcp.stats`）。
- 工具条：左侧 segmented「全部 / 在线 / 待接入」，中间「全部健康探测 (GET /healthz)」按钮，右侧搜索框 + 「服务类型」下拉。
- 2 列服务卡网格（8 个，数据 `WB.data.mcp.servers`）：卡头 = 小图标（用 `ui.icon('server'|'shop'|'globe'|'browser'?)`，可用 `server shop globe link`）+ 服务名 + slug 小字；在线服务右上绿点/「已连接」，离线灰色「待接入」；卡身键值：传输（HTTP 地址，等宽字体）、工具数/握手状态、绑定 Agent、风险等级（彩色 badge）；在线卡底部「健康检测 + 配置 + 断开连接」按钮，离线卡「配置连接」。
- 右侧**调试抽屉**（要能开关，默认打开以对齐参考图）：标题「1688 货源专线 · 调试测试」，顶部在线地址 + GET /healthz 的绿点，中间「调用工具选择（e.g. search_items）」输入框 + 状态下拉，深色终端区显示 JSON（用 `WB.data.mcp.servers[0].log` 逐行渲染，行内 key/字符串/数字用 `.terminal .t-key/.t-str/.t-num` 着色），底部「运行测试」主按钮 + 「关闭调试」次按钮。
- 布局：抽屉固定在内容区右侧（宽 ~420px），打开时主区域网格变窄（用 flex/grid 实现，不要遮挡）；点击卡片「调试测试」切换当前服务并刷新终端内容；「运行测试」→ 终端追加一行结果 + toast。

### settings —— `ref-01-settings.jpg`
- 页头：标题 `系统设置`；右上角依次：`+ 新增模型供应商`（主按钮）、「默认全局模型：deepseek-chat (V3)」下拉、`保存更改`（主按钮）。
- Tab 行：`模型与 API Key 设置`（激活，青色下划线）/ `全局业务风控` / `环境与网络配置`，右侧「+ 添加自定义供应商 (OpenAI / 阿里通义 / 硅基流动)」链接。三个 tab 必须能切换，各自有内容。
- 模型与 API Key：
  - 供应商卡 2 张 + 1 张虚线「添加自定义供应商」卡（3 列）：DeepSeek（已启用绿徽标、Base URL、API Key `sk-****7a9c` 带眼睛/铅笔图标、支持模型 chip `deepseek-chat` `deepseek-reasoner (R1)`、底部「编辑供应商」+「配置 API Key」）；Ollama（免密就绪、Base URL、API Key 无（本地调用）、模型 chip、底部「探测本地服务」）。数据 `WB.data.settings.providers`。
  - 下方「Agent 默认模型映射分派表」卡：说明小字 + 6 行，每行左 `指挥官 Agent（Commander）`，右 `-> 摆渡的模型:` + 下拉（deepseek-chat 等）。数据 `modelMapping` / `modelOptions`。
- 全局业务风控 tab：4 个风险等级卡（L1 只读 / L2 写入 / L3 敏感写入 / L4 不可逆，`riskPolicy`），每卡标题 + 等级 badge + 描述 + 「自动执行 / 需人工审批」开关；再加一条说明「服务端不自动批准 HITL」。开关切换 → toast。
- 环境与网络配置 tab：环境信息 kv 列表（`environment`）+ 4 个 toggle 行（`toggles`，用 `ui.switchControl`）+ 「测试连通性」按钮（toast）。
- 交互：tab 切换、保存更改 → toast + 按钮 loading、「探测本地服务」→ toast（延误 600ms 模拟）、眼睛切换 API Key 明文/掩码、编辑/配置 → modal 占位。

### login —— `ref-02-login.jpg`
- 独立窗口 `renderer/login.html`（1180×720，无侧边栏），自带标题栏：左上小 Logo + `AgentWorkBench`，右侧只有「最小化 / 关闭」两个自绘按钮（用 `window.workbench.minimize()/close()`）。
- 左侧约 55%：大标题 `AgentWorkBench` + 副标题 `智多星电商智能体协同平台` + 一行 `多智能体协同 · 驱动矩阵电商全自动闭环`；下方是科技感插画（网络节点 / 发光立方体 / 全息面板）。插画自行用内联 SVG + CSS 渐变实现（可以多层：透视网格地面、中心发光六边形/立方体带 AI 字样、周围漂浮小模块、流光连线），不要引用外部图片。
- 右侧约 45%：居中玻璃登录卡（宽 ~460px，圆角 20px+），卡头 `A` 徽标 + 智多星，`欢迎登录` 标题；两个输入框（账号/手机号、登录密码，左侧图标、密码右侧眼睛切换）；`记住账号并自动登录` 复选框；`立即登录` 大渐变按钮（蓝色，全宽）；卡片下方一行：绿点 `本地服务连接正常 (127.0.0.1:5210)` + 右侧 `v1.9.0-MVP`。
- 交互：登录按钮 → `window.workbench.login()`（若不存在则 toast 提示「在 Electron 中运行」）；空账号/密码点击登录 → 输入框红边 + 抖动 + toast；回车提交；记住账号切换正常。
- 登录页脚本：`js/login.js`，需要 `<script src="js/icons.js">`（可用 `WB.icon`、`WB.brandLogo`，也可不用）。**不要引用 `components.js` 里依赖 `#page-body` 的东西**（它是通用的，可以用，但没有页面外壳）。
- 页面尺寸固定 1180×720：内容不要溢出，用 `height: 100vh` 分左右两栏，左侧插画 `overflow: hidden`。

## 8. 自检清单（提交前逐条确认）

1. `node scripts/start-electron.js --capture --only=<id>` 退出码 0，report 里 `errors` 为空。
2. 打开 `artifacts/<id>.png`：无横向滚动、无文字溢出、无图片 404（灰框）、无重叠；1440×900 下信息层级与参考稿一致。
3. 页面切换正常：从侧栏点进来、切走再回来，交互仍然可用（`mount` 每次重新绑定，不要用会重复累加的全局监听）。
4. 控制台无 error；没有 `TODO`/占位英文/假链接。
5. 只用 `WB.data` 里的数据；页面 JS 无大段硬编码业务文案（UI 装饰性文案除外）。

## 9. 交付报告（回给 Lead 时给出）

- 改动/新增文件清单（绝对路径）
- 实现内容要点 + 与参考稿的差异说明
- 截图路径（`artifacts/<id>.png`）与自检结论（退出码、errors）
- 剩余问题 / 需要 Lead 处理的公共改动
