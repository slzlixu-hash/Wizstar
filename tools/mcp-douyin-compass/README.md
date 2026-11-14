# mcp-douyin-compass

抖店电商罗盘选品 MCP 服务（Streamable HTTP / JSON-RPC 2.0，规范 V1.0）。

仿照「观星树运营插件 v2.3.0」的逆向结论实现，但**只做采集与归一化，不做入库**：
把「选品」拆成 4 个高阶语义工具，借浏览器已登录的罗盘页面会话取数，
返回结构化商品清单；写业务库由 `Wizstar.Api` / Agent 层决定（规范 §1.1 铁律）。

---

## 1. 架构

```
Wizstar.Api ──MCP-HMAC/JSON-RPC──> server/index.js (:5206)
                                      │
                    ┌─────────────────┼──────────────────┐
                    │                 │                  │
              server/envelope    server/bridge.js    server/ledger.js
              server/hmac.js     (WS 手写帧编解码)   (SQLite WAL 幂等)
              server/tools.js          │
              server/compass.js   WS :5206/ws
              server/parser.js         │
              server/filter-dsl.js  extension-mv3/sw.js
                                      │ chrome.runtime
                                 content.js (ISOLATED)
                                      │ window.postMessage
                                 inject.js (MAIN world)
                                      │ fetch(credentials:'include')
                              compass.jinritemai.com
```

**借页面会话**：罗盘 Cookie 只留在浏览器主世界，探针只回传响应体，
绝不读取/回传 Cookie、Authorization、Set-Cookie（规范 §2.3 安全红线）。
不实现 `a_bogus` 签名、不绕过滑块风控、不做浏览器自动开窗。

---

## 2. 目录

| 路径 | 职责 |
|---|---|
| `server/index.js` | HTTP 骨架：`/mcp`、`/healthz`、`/selectors.json`、`/ws` 升级 |
| `server/envelope.js` | 统一出参信封 + 8 个契约错误码 |
| `server/hmac.js` | MCP-HMAC 校验（±300s 时间戳 + nonce 600s 防重放） |
| `server/tools.js` | 7 个工具定义 + 入参校验 + 统一包信封 |
| `server/bridge.js` | WS 桥接：channelToken 握手、代际号、20s 等待器、串行队列、心跳 |
| `server/ledger.js` | 幂等账本：SQLite WAL（Node ≥22.5）或 JSONL 原子落盘降级 |
| `server/parser.js` | `$$` 九榜归一化、V0/V1 词与词下商品、区间价拆分、类目树 |
| `server/filter-dsl.js` | `c1` 字段字典、`e1` 别名、分桶、`b1` 二级筛选 |
| `server/selectors.json` | **单一热更新源**：9 条榜单规则 + 搜索词/类目接口 + DOM 选择器 |
| `extension-mv3/` | MV3 轻量探针（manifest / sw / content / inject） |
| `test/` | 5 组冒烟脚本 + `all.js` 统一入口 + fixtures |

---

## 3. 启动

```bash
# 服务（默认 127.0.0.1:5206，零依赖）
cd tools/mcp-douyin-compass
node server/index.js

# 生产建议开启鉴权（与 mcp-services.json 的 authType / authKeyId / authSecret 对齐）
WIZSTAR_COMPASS_HMAC_SECRET='<secret>' \
WIZSTAR_COMPASS_HMAC_KEY_ID='wizstar-local' \
node server/index.js

# 鉴权三档（自上而下短路）：
#   1. 回环免签：127.0.0.1 / ::1 直连放行（默认开；WIZSTAR_COMPASS_AUTH_LOOPBACK_BYPASS=0 关闭）
#   2. Bearer 静态令牌：Authorization: Bearer <keyId:secret|secret>，第三方工具免算签名秒级接入
#   3. MCP-HMAC 严格验签：跨公网高危通道，ts 容差 ±300s + nonce 防重放
```

> 本机常驻 `HTTP_PROXY`，验证本地端口一律 `curl --noproxy '*'`。
> 服务只绑 `127.0.0.1`，`node:sqlite` 会打印 ExperimentalWarning（Node 22 属正常，可忽略）。

**安装探针扩展**：Chrome/Edge → 扩展程序 → 开发者模式 →
「加载已解压的扩展程序」→ 选择 `extension-mv3/`，然后打开并登录
`https://compass.jinritemai.com`。SW 会自动连 `ws://127.0.0.1:5206/ws`。

