# WorkBenchUI 前后端联调契约（A1 · v1.0）

> 本文件是 **A1 联调阶段** 的约定。与 `CONTRACT.md` 冲突时，以本文件为准；
> `CONTRACT.md` 中未被本文件放宽的条款（页面注册契约、样式命名空间、离线无第三方依赖、
> 禁止 `console.error`、1440×900 截图验收等）继续有效。

## 1. 目标与边界

让 Electron 界面从「纯演示」升级为「能显示真实后端数据」，且**后端不可用时自动回退演示数据**，
界面不白屏、不报错、不依赖网络。

本期只接**只读**数据：

| 来源 | 落点 |
|---|---|
| `GET /api/ui/bootstrap`（聚合 health / agents / mcp） | `WB.data.agents` / `WB.data.mcp` / `WB.data.app.endpoint` |
| 登录页服务状态灯 | `.status-dot`（online / offline） |

**明确不做（留 A2）**：chat 流式对话、HITL 审批操作、登录鉴权（`sys_user`）、
settings 写配置、dashboard KPI 业务数据（业务表尚无数据）、MCP 握手/对账等写操作。

## 2. 放宽的契约约束

`CONTRACT.md` §1「只做界面、不接任何后端接口」与 §3 文件所有权，在 A1 中放宽如下：

| 文件 | A1 允许 | 说明 |
|---|---|---|
| `electron/main.js`、`electron/preload.js` | 允许修改 | 新增本地 API 只读 IPC 代理 |
| `electron/api-proxy.js` | **新增** | 代理实现，供 main.js 与截图脚本共用 |
| `scripts/capture.js` | 允许修改（仅注册代理） | 截图脚本自身是主进程，也需注册 `api:get` |
| `renderer/index.html`、`renderer/login.html` | 允许各加一行 script | 引入 `js/api-client.js` |
| `renderer/js/api-client.js` | **新增** | 联调数据层（本阶段唯一新增渲染层文件） |
| `renderer/js/mock-data.js` | **仍然禁止修改** | 真实数据通过运行时覆盖 `WB.data` 注入 |
| 各页面 `js/pages/*`、`styles/pages/*` | **仍然禁止修改** | 页面靠 `WB.go()` 重渲染自动消费新数据 |

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
api-client.js → window.workbench.apiGet(path) → ipcRenderer.invoke('api:get')
              → 主进程 fetch(http://127.0.0.1:5301 + path) → 统一信封
```

- 主进程只放行 `/api/` 开头的相对路径，拒绝 `..`、`\`、`://`；超时 2.5s。
- `apiGet` **永不 reject**，失败返回 `{ ok:false, error }`，渲染层据此降级。
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
