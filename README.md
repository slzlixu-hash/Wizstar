# Wizstar —— AgentWorkBench 重写版（Phase 0：MAF 内核 + MCP 即插即用）

对旧项目 `D:\WorkCode\AgentWorkBench` 的干净重写。本期目标是可编译、可运行、可验证的
MAF（Microsoft Agent Framework）基础框架 + MCP「即插即用」，后续阶段在此之上迭代。

技术栈：.NET 10（net10.0）+ Microsoft.Agents.AI 1.26 + SqlSugarCore（MySQL 业务库）+ SQLite（幂等账本）+ YamlDotNet。
MySQL 的连接串在 `src/Wizstar.Api/appsettings.json` 的 `Database:MySql`；启动时 CodeFirst 自动建库建表，连不上只降级告警、不阻塞启动。

### 数据库结构

- `src/Wizstar.Data`：SqlSugar 持久层实体，`wiz_agent_session` / `wiz_approval` / `wiz_operation_ledger` 由启动时 CodeFirst 同步。
- `db/migrations/V1__agentworkbench_schema.sql`：完整业务库 DDL（6 大域 23 张表，规范 v2.0），全部 `CREATE TABLE IF NOT EXISTS`，可重复执行。首次部署执行：

```bash
mysql -uroot -p --default-character-set=utf8mb4 Wizstar < db/migrations/V1__agentworkbench_schema.sql
```

> 业务表含 `JSON` / `VARBINARY` / 外键等原生结构，按 DDL 脚本管理；`wiz_*` 三张运行态表由 SqlSugar CodeFirst 管理，两者互不影响。

**业务表实体（DbFirst 反向生成）**：`src/Wizstar.Data/Entities/Business/` 下 23 个 `partial class`，
由 `tools/Wizstar.DbFirstGen` 从库结构生成（PascalCase 类名/属性 + `[SugarTable]` / `[SugarColumn(ColumnName=...)]` 显式列名）。

```bash
dotnet run --project tools/Wizstar.DbFirstGen              # 重建全部业务实体
dotnet run --project tools/Wizstar.DbFirstGen -- --smoke   # 重建 + 插入/查询/删除冒烟验证
```

约定：MySQL `JSON` 列统一映射为 `string`（原始 JSON 文本，业务侧用 `System.Text.Json` 解析）；
`VARBINARY` → `byte[]`；`TINYINT(1)` → `bool`。生成文件为 nullable-oblivious，顶部带 `#nullable disable`。
表结构变更后重跑生成器即可（会自动排除 `wiz_*` 运行态表）。

## 目录结构

```
Wizstar.slnx
Directory.Build.props            # net10.0 / nullable / 统一编译约定
config → src/Wizstar.Api/config/
  agents.yaml                    # Agent 名册（人设 + 通配授权 + 步数预算，热加载）
  mcp-services.json              # MCP 声明式清单（即插即用 Step 1，热加载）
src/
  Wizstar.Contracts/             # 统一出参信封 / 错误码归一化 / ApiException
  Wizstar.Agents/                # MAF 内核
    Profiles/                    #   AgentProfile + agents.yaml 注册表
    Tools/                       #   IToolProvider / ToolRegistry（按 allowedTools 通配授权装配）/ 内置演示工具
    Governance/                  #   风险分级（x-risk > 动词兜底 > 默认 write）+ HITL 审批闸门
    Ledger/                      #   SQLite WAL 幂等账本（回放 / 防篡改 43009）
    Runtime/                     #   ChatClient 供给（OpenAI 兼容 + 离线回退）/ AgentRunner / 会话
  Wizstar.Mcp/                   # MCP 即插即用
    McpJsonRpcClient.cs          #   Streamable HTTP JSON-RPC 2.0（握手/会话/x-risk/MCP-HMAC）
    McpCatalog.cs                #   服务清单 + 运行状态机 + 工具缓存
    McpReconciler.cs             #   对账循环（只补缺/标记移除，不覆盖）
    McpHealthMonitor.cs          #   /healthz 心跳（离线剔除工具，恢复自动补回）
    McpToolProvider.cs           #   工具缓存 → IToolProvider 桥接（即插即用 Step 3）
    LoopbackBypassProxy.cs       #   回环直连（防 HTTP_PROXY 串流，旧项目踩坑复刻）
  Wizstar.Api/                   # WebAPI 宿主（端点 + 统一信封中间件 + CORS）
tools/mcp-demo/                  # 零依赖 Node 演示服务（统一信封 + x-risk + 可选 HMAC）
tests/Wizstar.Tests/             # 49 个单测（含进程内假 MCP 服务的集成测试）
```

## 运行

```bash
dotnet build Wizstar.slnx
dotnet test  Wizstar.slnx                      # 49 个测试
node tools/mcp-demo/server.js                  # 演示 MCP 服务（默认端口 5307）
cd src/Wizstar.Api && dotnet run               # API（默认配置见 appsettings.json / launchSettings）
```

