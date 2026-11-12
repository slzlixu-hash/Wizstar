# WorkBenchUI 前后端联调契约（A1 + A2 · v1.1）

> 本文件是 **A1 / A2 联调阶段** 的约定。与 `CONTRACT.md` 冲突时，以本文件为准；
> `CONTRACT.md` 中未被本文件放宽的条款（页面注册契约、样式命名空间、离线无第三方依赖、
> 禁止 `console.error`、1440×900 截图验收等）继续有效。

## 1. 目标与边界

让 Electron 界面从「纯演示」升级为「能显示真实后端数据、能写真实配置」，且
**后端不可用时自动回退演示数据**，界面不白屏、不报错、不依赖网络。

| 阶段 | 范围 | 落点 |
|---|---|---|
| A1（只读） | `GET /api/ui/bootstrap`（聚合 health / agents / mcp） | `WB.data.agents` / `WB.data.mcp` / `WB.data.app.endpoint` / 登录页状态灯 |
| A2（读写） | `/api/llm/*`（模型与 API Key 设置） | `WB.data.settings.providers` / `modelMapping` / `modelOptions` / `app.globalModels` |

**仍然不做（留后续）**：chat 流式对话、HITL 审批操作、登录鉴权（`sys_user`）、
dashboard KPI 业务数据、风控 / 环境 Tab 落库（本期仍为演示）、MCP 握手/对账写操作。

## 2. 放宽的契约约束

`CONTRACT.md` §1「只做界面、不接任何后端接口」与 §3 文件所有权，在 A1 中放宽如下：

| 文件 | A1 允许 | 说明 |
|---|---|---|
| `electron/main.js`、`electron/preload.js` | 允许修改 | 新增本地 API 只读 IPC 代理 |
| `electron/api-proxy.js` | **新增** | 代理实现，供 main.js 与截图脚本共用 |
| `scripts/capture.js` | 允许修改（仅注册代理） | 截图脚本自身是主进程，也需注册 `api:get` |
| `renderer/index.html`、`renderer/login.html` | 允许各加一行 script | 引入 `js/api-client.js` |
| `renderer/js/api-client.js` | **新增（A1）/ 允许修改（A2）** | 联调数据层：`WB.api.request` + `WB.api.applyLlm` |
| `renderer/js/mock-data.js` | A1 禁止修改；**A2 允许修改** | A2 移除本机私有化供应商演示卡、内置标签口径调整 |
| `renderer/js/pages/settings.js`、`styles/pages/settings.css` | A1 禁止修改；**A2 允许修改** | 设置页接真实写接口 + 内置标签 / 删除按钮 / 支持模型入口 |
| 其余页面 `js/pages/*`、`styles/pages/*` | **仍然禁止修改** | 页面靠 `WB.go()` 重渲染自动消费新数据 |

## 3. 后端契约

`GET /api/ui/bootstrap` → 统一信封 `{ success, data, error, traceId }`，`data`：

```jsonc
{
  "endpoint": "127.0.0.1:5301",
  "version": "0.1.0",
  "chatMode": "offline",              // live / offline
  "chatOfflineReason": "...",
  "agents": [ { "key", "name", "displayName", "description", "enabled", "maxSteps", "allowedTools" } ],
  "mcp": {
    "connected": 1, "offline": 0, "error": 0, "disabled": 0,
    "servers": [ { "id", "name", "transport", "state", "toolCount", "lastError", "serverName", "serverVersion" } ],
    "tools": [ { "name", "serverId", "declaredRisk" } ]
  }
}
```

只读聚合，不改变风险分级 / HITL / 幂等账本任何口径；不写库、不触发握手。
`Ui:Endpoint` 在 `src/Wizstar.Api/appsettings.json` 配置。

## 4. 前端数据层

**通道**：渲染进程 `sandbox:true`，不直接发网络请求。链路为