改 `server/selectors.json` 后**无需重发扩展**：探针每次任务前从
`GET /selectors.json` 拉取最新规则（服务未启动时退回扩展缓存）。

---

## 4. 工具（7 个，全部 `read`，免审批）

| 工具 | 说明 |
|---|---|
| `meta.health` | 服务状态、Uptime、凭证模式、探针连接/登录态、账本条目数 |
| `meta.describe` | 协议版本、Schema 目录、9 榜单字典、二级筛选项、并发限额 |
| `meta.list_operations` | 按 `operationIds` / `since` 反查幂等账本（孤儿对账） |
| `get_compass_categories` | 同步类目树到服务内部缓存 |
| `get_compass_product_rank` | 9 大榜单采集 → 归一化 → 二级筛选 → 立项摘要 + Top 商品 |
| `get_compass_search_words` | `data_range_v2` 取最新日期 → `compass_rank_v3` 分页拉词 |
| `get_compass_word_products` | 逐词 `industry_detail_list_v2` 拉词下商品 |

> **命名口径**：项目 `RiskClassifier` 按工具名开头做动词兜底
> （`get_/query_/search_/list_/fetch_/count_/meta.` 为 read），且 `x-risk` 只升不降。
> 因此语义工具一律 `get_compass_*`，避免 `sync_*` / `compass.*` 被判成 write 触发审批。

`filters` 形如 `{ "new_pay_amt": "3" }`（字段 → 桶下标字符串）。
可用字段与桶清单见 `meta.describe` 的 `dictionaries.secondFilterFields`。

---

## 5. 契约要点

- **统一信封**：`{ success, data, usage, error{code,message,retryable}, server, traceId, replayed }`。
- **8 个契约码**：40001 入参 / 41001 鉴权 / 42001 限频(可重试) / 42002 额度 /
  43002 权限 / 43009 幂等冲突 / 43010 业务拒绝 / 50001 网络(可重试)。
  仅 42001、50001 的 `retryable=true`。
- **HMAC 签名原串**（与 `Wizstar.Mcp/McpHmacSigner.cs` 一致）：
  `{method}\n{path}\n{ts}\n{nonce}\n{sha256hex(rawBody)}\n{keyId}`，
  `sig = base64url(HMAC-SHA256(secret, 原串))`。
  `GET /healthz` 免签（无副作用）；nonce TTL 600s。
  > 规范 §2.2 提到重放专用码 `41009`，但 §5.2 契约码表与
  > `Wizstar.Contracts.ErrorCodes` 均未收录；按「错误码归一化」铁律收敛为 `41001`，
  > message 里如实标注规范来源。
- **幂等**：`operationId` 由平台下发（格式 `op-{taskId}-{stepCode}-{hash16}`），
  服务绝不自行生成。同键同参回放 `replayed:true` 且不二次采集；改参返回 43009；
  `EXECUTING` 孤儿记录按「只补缺不覆盖」允许重跑。账本保留 30 天。
- **价格口径**：统一「分」，`priceMinCents / priceSuggestedCents / priceMaxCents`，
  区间价拆 min/max、建议价取中值或 DOM 读数；词下商品另给 `priceYuan`（展示用元）。
  修正原版「无脑取最小值 + 实时榜硬编码 0.01 + 元/分混淆」三个缺陷。

---

## 6. 与原版观星树插件的差异（安全加固）

| 项 | 原版 | 本实现 |
|---|---|---|
| 权限 | `<all_urls>` + cookies + DNR | 仅 `storage` + 罗盘域名 + `127.0.0.1:5206` |
| 消息分流 | 不判 `type`，`API_RESPONSE` 会覆盖 `storage.category` | inject/content 双向 type 白名单，类目单独缓存 |
| 通道鉴权 | 无 | 动态 `channelToken` 握手（WS CHALLENGE → HELLO，每次连接轮换） |
| 请求改写 | 只改 `init.body`，`Request` 自身 body 不改 | clone().text() 读自身 body 并重建 Request |
| 出站域名 | `PAGE_FETCH` 无白名单，任意页面可借会话访问外域 | 服务端 + inject 双层白名单锁死 `compass.jinritemai.com` |
| 凭证 | SW 直接收集抖音 Cookie、明文存 token | 不读取/不回传任何 Cookie 或凭证 |
| 任务状态 | 面板内全局状态机 | 服务无全局业务状态；代际号作废、20s 等待器、串行队列 |

