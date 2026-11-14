# WorkBenchUI 前后端联调契约（当前实现）

> 本文件描述**界面已实际接通的全部接口与数据口径**。
> 与 `CONTRACT.md` 冲突时以本文件为准；`CONTRACT.md` 中仍然有效的条款
> （页面注册契约、样式命名空间、无第三方依赖、禁止 `console.error`、1440×900 截图验收）继续适用。

## 1. 边界

界面**不做演示降级**。三条底线：

1. 拿不到数据就渲染**空态**（写清数据来源表名），不填假数字；
2. bootstrap 拿不到就整站进 `offline` 重试页，不半屏有数据半屏假数据；
3. 写操作失败**回滚界面**并 toast 报真实错误码，不改成本地成功。

## 2. 首屏加载：12 路并行

`js/api-client.js` 的 `loadAll()` 在 `DOMContentLoaded` 后一次性并发拉取，
串成一份 `WB.data` 再重渲染：

| # | 请求 | 落点 | 失败处理 |
| --- | --- | --- | --- |
| 1 | `GET /api/ui/bootstrap` | `data.app.*` / `data.agents` / `data.chatMode` | **整站 offline** |
| 2 | `GET /api/llm/settings` | `data.settings.*` | `llmSource='error'`，设置页空态 |
| 3 | `GET /api/mcp/servers` | `data.mcp.servers` / `stats` | `mcpSource='error'`，MCP 页空态 |
| 4 | `GET /api/mcp/tools` | 服务卡的工具清单 | 工具数为空 |
| 5 | `GET /api/business/dashboard` | `data.dashboard.kpis` / `pipeline` | KPI 空态 |
| 6 | `GET /api/business/products` | `data.products.*` | 商品页空态 |
| 7 | `GET /api/business/orders` | `data.orders.*` | 订单页空态 |
| 8 | `GET /api/business/shops` | `data.shops.*` | 店铺页空态 |
| 9 | `GET /api/settings/risk` | `data.settings.riskPolicy` | 风控 Tab 空态 |
| 10 | `GET /api/settings/environment` | `data.settings.environment` / `toggles` | 环境 Tab 空态 |
| 11 | `GET /api/agents/stats` | `data.team.stats` | 统计条空态 |
| 12 | `GET /api/approvals?status=pending&limit=20` | `data.dashboard.tasks` | 待审批区空态 |

`WB.api.reload()` 重跑同一套；`WB.api.refreshSettings()` / `refreshBusiness(key)` 只刷对应区块。

## 3. 端点清单

所有响应均为统一信封 `{ success, data, error, traceId }`。
错误码：`40001` 入参/业务校验、`41001` 未找到、`42001` 冲突、`42002` 状态不允许、
`43002` 治理拒绝、`43009` 上游失败、`43010` 超时、`50001` 内部错误。

### 3.1 聚合与 Agent

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/ui/bootstrap` | 聚合快照：`endpoint / version / chatMode / chatOfflineReason / agents / mcp` |
| GET | `/api/agents` | Agent 名册（key、name、displayName、description、enabled、maxSteps、allowedTools） |
| GET | `/api/agents/stats` | 名册在线数 + 操作账本近 7 日真实调用量与成功率 |
| GET | `/api/agents/{key}` | 单个 Agent 完整配置（含完整 `systemPrompt`），不存在返回 404 + `40001` |
| POST | `/api/agents/{key}/chat` | 单轮对话（真实模型 / 离线原因如实返回） |

`/api/agents/stats` 的空态口径：账本无记录时返回 0，**不伪造「今日调用量」**；
文案统一写「账本操作」，与 `OperationLedger` 一致。

### 3.2 HITL 审批

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/approvals?status=&limit=` | 审批队列（`pending / approved / rejected`） |
| GET | `/api/approvals/{id:guid}` | 单张审批单详情 |
| POST | `/api/approvals/{id:guid}/approve` | 批准并继续执行 |
| POST | `/api/approvals/{id:guid}/reject` | 拒绝 |

