# Wizstar 项目长期约定（AgentWorkBench 重写版）

## 项目定位

- 重写旧 AgentWorkBench（D:\WorkCode\AgentWorkBench），旧项目的坑与口径继续有效，尤其：
  - **本地回环不走代理**：环境注入 HTTP_PROXY 时会把 127.0.0.1 请求转成绝对地址（表现为 404/串服务）。已由 `Wizstar.Mcp/LoopbackBypassProxy` 统一解决，新增 HttpClient 一律挂它。
  - 风险判定四级口径：平台人工覆盖 > 工具 `x-risk`（只升不降）> 动词兜底 > 未知默认 write；审批服务端从不自动批准。
  - 对账只补缺不覆盖；移除只停用不删数据；工具装配硬上限 8 超限拒绝启动。
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

## 协作方式

- 用户是「骑士」：先方案 + 影响面，确认 ok 才动代码；做什么验收什么，不自动放大回归范围。
- 命名：新项目一律 `Wizstar.*`（Wizstar.Contracts / Wizstar.Agents / Wizstar.Mcp / Wizstar.Api / Wizstar.Tests）。