接入真实模型：在 `src/Wizstar.Api/appsettings.json` 填 `LLM:BaseUrl / ApiKey / Model`
（任意 OpenAI 兼容端点）。不配置则离线回退，响应显式标注 `offline`，不伪造在线。

## 端点（最小集）

| 端点 | 说明 |
|---|---|
| GET  /api/health | 健康（账本自检 / 模式 / Agent 数 / MCP 连接统计） |
| GET  /api/agents | Agent 名册（人设由后端固化） |
| POST /api/agents/{key}/chat | 对话（`Accept: text/event-stream` 走 SSE，否则 JSON） |
| GET  /api/mcp/servers | MCP 服务快照（状态灯：connected / offline / error / disabled） |
| POST /api/mcp/reconcile | 声明清单对账（只补缺 / 标记移除 / 指纹变更重握手） |
| POST /api/mcp/servers/{id}/handshake | 单服务握手 + 拉取工具 |
| GET  /api/mcp/tools | 当前可装配的 MCP 工具（离线服务自动剔除） |
| GET/POST /api/approvals(/{id}/approve|reject) | HITL 审批单生命周期 |
| GET  /api/operations/{id}?scope= | 幂等账本反查（孤儿对账） |
| GET  /api/ui/bootstrap | 前端首屏只读聚合（health / agents / mcp 快照，见 `WorkBenchUI/INTEGRATION.md`） |
| GET  /api/agents/stats | 名册在线数 + 操作账本近 7 日真实调用量与成功率 |
| GET  /api/agents/{key} | 单 Agent 完整配置（含 `systemPrompt`） |
| POST/PUT/DELETE /api/mcp/servers(/{id}) | MCP 服务注册 / 编辑重握手 / 停用（只停用不删数据） |
| POST /api/mcp/servers/{id}/disconnect | 运行时停用，可再次握手恢复 |
| POST /api/mcp/tools/call | 只读工具调用（`write`/`irreversible` 一律 `43002`） |
| GET  /api/llm/settings 等 11 个 | 供应商 / 支持模型 / API Key / 默认模型 / Agent 分派 / 连通性探测 |
| GET  /api/business/{products\|orders\|shops\|dashboard} | 商品 / 订单 / 店铺 / 工作台 KPI（真实业务表，只读） |
| GET/PUT /api/settings/{risk\|environment} | 风控策略与环境开关（复用 `sys_risk_policy` 作 KV） |

## 关键口径（与三份规范文档对齐）

1. **即插即用**：放进 `config/mcp-services.json` → 启动/刷新自动握手 → `tools/list`
   缓存工具（含 `x-risk`）→ Agent 通配授权后无感可用；拔掉服务心跳置 offline、
   工具自动剔除、恢复自动补回——即拔不崩。
2. **风险与 HITL**：`x-risk` 显式声明优先（只升不降）→ 动词兜底 → 未知默认 write；
   `irreversible` 强制挂起人工审批，服务端从不自动批准，批准后的下一次同
   `operationId` 调用才真正执行。
3. **幂等**：所有副作用操作平台侧注入 `op-{yyyyMMdd}-{hash16}`，SQLite WAL 账本
   `(scope, operationId)` 主键；同参回放 `replayed:true`，参数被篡改报 `43009`。
4. **工具可见面**：不设单次运行工具数硬上限（2026-11-13 取消 `MaxToolsPerRun`）；
   装配范围完全由 `agents.yaml` 的 `allowedTools` 授权清单决定，`ToolRegistry`
   只做通配匹配与函数名去重。控制 Context 体积靠收窄授权，而不是运行时拒绝启动。
5. **回环直连**：本地 MCP 不走系统代理（`LoopbackBypassProxy`），避免
   HTTP_PROXY 把 127.0.0.1 的请求串成绝对地址转发。

## 桌面控制台（WorkBenchUI）

`WorkBenchUI` 是 Electron 桌面控制台，**无演示数据**：启动时经主进程 IPC 代理并行拉取
12 路真实接口（bootstrap / Agent / 审批 / MCP / 模型配置 / 业务域 / 平台配置），
一次性构建界面数据。`GET /api/ui/bootstrap` 是唯一的「后端可用」判据——
失败则整站进离线重试页，成功但单个接口失败只清空对应区块，**不伪造数据也不回退演示值**。
启动顺序与端点清单见 `WorkBenchUI/INTEGRATION.md`。

## 后续阶段

- Phase 1：MySQL 业务库 + 会话持久化 + Skill YAML 运行时（SOP + 通配授权 + 步数）
- Phase 2：Workflow 编排（DAG/线性管线）+ 记忆体系（工作记忆 / 案例库 / 规则库）
- Phase 3：stdio 托管进程（Lifecycle Supervisor）+ Electron 前端 + 多模态创意链
