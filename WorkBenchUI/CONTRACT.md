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

- 名册来自 `GET /api/agents`（bootstrap 同步下发头像 `avatar` / 色调 `tone` / 快捷指令 `quickPrompts`）；
  统计条来自 `GET /api/agents/stats`（真实账本口径，文案写「账本操作」）。
- 6 位 Agent：指挥官 commander / 选品专家 scout / 供应链专家 sourcing / 内容创作 creative /
  上架专家 publisher / 数据分析师 analyst；人设与工具授权在 `config/agents.yaml`，头像取 `ico/<avatar>.ico`（加载失败回落首字）。
- 筛选三态：全部 / 仅启用 / 仅停用（本地过滤真实字段）。
- 按钮统一叫「管理界面」：**指挥官**打开独立窗口 `renderer/commander.html`（铺满整个界面，不套主壳侧边栏/页头；
  打开时主窗口隐藏、关闭后恢复），其余 Agent 打开右侧工作台浮层。
  指挥官窗口：顶部身份条（**模型选择** + 窗口控制）+ 左功能轨（工作台/Chat/工作流/记忆体/Skill/MCP/轨迹）+
  中栏任务台（按工作流新建任务、详情/审核/推进/终止、最近轨迹）+ 右栏「协同与指令台」（真实 Handoff 日志 + `//` 指令）。
  右上角「模型选择」为下拉框：列出系统已接入且启用的模型，选中即写 `PUT /api/llm/bindings`
  （`{bindings:{commander:modelId}}`），当前 Agent 后续对话立即使用该模型；顶栏当前模型与 Chat 徽标同步刷新。
  点「详情」或双击任务行 → **任务详情页**（同一窗口中切换）：返回条 + 任务摘要（进度 i/N 工序）+
  工序时间线（当前工序展开审核/完成口径、备注与 推进/手动完成/通过/驳回/终止）+ 最近轨迹 + 导出轨迹(JSON)；
  左轨附带「进行中任务切换」卡，可一键跳到其它在跑任务。
- **Chat**（左轨进入）：左侧会话列表（新建/切换，历史来自 `wiz_agent_session`）+ 右侧聊天流；
  每个会话行右侧常驻 **归档 / 删除** 两个操作按钮：
  - **归档**：`POST /api/agents/{key}/sessions/{id}/archive`（`archived:true|false`），只从默认列表隐藏，
    历史仍可读；底部「归档箱 N」展开已归档行，可恢复或删除；归档会话只读（输入框/发送/附件禁用）。
  - **删除**：`DELETE /api/agents/{key}/sessions/{id}`，需二次确认；群聊删除会连带清理
    `{groupId}:{agentKey}` 内部通道，专员长期记忆不受影响。
  输入框左下角 `+` 默认收起（不占纵向高度），点击后在按钮上方浮出毛玻璃菜单：
  「拉起 Agent 群聊（多专员协同会诊）」「上传附件（Excel/CSV/PDF）」「上传商品图/视频」；
  已挂载文件以胶囊卡片排在输入框上方（带 × 移除），点「发送 ↵」随指令一起发给指挥官。
  附件文本（CSV/TXT/MD/JSON ≤4000 字）随消息注入模型，二进制只带元信息。
- **群聊协同会诊**：点 `+` →「拉起 Agent 群聊」后，已有内容的单聊原地升级为群会话（同一 conversationId，
  历史映射为 user/commander），左栏标为 `#N [群聊·N人] 主题`；无内容时新建 `grp-*` 群会话。
  群聊复用 `wiz_agent_session`（`AgentKey=__group__`，新增 `title` / `participants_json` 两列，不新增表）：
  - 顶部 **Participants Bar**：指挥官固定主持，其余专员胶囊可点击切换本轮是否发言；`+ 邀请 / 移除专员`
    打开增减参会人弹框（上限 6 人，写回 `participants_json`）。
  - 输入框上方常驻 `@全体 / @Scout / @Sourcing / @Creative / @Publisher…` 快捷胶囊；发送时只把指令发给
    被 @ 的专员，每位专员**各发言 1 次**即停（不发散接力）；专员使用自己的 conversationId
    `{groupId}:{agentKey}`，记忆/知识/工具授权严格隔离。
  - 专员发言后指挥官**固定收敛 1 次**，输出带 `[✅ 采纳群聊决议并推进工序 ➔]` 的总结卡；点击选择任务后，
    待人工闸口走 `approve`（决议作为备注），否则推进下一道工序。
  - 端点：`GET/POST /api/agents/groups`、`GET /api/agents/groups/{id}`、
    `PUT /api/agents/groups/{id}/participants`、`POST /api/agents/groups/{id}/turn`；指挥官会话列表合并群会话
    （`kind=group` + `title` + `participants`），群聊内部专员通道（含 `:` 的会话 ID）不进单聊列表。