```
A1  api-client.js → workbench.apiGet(path) → ipcRenderer.invoke('api:get')
A2  WB.api.request(method, path, body) → workbench.apiRequest(...) → ipcRenderer.invoke('api:request')
                  → 主进程 fetch(http://127.0.0.1:5301 + path) → 统一信封
```

- 主进程只放行 `/api/` 开头的相对路径 + `GET/POST/PUT/DELETE`，拒绝 `..`、`\`、`://`；
  GET 超时 2.5s，写操作 12s。
- `apiGet` / `apiRequest` **永不 reject**，失败返回 `{ ok:false, error }`；
  `WB.api.request` 再拆统一信封，收敛成 `{ ok, data?, error? }`，渲染层据此降级。
- 基址可用环境变量 `WIZSTAR_API_BASE` 覆盖。

**时序**：`api-client.js` 在 `mock-data.js` 之后、`components.js` 之前加载，
同步修正 `WB.data.app.endpoint`；`DOMContentLoaded` 后发起探测，
成功则覆盖字段 → 标注角标 → `WB.go()` 重渲染；失败保留全部 mock。

## 5. 数据口径（真实少于演示时）

后端当前为 **2 个 Agent / 1 个 MCP 服务**，界面演示数据为 **6 / 8**。口径为
「**真实覆盖 + 保留演示**」：

- `agents`：按 `id === key` 覆盖真实字段（name/desc/online/status/mcp/rules），
  其余演示卡保留，布局不变；
- `mcp.servers`：真实服务置顶/覆盖，演示卡保留；`mcp.stats` 前两项改为真实数量；
- 侧栏/登录页注入角标：`实时 · 部分演示` 或 `演示 · API 未连接`，
  避免把演示数值误认为线上数据。

## 6. 启动与验收

```bash
# 1) 后端（另开终端）
cd src/Wizstar.Api && ASPNETCORE_URLS=http://127.0.0.1:5301 dotnet run
# 2) 可选：演示 MCP 服务（另开终端）
node tools/mcp-demo/server.js
# 3) 前端
cd WorkBenchUI && node scripts/start-electron.js
```

验收口径：

1. 后端 `dotnet build` 0 错误、`dotnet test` 49/49 通过；
2. 登录页状态灯 online、端口显示 `127.0.0.1:5301`；
3. MCP 页出现真实 `mcp-demo` 卡（connected / 工具数来自 `tools/list`）；
4. **停掉后端** → 自动回退演示数据、角标变「演示模式」、无 `console.error`；
5. `node scripts/start-electron.js --capture` 截图验收报告 `errors` 为空；
6. `api-client.js` 不产生 `console.error`，不抛未捕获异常。

---

## 7. A2：模型与 API Key 设置（真实 LLM 通道）

### 7.1 端点清单（`src/Wizstar.Api/Endpoints/LlmEndpoints.cs`）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/llm/settings` | 聚合快照：供应商 / 支持模型 / 默认模型 / Agent 分派 / chatMode |
| POST | `/api/llm/providers` | 新增自定义供应商（可一次带入多个模型 ID） |
| PUT | `/api/llm/providers/{code}` | 编辑名称 / Base URL / 启用状态 |
| DELETE | `/api/llm/providers/{code}` | 删除供应商（内置禁删，返回 40001） |
| PUT | `/api/llm/providers/{code}/api-key` | 写入 API Key（AES-256-GCM 密文 + 掩码） |
| GET | `/api/llm/providers/{code}/api-key` | 主动取回明文（眼睛按钮），不进快照 / 日志 |
| POST | `/api/llm/providers/{code}/models` | 添加支持模型 |
| DELETE | `/api/llm/providers/{code}/models?modelId=` | 删除支持模型 |
| PUT | `/api/llm/default-model` | 设置默认全局模型 |
| PUT | `/api/llm/bindings` | 保存 Agent → 模型分派 |
| POST | `/api/llm/test` | `GET {baseUrl}/models` 真实探测（不发起计费推理） |