**已知边界**：MAIN world 的 `window.postMessage` 对同源页面脚本可见，
`channelToken` 理论上可被同页脚本观测；因此出站域名白名单与「只回传响应体」
是最后一道硬约束。恶意页面最多只能触发罗盘域名的 GET，拿不到凭证与跨站数据。
平台 ToS（自动化翻页）风险由使用方自行评估；抖店改版时用 `selectors.json` 热更新。

---

## 7. 测试

```bash
cd tools/mcp-douyin-compass
npm test                     # 统一入口：顺序跑 5 组，共 117 项
```

| 分组 | 脚本 | 项数 |
|---|---|---|
| 步骤1 信封 / HMAC / 工具目录 | `test/smoke.js` | 24 |
| 步骤2 WS 帧 / 握手 / 代际 / 幂等账本 | `test/bridge-smoke.js` | 23 |
| 步骤3 MV3 契约 / 安全加固 / selectors | `test/extension-smoke.js` | 31 |
| 步骤4 九榜解析 / 分桶 / 二级筛选 | `test/parser-smoke.js` | 24 |
| 步骤5 4 个语义工具端到端 | `test/e2e-smoke.js` | 15 |

所有冒烟用临时端口与临时账本目录，**不污染**真实 `data/`。
端到端用「真实 WS 握手 + 模拟罗盘响应」，无需真实登录即可验证全链路。
步骤 1 同时覆盖「账本已接线」与「账本未接线如实标注」两条分支，
因此不受 `server/index.js` 可选模块自动接线顺序影响。

---

## 8. 平台接入与配置口径

已在 `src/Wizstar.Api/config/mcp-services.json` 注册（`autoStart: false`）：

```json
"mcp-douyin-compass": {
  "name": "抖店罗盘选品（本地）",
  "transport": "http",
  "url": "http://127.0.0.1:5206",
  "autoStart": false
}
```

启动本服务后启动 `Wizstar.Api`，平台会自动 `initialize` → `tools/list` 完成对账。
实测 `GET /api/mcp/servers` 返回 `state=connected`、`toolCount=7`、
`protocolVersion=2025-06-18`；`GET /api/mcp/tools` 可见 7 个工具且均为 `read`。

**已决策（2026-11-13）**：取消 `ToolRegistry.MaxToolsPerRun` 设定。
本服务接入后 `commander` 的 `allowedTools: ["*"]` 装配
`builtin 3 + compass 7 = 10` 个工具；原硬上限 8 会让 `POST /api/agents/commander/chat`
返回 `40001 ... 拒绝启动`（报错里的「当前 9」是第 9 个触发即抛的计数，不是总数）。
先短暂上调到 12，随后按用户要求彻底取消：`ToolRegistry` 只做通配匹配与模型函数名去重，
装配数量完全由 `allowedTools` 授权决定，不再因超限拒绝启动。
实测 `assembledTools=10`，`agents.yaml` 无需改动；`scout` 只装配 2 个工具。
`tests/Wizstar.Tests/AgentCatalogTests.cs` 的
`WildcardAuthorization_AssemblesAllTools_WithoutLimit` 用 20 个工具验证不设限。
工具可见面的收敛责任前移到授权清单：需要控制 Context 体积时请收窄 `allowedTools`。

同时从 `mcp-services.json` 移除 `mcp-demo`（5307）注册项，
消除未启动演示服务造成的非致命握手失败日志与 `state=error`；
`tools/mcp-demo/` 代码保留，需要演示链路时重新注册即可。

**鉴权**：默认 `off`。生产启用时，需同时设置服务端
`WIZSTAR_COMPASS_HMAC_SECRET` / `WIZSTAR_COMPASS_HMAC_KEY_ID` 与
`mcp-services.json` 的 `authSecret` / `authKeyId`，二者必须一致。
平台侧 `authType` 四档：`none`（本地直连免鉴权，默认）/ `bearer`（标准 API Key）/
`header`（自定义头，配 `authHeaderName`）/ `hmac`（仅跨公网高危服务）。
外部工具（Inspector / curl / 第三方 Agent）调本服务时，除 `MCP-HMAC` 签名外，
也可直接带 `Authorization: Bearer <keyId>:<secret>` 或裸 `<secret>` 免算签名；
本机 `127.0.0.1` 直连默认免签（对外监听时用 `WIZSTAR_COMPASS_AUTH_LOOPBACK_BYPASS=0` 关闭）。