- **工作流管理**（左轨进入）：左 32% 配方列表（搜索 / 触发来源筛选 / 启用状态）+ 右 68% 纵向积木编排
  （拖拽排序、闸口「需人工确认」开关、插入/配置节点弹窗、预览 YAML、导入/导出 YAML、保存、删除）；
  保存直接写 `pipelines/*.yaml` 并热加载。该分区隐藏右侧指令台，画布占满。
- 「管理界面」（其余 Agent）为右侧浮层，标题栏右上角同样是 **模型选择** 下拉框（按 `agentId` 写绑定，
  下一条消息即生效，回复 meta 显示实际 `model`）；四个分区全部走真实接口：
  - **对话**：`POST /api/agents/{key}/chat` + `GET /conversations/{id}`；会话 ID 按 Agent 存 localStorage，
    后端持久化到 `wiz_agent_session`，刷新可恢复；不同 Agent 同一会话 ID 也互不可见。
  - **记忆**：`GET/POST/DELETE /api/agents/{key}/memory`、`/knowledge`（长期记忆软删、知识库物理删）。
  - **上下文**：`GET/PUT /api/agents/{key}/context`（记忆/知识字符上限、L1 开关、最近一次注入快照）。
  - **配置**：`GET /api/agents/{key}` 展示完整 systemPrompt（只读）。
- 每次运行把「记忆 + 知识库」拼成独立 system 消息注入（超上限截断并在提示里标注），并写 `agent_context_snapshot`。
  记忆先按**任务标签**过滤：无标签 / 仅 #全局 的规则始终注入；`#保温杯` 等规则只在请求带对应 `tags` 时注入
  （聊天未显式传 tags 时，按消息里出现的规则标签做轻量推断）；`sync_agent_keys` 中的 Agent 也能命中同一条规则
  （跨专员分发）。真正被装配的规则累加 `hit_count`。
- **记忆体**（指挥官左轨）是自学习中枢（全宽布局，隐藏右侧指令台）：
  - 顶部三 Tab：`本Agent规则记忆` / `团队共享记忆` / `本地知识库 SOP`；带搜索、适用标签、状态筛选。
  - 表格列：主题 + 适用标签、规则事实、来源 / 同步对象、命中次数 / 样本量 / 有效期、状态、操作。
  - **团队共享记忆**：只看 `sync_agent_keys` 非空的生效规则；列升级为
    `共享维度/标签 | 全局规则事实 | 生效 Agent 范围 | 贡献来源 | 命中次数 | 操作`。
    全员共享行绿色高亮；筛选支持搜索 / 共享范围（全部、全员、指定） / 分类（主题 `·` 前的维度）。
    工具栏 `一键广播同步至全员` 把当前 Agent 全部生效规则同步给其余 Agent；每行支持
    `编辑` / `作用范围`（改同步对象）/ `下线`（清空同步范围，本地规则保留）。
    右侧「团队共享注入总览」按 Agent 展示覆盖率、共享条数与命中次数。
  - **本地知识库 SOP**：文档列表（关键词精准检索，不接向量库）+ 右侧详情编辑。
    列表显示标题、触发标签、主标签、字符数、启用/停用；支持搜索 / 标签 / 状态筛选。
    工具栏 `导入文档 (.md/.txt)`（读入后进入编辑确认）与 `+ 新建知识条目`；
    右侧可编辑标题、标签 chips、正文（黑框编辑器）并实时显示 `字符 / maxKnowledgeChars`，
    底部 `保存修改` / `删除条目`；停用文档不注入 System Prompt。
    端点：`POST /knowledge`、`PUT /knowledge/{id}`（含 enabled）、`DELETE /knowledge/{id}`。
  - **手动新增 / 编辑记忆规则弹框**：作用范围三选一（仅当前 Agent / 指定同步 / 全员共享），
    Agent 彩色胶囊多选；主题 + Target Metric；触发标签 chips（回车添加，添加具体标签时自动去掉 `#全局`）；
    规则正文 500 字计数；有效期（90天/永久/保持）与置信度；`人工录入直接确认并归档同维度冲突旧规则`
    开关。支持编辑已有规则（`PUT /memory/{id}`）。
  - `✨ 提炼近期经验 (自学习)`：扫描近 7 天人工驳回（`wiz_approval` 状态 2）、微信小店审核驳回
    （`sku_channel_listing.audit_reject_reason`）、高退货率商品（`ecom_order` + `ecom_order_item`），
    产出 0~5 条 `pending` 候选；同一 `source_ref` 不重复提示，无证据不编造。
  - 冲突：同主题已有生效规则时，候选行标黄并提示「确认后将自动归档旧规则 #NNN」；确认时
    `replace=true` 先把旧规则置为 `archived`，避免矛盾规则同时注入。
  - 跨 Agent：确认弹框可勾选 `Scout / Sourcing / Creative / Publisher / Analyst`，写入 `sync_agent_keys`。
  - 手动新增同主题规则时，旧生效规则也会自动归档，保证同一主题只有一条注入规则。
  - 指标：候选显示 `样本 N 项 · 90天有效`，生效规则显示 `已命中 N 次 · 永久/剩余天数`。
  - 右侧白盒预览：`类目 / 渠道` 模拟器切换即调用 `GET /memory/preview?tags=…`，实时显示
    `System Prompt Layer 3` 命中的规则、字符预算百分比与 L1 提取开关。
  - 端点：`POST /memory/learn`、`POST /memory/{id}/confirm|reject|archive`、`PUT /memory/{id}`、
    `GET /memory/preview`、`GET /memory/scopes`、`GET /memory/team`、`GET /memory/team/overview`、
    `POST /memory/team/broadcast`、`PUT /memory/team/{id}`、`POST /memory/team/{id}/unshare`。