所有写操作成功后**返回同一份完整快照**，前端 `WB.api.applyLlm(snapshot)` 覆盖
`WB.data.settings` 并 `WB.go('settings')` 重渲染，无需二次 GET。

### 7.2 数据口径

- 配置源：`llm_provider` / `llm_model_definition`（业务表）+ `wiz_llm_agent_binding`（运行态表，CodeFirst）。
  启动时 `EnsureSeed()` 逐项补缺不覆盖：内置 DeepSeek 1 个、模型 2 条、Agent 分派 6 条。
- **本机私有化部署不在支持范围**：本地私有化供应商卡、免密探测、本地模型种子全部下线；
  演示数据与 DDL / 实体注释同步清理。
- 内置供应商以「内置」badge 显示（原「内置种子」文字已替换），内置卡不可删除；
  用户自建供应商卡显示「删除」按钮。
- 「支持模型」有两个入口：页头「支持模型」按钮、每张卡 chip 行右侧「管理」按钮，
  共用同一管理弹窗（切换供应商 / 添加 / 删除）。
- `chatMode = live` 只表示「已按配置装配真实 OpenAI 兼容客户端」，**不代表外网验证通过**；
  未配 Key 时 `DescribeOffline()` 给出精确原因（如「供应商「DeepSeek 深度求索」尚未配置 API Key」）。
  配置保存后 `ChatClientProvider` 按签名比对热切换，无需重启。
- API Key 只落 AES-256-GCM 密文 + 掩码，主密钥取 `Security:MasterKey`（可用
  `WIZSTAR_MASTER_KEY` 覆盖）；明文仅在用户主动点「眼睛」时经本机 IPC 取回。

### 7.3 实测验收（2026-11-12）

1. `dotnet build` 0 错误、`dotnet test` 49/49 通过。
2. `GET /api/llm/settings` → `chatMode: offline`，原因精确到「尚未配置 API Key」。
3. `PUT .../api-key` 后立即 `chatMode: live`（`/api/health` 同步），掩码 `sk-****0000`；
   `GET .../api-key` 返回明文；清除 Key 后回退 offline。
4. 新增 / 编辑 / 删除供应商、添加 / 删除支持模型、默认模型、Agent 分派全部生效；
   删除内置供应商返回契约错误码 40001；测试供应商已清理，库内只剩内置 DeepSeek。
5. `POST /api/llm/test` 真实请求 `https://api.deepseek.com/v1/models`，
   假 Key 下返回 `HTTP 401 / reachable:false`，不伪造在线。
6. 后端不可用时设置页全部交互降级为演示 toast，不产生 `console.error`。
7. **并发修复**：A2 并行预取（bootstrap + llm/settings）暴露出单例 `SqlSugarClient` 的
   `This MySqlConnection is already in use`，会让设置页偶发回退演示数据。
   已改为 `DbInitializer.CreateScopeClient()` 返回线程安全的 `SqlSugarScope`（`ISqlSugarClient`），
   8 个并发请求全部 `success=true`。
8. 截图验收 `node scripts/start-electron.js --capture --only=settings`：`errors: []`；
   页头「支持模型」入口、卡内「管理」按钮、「内置」badge、非内置卡「删除」按钮均正常，
   Agent 映射表按「真实覆盖 + 保留演示」保留 6 行，无文字溢出 / 重叠。

### 7.4 前端降级口径

- `WB.data.llmSource === 'live'` 才走真实写接口；否则 `WB.api.request` 不发起请求，
  交互仅给演示 toast。
- 首屏并行预取稍慢时，设置页 `mount()` 会自治兜底再取一次 `/api/llm/settings`；
  `llmSource` 变为 live 后不再重复请求，避免 `WB.go()` 重渲染造成循环。
- 真实 Agent 只有 2 个，映射表以演示 6 行为基底覆盖真实行，其余保留（不越刷越少）。