服务端**从不自动批准**；`irreversible` 无论风控策略如何都强制走审批（纵深防御，见 §4）。

### 3.3 MCP 服务管理

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/mcp/servers` | 清单快照（含 `url / state / toolCount / serverName / serverVersion`） |
| POST | `/api/mcp/servers` | 新建：校验 ID / 名称 / URL，保存即握手，重复 ID 返回 `42001` |
| PUT | `/api/mcp/servers/{id}` | 编辑：重写清单 + 重握手；凭证未提交则沿用旧值 |
| DELETE | `/api/mcp/servers/{id}` | **只停用不删数据**（`MarkRemoved`） |
| POST | `/api/mcp/servers/{id}/handshake` | 手动握手（`initialize` + `tools/list`） |
| POST | `/api/mcp/servers/{id}/disconnect` | 运行时停用，可再次握手恢复 |
| POST | `/api/mcp/reconcile` | 全量对账（只补缺不覆盖） |
| GET | `/api/mcp/tools` | 全部工具清单（name、serverId、declaredRisk） |
| POST | `/api/mcp/tools/call` | **只放行 `read` 工具**；`write` / `irreversible` 一律 `43002` |

- 清单落盘 `src/Wizstar.Api/config/mcp-services.json`，`JsonNode` 原子写（tmp + `File.Move(overwrite)`），
  用 `UnsafeRelaxedJsonEscaping` 保证中文不被转成 `\uXXXX`。
- 启动对账读取平台开关 `toggle.auto-handshake`，关闭时只登记清单不建连。

### 3.4 模型与 API Key（`/api/llm/*`）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/llm/settings` | 聚合快照：供应商 / 支持模型 / 默认模型 / Agent 分派 / chatMode |
| POST | `/api/llm/providers` | 新增自定义供应商（可一次带入多个模型 ID） |
| PUT | `/api/llm/providers/{code}` | 编辑名称 / Base URL / 启用状态（可随编辑一并写 Key） |
| DELETE | `/api/llm/providers/{code}` | 删除供应商（内置禁删 → `40001`） |
| PUT | `/api/llm/providers/{code}/api-key` | 写入 Key（AES-256-GCM 密文 + 掩码） |
| GET | `/api/llm/providers/{code}/api-key` | 主动取回明文（眼睛按钮），不进快照 / 日志 |
| POST | `/api/llm/providers/{code}/models` | 添加支持模型 |
| DELETE | `/api/llm/providers/{code}/models?modelId=` | 删除支持模型 |
| PUT | `/api/llm/default-model` | 设置默认全局模型 |
| PUT | `/api/llm/bindings` | 保存 Agent → 模型分派 |
| POST | `/api/llm/test` | `GET {baseUrl}/models` 真实探测，**不发起计费推理** |

写操作成功后返回**同一份完整快照**，前端 `WB.api.applyLlm(snapshot)` 覆盖 `WB.data.settings`
并刷新设置页，无需二次 GET。

### 3.5 业务域（只读）

| 方法 | 路径 | 数据来源 |
| --- | --- | --- |
| GET | `/api/business/products` | `sku_project` + `sku_variant` + `sku_channel_listing` |
| GET | `/api/business/orders` | `ecom_order` + `ecom_order_item` + `store_instance` |
| GET | `/api/business/shops` | `store_instance` + 今日 GMV 聚合 |
| GET | `/api/business/dashboard` | 4 张 KPI（销售额 / 订单量 / 毛利率 / HITL 待审批）+ 5 段 pipeline（按 `SkuProject.Status` 计数） |

全部 `InvariantCulture` 格式化（`Money` / `Num` / `Stamp` / `Day`），避免受系统区域设置影响。

> **现状**：这几张业务表**结构已存在但零数据**，因此三页显示的是真实空态
> （文案写明「业务表 `sku_project` 当前为空」）。是否灌种子数据 / 接真实电商数据源属产品决策，
> 未拍板前不写入任何假数据。

### 3.6 平台配置（KV）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/settings/risk` | 三级风险策略（read / write / irreversible）+ 说明 |
| PUT | `/api/settings/risk/{id}` | 切换 `auto` / `manual`；`irreversible` 锁定 → `43002` |
| GET | `/api/settings/environment` | 端点、模型通道、数据库连接（密码脱敏 `password=****`）、开关 |
| PUT | `/api/settings/environment/{id}` | 切换开关，返回 `effective: 已实时生效 \| 需重启进程生效` |

- 复用业务表 `sys_risk_policy`（`policy_key / policy_name / policy_value / description / updated_at`）作 KV 表。
- 键名约定：`risk.{level}.execute` → `auto|manual`；`toggle.{id}` → `on|manual`。
- `RuntimeSettingsStore` 在 `Wizstar.Data/Settings/`，日志走 `Action<string>? log` 回调（Data 层不引 `Microsoft.Extensions.Logging`）。

### 3.7 幂等账本

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/operations/{operationId}` | 按操作号查账本记录 |
| GET | `/api/operations?since=&limit=` | 增量拉取（`ListSinceAsync`） |

主键 `(scope, operationId)`；`operationId` 由平台侧生成 `op-{yyyyMMdd}-{hash16}`。

## 4. 风控策略真实闭环

```
sys_risk_policy  ──► DbRiskPolicyProvider (Api 层)
                          │ 实现
                          ▼
              IRiskPolicyProvider (Agents 层，不依赖 Data)
                          │
                          ▼
                     ToolInvoker
        forcedApproval = (risk == "irreversible")   ← 纵深防御
        if (forcedApproval || !policy.IsAutoExecute(risk)) → 挂审批
```

- `DefaultRiskPolicyProvider`：read/write 自动、irreversible 审批。
- `DbRiskPolicyProvider`：读 `sys_risk_policy`，**irreversible 恒定 false**（配置改不动这条红线）。
- 实测：`PUT /api/settings/risk/write {"auto":false}` → `risk.write.execute = manual` 落库，
  回显 `auto=false`；对 `irreversible` 写入返回 `43002`。
- 单测 `tests/Wizstar.Tests/RiskPolicyProviderTests.cs` 覆盖四种口径，含「策略允许也必须审批」。

## 5. 启动与验收

```bash
# 1) 后端（另开终端；不带 launch profile，否则端口被覆盖）
cd src/Wizstar.Api
dotnet run --no-launch-profile --urls http://127.0.0.1:5301

# 2) 可选：抖店罗盘 MCP 服务（MCP 页要显示在线就得起）
cd tools/mcp-douyin-compass && node server/index.js     # 5206

# 3) 前端
cd WorkBenchUI && node scripts/start-electron.js
```

> `launchSettings.json` 已设 `launchBrowser: false`，端口统一 `http://127.0.0.1:5301`，
> 不会再自动弹 `https://localhost:63932/`。

验收口径：

1. `dotnet build` 0 错误 0 警告；`dotnet test` 全绿。
2. 登录页状态灯 online、端口显示 `127.0.0.1:5301`、右下角显示真实版本号。
3. 工作台 KPI / pipeline / 待审批为真实数据；无数据时是空态而非假数字。
4. MCP 页服务状态与 `5206` 实际监听一致：没起就显示「异常」，起了握手后显示「在线」。
5. **停掉后端** → 整站进离线页 + 重试按钮，`console.error` 为空。
6. `node scripts/start-electron.js --capture` 8 页全绿、`errors: []`。

## 6. 已知待办

| 项 | 状态 |
| --- | --- |
| `chatMode` 仍为 `offline` | 原因「供应商「DeepSeek 深度求索」尚未配置 API Key」，需在设置页填入真实 Key |
| 设置页「设为默认模型」入口 | 后端 `PUT /api/llm/default-model` 已有，前端未挂入口 |
| 业务表零数据 | 需产品决策：灌种子数据 or 接真实电商数据源 |
| 登录鉴权 | 本期为本地会话，`sys_user` 未接入 |
