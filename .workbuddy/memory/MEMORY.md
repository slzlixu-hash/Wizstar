# Wizstar 项目长期约定（AgentWorkBench 重写版）

## 项目定位

- 重写旧 AgentWorkBench（D:\WorkCode\AgentWorkBench），旧项目的坑与口径继续有效，尤其：
  - **本地回环不走代理**：环境注入 HTTP_PROXY 时会把 127.0.0.1 请求转成绝对地址（表现为 404/串服务）。已由 `Wizstar.Mcp/LoopbackBypassProxy` 统一解决，新增 HttpClient 一律挂它。
  - 风险判定四级口径：平台人工覆盖 > 工具 `x-risk`（只升不降）> 动词兜底 > 未知默认 write；审批服务端从不自动批准。
  - 对账只补缺不覆盖；移除只停用不删数据；工具装配不设数量硬上限（2026-11-13 用户取消 MaxToolsPerRun），可见范围完全由 agents.yaml 的 allowedTools 授权决定，ToolRegistry 只做通配匹配与函数名去重。
  - 统一出参信封 + 错误码归一化（40001/41001/42001/42002/43002/43009/43010/50001）。
  - 真实模型优先，离线回退显式标注 offline，不伪造在线。

## 技术事实（2026-11-12 Phase 0）

- net10.0（本机 SDK 11 rc3，net10 目标包齐全）；Microsoft.Agents.AI 1.26.0（本地缓存实测可用，1.28 也在缓存）。
- 本机环境 HTTP_PROXY=127.0.0.1:55109 常驻——凡 curl 验证本地端口必须 `--noproxy '*'`；凡新 HttpClient 必须挂 LoopbackBypassProxy。
- FunctionInvokingChatClient 步数上限不抛异常（返回空文本），步数预算要在工具包装层自实现。
- MCP JSON-RPC 响应的业务字段都在 `result` 内。
- 幂等账本 SQLite WAL（data/ledger.db），主键 (scope, operationId)，operationId 平台侧生成 op-{yyyyMMdd}-{hash16}。
- 本期内存态：会话历史与审批单在内存（重启即清空），落库属 Phase 1。
- 演示服务：`node tools/mcp-demo/server.js`（5307）；API 默认 ASPNETCORE_URLS=http://127.0.0.1:5301 可跑通全链路。

## 技术事实（A2 · LLM 与前端联调）

- **本机不部署本地私有化 LLM**（用户明确：机器配置不足）。供应商只保留公网 OpenAI 兼容 API，内置 DeepSeek；本机模型服务方案一律不引入。
- LLM 配置源：`llm_provider` / `llm_model_definition`（业务表）+ `wiz_llm_agent_binding`（CodeFirst）；种子逐项补缺、内置禁删；API Key AES-256-GCM 密文 + 掩码，明文仅 `GET /api/llm/providers/{code}/api-key` 主动取回。
- `ChatClientProvider` 按配置签名热切 live/offline；`DescribeOffline()` 给出精确原因；`POST /api/llm/test` 只探 `/models`，不发起计费推理、不伪造在线。
- **单例共享 SqlSugar 客户端必须用 `SqlSugarScope`（`ISqlSugarClient`）**：普通 `SqlSugarClient` 单例并发会抛 `This MySqlConnection is already in use`（A2 并行预取实测踩过）。
- `dotnet run` 会被 launchSettings 覆盖端口，验证必须用 `--no-launch-profile --urls http://127.0.0.1:5301`；本机常驻 `ELECTRON_RUN_AS_NODE=1`，直接调 electron.exe 会退化成纯 Node（start-electron.js 已显式删除该变量）。
- **验完必停后台 Api**：运行中的 Wizstar.Api 会独占 `bin\Debug\net10.0\Wizstar.*.dll`，用户在 Visual Studio 编译时会报 MSB3027「文件正由另一进程使用 / 超出重试计数 10」。本地验收用后台 `dotnet run` 后必须立刻 TaskStop，不要把服务一直留着；用户 IDE 要编译时更不要起。
- 前端 IPC：`api:get`（A1 只读）+ `api:request`（A2 读写），`WB.api.request` 拆信封、失败收敛为演示降级；设置页写操作返回完整快照后 `WB.api.applyLlm` + `WB.go('settings')` 刷新。
- 数据口径：真实少于演示时「真实覆盖 + 保留演示」（映射表以演示 6 行为基底）；界面原有元素一律保留，不因接真接口而删减。

## 协作方式

- 用户是「骑士」：先方案 + 影响面，确认 ok 才动代码；做什么验收什么，不自动放大回归范围。
- 命名：新项目一律 `Wizstar.*`（Wizstar.Contracts / Wizstar.Agents / Wizstar.Mcp / Wizstar.Api / Wizstar.Tests）。