- **Skill 技能**（左轨进入，全宽 32% 列表 + 68% 装配台；**每个 Agent 只显示与维护自己的 Skill**）：
  - 左侧资产列表：搜索名称/标识；卡片显示 code、负责 Agent、工具数、触发模式、启停状态；
    指挥官页只显示 `agent=commander` 的技能，专员工作台「技能」Tab 只显示该专员的技能。
  - 右侧双模编辑器：
    - **可视化装配**：技能名称/唯一标识（创建后不可改）/执行 Agent（固定当前 Agent，只读）/描述/启用开关；
      精准勾选工具（`serverId.tool`，按 MCP 服务做一级分组、工具为二级列表）；
      一级分组头提供 **全选 checkbox（支持半选态）** 与 **收起/展开开关**，未连接工具单独告警；
      Chat/Auto 触发模式（两者可同时勾选，保存为 `trigger_mode: both`）；SOP Prompt；温度/最大 Token/重试参数。
    - **YAML 源码**：语法高亮 + 可编辑 textarea（透明覆盖层），与可视化双向转换；
      保存走 `POST /api/skills/import`，按 YAML 落盘。指挥官窗口提供完整双模；专员工作台提供同名可视化维护。
  - 底部 `保存并热重载`、`停用/启用`、`删除技能`。
  - 文件：`skills/<code>.yaml`；字段 `code/name/description/agent/enabled/trigger_mode/allowed_tools/prompt/
    temperature/max_output_tokens/retry`。保存/删除/启停后 `SkillCatalog.ReloadNow()`，无需重启。
  - 运行时：`POST /api/agents/{key}/chat` 可带 `skillKey`；校验技能启用且绑定当前 Agent，
    工具取「Agent 授权 ∩ skill.allowed_tools」，SOP Prompt 拼进 System Prompt，温度/Token/重试参数生效。
  - 端点：`GET /api/skills?agent=`（按 Agent 过滤）、`POST /api/skills`、`GET/PUT/DELETE /api/skills/{code}`、
    `GET /api/skills/{code}/yaml`、`POST /api/skills/{code}/toggle`、`GET /api/skills/tools`、
    `POST /api/skills/preview|parse|import`。
- **轨迹日志**（左轨进入，全宽 `Live Audit Log`）：
  - 过滤器：今日（24h）/ 近 7 天 / 全部；工作流；日志级别（Success / Warn / Error）；负责 Agent；关键词。
  - 表格列：时间、来源 / Agent、行为 (Action)、参数 / 负载 (Payload)、状态、操作。
  - 状态：`Success / Replay / Pending / Approved / Rejected / Error / Blocked`，带颜色与耗时。
  - 操作：查看（参数/结果 JSON 详情）、只读 MCP 工具失败可重试、待审批可去审批 / 撤回。
  - 数据源：`wiz_audit_log`；`AgentRunner` 每次工具调用（含回放、HITL 挂起、错误、步数熔断）落审计；
    流水线推进/审批/完成/终止也写入（source=`pipeline`，带 pipeline_id / project_no）。
  - 审批结果同步更新轨迹状态（approved / rejected）；批准后仍需下一次同参调用才真正执行。
  - 导出 CSV（含 BOM，Excel 可直接打开）。
  - 端点：`GET /api/audit/logs?sinceHours=&pipelineId=&severity=&agent=&keyword=&limit=`。
- 通配授权显示「全部（通配 *）」；不再有「+ 新建 Agent」（后端无写端点）。

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
  - 内置 DeepSeek 供应商与种子模型只在数据库**首次初始化**时写入；用户删除 `deepseek-chat` /
    `deepseek-reasoner` 后重启不会复活。删除模型会同步清理指向它的 Agent 绑定；若删的是全局默认模型，
    自动提升同供应商最早启用模型，避免整站 offline。
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
