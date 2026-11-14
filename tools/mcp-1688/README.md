# 1688 采购 MCP 服务（MAF 架构 · V1.0）

按《MAF 架构下 MCP 服务开发规范 V1.0》重构后的 1688 选品/询价/采购 MCP 服务。

> 定位：**无状态的副作用执行器 + 本地幂等账本**。它不生成业务指令、不直连业务主库，
> 只执行 MAF 下发的 `operationId`，并把 1688 的浏览器抓取能力包装成可审计、可重放、
> 按风险分级的语义工具。

```
MAF Agent ──JSON-RPC 2.0 / Streamable HTTP──▶ POST /mcp
                                              │  MCP-HMAC 验签（±300s + nonce 防重放）
                                              │  X-Shop-Credential 凭证隔离（不进 body）
                                              ▼
                                       工具目录（分层）
                              语义 6 个 ｜ 元 3 个 ｜ 通用 7 个（默认隐身）
                                              ▼
                                      适配器（mock / real）
                                    Playwright + 1688 页面 / mtop
                                              ▼
                                  本地幂等账本 SQLite WAL（.data/ledger.db）
```

## 1. 快速开始

要求 **Node.js ≥ 22.5**（依赖内置 `node:sqlite`）。

```bash
cd tools/mcp-1688
npm install

# 本机开发模式：不配密钥 = 免鉴权（只绑 127.0.0.1），平台可直接握手
npm start

# mock 适配器（离线、不启动 Chrome，适合联调/演示）
MCP_1688_MOCK=1 npm start

# 生产/跨机部署：显式配置密钥（启用 MCP-HMAC + Bearer 两档）
MCP_HMAC_KEYS='{"dev":"dev-secret"}' npm start
```

启动后：

```bash
curl -s http://127.0.0.1:5207/healthz            # 探活，<50ms，无副作用（含 auth 口径）
npm run sign -- --key-id dev --secret dev-secret \
  --body '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' --curl
```

`npm run sign` 会输出可直接粘贴执行的 `curl` 命令；也可以不加 `--curl`，拿到
`authorization` 头自己拼。

真实抓取模式（默认）：不设 `MCP_1688_MOCK` 即走 Playwright。首次使用需完成一次 1688 登录：

```bash
# 桌面环境（有头）调用一次登录工具，扫码/滑块通过后登录态会持久化到
# ~/.1688/profiles/default（可用 Z1688_PROFILE_DIR 覆盖）
MCP_HMAC_KEYS='{"dev":"dev-secret"}' npm start
# 然后按 scripts/sign.mjs 生成的 curl 调用 1688.session.login
```

## 2. 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MCP_HOST` / `MCP_PORT` | `127.0.0.1` / `5207` | 监听地址。默认只绑回环，符合“本地执行器”定位 |
| `MCP_HMAC_KEYS` | — | JSON 对象 `{"keyId":"secret"}`，可配多把密钥做轮换 |
| `MCP_HMAC_KEY` | — | 单密钥快捷写法（`MCP_HMAC_KEYS` 优先） |
| `MCP_HMAC_TOLERANCE_SEC` | `300` | 时间戳容差（秒） |
| `MCP_NONCE_TTL_SEC` | `600` | nonce 保留时长（秒），须 ≥ 容差 |
| `MCP_AUTH_LOOPBACK_BYPASS` | `1` | 回环地址（127.0.0.1/::1）免签直连；对外监听时设 `0` 强制验签（Bearer 通道仍可用） |
| `MCP_1688_DATA_DIR` | `./.data` | 账本、凭证缓存、草稿落盘目录 |
| `MCP_LEDGER_PATH` | `$DATA_DIR/ledger.db` | 账本文件 |
| `MCP_LEDGER_RETENTION_DAYS` | `30` | 账本保留天数（启动 + 每 6h 清理） |
| `MCP_LEDGER_MAX_LIST` | `200` | `meta.list_operations` 单次上限 |
| `MCP_CREDENTIAL_KEY` | 空（仅内存） | 64 位 hex 或口令，开启凭证缓存 AES-256-GCM 落盘 |
| `MCP_CREDENTIAL_CACHE` | `$DATA_DIR/credentials.enc.json` | 加密凭证缓存文件 |
| `MCP_CREDENTIAL_TTL_SEC` | `300` | 凭证缓存 TTL |
| `MCP_MAX_BODY_BYTES` | `1048576` | 请求体上限 |
| `MCP_MAX_CONCURRENCY` | `4` | 工具并发闸门 |
| `MCP_TOOL_TIMEOUT_MS` | `60000` | 单次工具执行超时（超时 → `50001`，可重试） |
| `MCP_1688_MOCK` / `Z1688_MOCK` | — | 置 `1` 使用离线 mock 适配器 |
| `Z1688_PROFILE_DIR` / `Z1688_HEADLESS` / `Z1688_CHANNEL` | `~/.1688/profiles/default` / `1` / `chrome` | Playwright 浏览器参数（沿用旧版） |
| `Z1688_ORDER_GATEWAY` | — | 正式下单网关地址；未配置时 `publish_sourcing_order` 一律按 `43010` 业务拒绝 |

> 未配置 `MCP_HMAC_KEYS` 时会生成随机 dev 密钥并在日志打印 warning；
> 出于安全考虑 dev 模式**不会**把密钥写进响应，只提示“开发模式”，生产必须显式配置。

## 3. 传输与鉴权

- 唯一调用入口：`POST /mcp`（JSON-RPC 2.0，Streamable HTTP，无状态、无 session）。
- 探活：`GET /healthz`，免鉴权、无副作用，返回服务/账本/并发摘要。
- 协议版本：强制支持 `2025-06-18`，兼容 `2025-03-26`（由 `mcp-protocol-version` 头协商）。
- 其余方法/路径：非 `POST` 的 `/mcp` → `405`，未知路径 → `404`。

鉴权口径（自上而下短路）：

0. **未配置密钥**：本机开发模式，免鉴权（与 mcp-douyin-compass 一致；默认只绑 127.0.0.1）。
1. **回环免签**：请求来自 `127.0.0.1` / `::1` 时直接放行（默认开；对外监听时用
   `MCP_AUTH_LOOPBACK_BYPASS=0` 关闭）。
2. **Bearer 静态令牌**（第三方快速接入，免算签名）：
   `Authorization: Bearer <keyId>:<secret>` 或裸 `<secret>`，与密钥表匹配即放行。
3. **MCP-HMAC 严格验签**（跨公网高危通道）：

```
Authorization: MCP-HMAC keyId=dev,ts=1763000000,nonce=5f0c...,sig=<base64url>
```

签名原串固定 6 行：

```
{method}\n{path}\n{ts}\n{nonce}\n{sha256hex(rawBody)}\n{keyId}
```

- 算法 HMAC-SHA256 → base64url；`rawBody` 按**原始字节**计算（不是重新序列化的 JSON）。
- `|now - ts| ≤ 300s`，超出 → `41001`。
- nonce 保留 `600s`，**验签通过后才消耗**；重放 → `41009`。
- 未知 keyId、缺头、格式错、签名不符 → 一律 `41001`（不泄露期望签名/密钥）。

店铺凭证（隔离要求）：

```
X-Shop-Credential: <base64url(JSON.stringify({appId,appSecret,shopId}))>
```

- 只允许走请求头；参数体里出现 `appSecret`/`secret`/`accessToken` 等键名会被 `assertNoSecretsInBody` 拒绝（`40001`），避免凭证进日志与 Prompt。
- 服务端只按 `appId:shopId` 派生 `shopKey`，写操作/账本按店隔离；`appSecret` 仅进内存凭证表（配置 `MCP_CREDENTIAL_KEY` 时 AES-256-GCM 落盘，TTL 默认 300s）。

## 4. 工具目录（分层暴露）

`tools/list` 默认只暴露**语义工具 7 个 + 元工具 3 个**；通用原子工具默认对 LLM 隐身，
只有请求头带 `x-mcp-include-generic: 1`（代码调度/JIT 挂载）时才出现。

| 工具 | 层级 | x-risk | 说明 |
| --- | --- | --- | --- |
| `search_products` | semantic | read | 关键词搜索（GBK 编码、支持销量/价格排序） |
| `search_by_image` | semantic | read | 图片搜同款 |
| `get_offer` | semantic | read | 商品详情 + SKU 阶梯价 |
| `compare_suppliers` | semantic | read | 2~10 个 offer 对比：最低价/销量最优/交期 |
| `filter_suppliers` | semantic | read | 按 MAF 下发的筛选条件过滤供应商（发货时效/揽收率/退款率/服务保障/履约质量/增值服务），支持预设策略 |
| `save_sourcing_draft` | semantic | write | 落选品草稿（幂等，可重放） |
| `publish_sourcing_order` | semantic | irreversible | 提交采购单，必须 `confirm: true`，强制人工审批 |
| `meta.health` | meta | read | 服务健康（版本/协议/模式/负载） |
| `meta.describe` | meta | read | 服务能力、限制、工具分级目录 |
| `meta.list_operations` | meta | read | 按 operationId/since 对账孤儿操作 |
| `1688.offer.search` | generic | read | 原子：关键词搜索 |
| `1688.offer.detail` | generic | read | 原子：详情 |
| `1688.offer.sku_model` | generic | read | 原子：SKU 模型 |
| `1688.offer.image_search` | generic | read | 原子：图搜 |
| `1688.shop.profile` | generic | read | 原子：店铺/供应商画像 |
| `1688.session.login` | generic | write | 原子：触发一次登录（有头） |
| `1688.order.submit` | generic | irreversible | 原子：下单（同样受 confirm + 网关保护） |

`x-risk` 会同时出现在三个位置以保证不同客户端都能读到：工具对象顶层、`inputSchema['x-risk']`、`_meta['x-risk']`；另附标准 `annotations`（`readOnlyHint` / `destructiveHint` / `idempotentHint`）。

命名与分级规则（规范约束）：`read` = `get_/query_/search_/list_/meta.*`，`write` = `save_/update_/sync_`，`irreversible` = `publish_/pay_/delete_/refund_`。

### 4.1 供应商过滤条件（`filter_suppliers`）

MAF 端会把采购后台的筛选面板条件原样下发（中文标签即可），`filter_suppliers` 负责归一化、执行并返回命中/淘汰原因：

```json
{
  "operationId": "op-task001-step02-1a2b3c4d5e6f7788",
  "preset": "default_price",
  "filters": {
    "发货时效": "48小时发货",
    "揽收率": "24小时揽收率≥95%",
    "退款率": "总退款率≤3%",
    "服务保障": ["7天无理由退换货"],
    "履约质量": "综合体验分 4.5-5.0星",
    "增值服务": ["支持一件代发", "支持抖音密文打单"]
  },
  "keywords": "保温杯",
  "limit": 10
}
```

- **预设策略**：`priority_quality`（严格：优先高质量货源）、`default_price`（宽松：优先低价货源）。显式 `filters` 按分组覆盖预设；传空数组（如 `"增值服务": []`）表示清空该组。
- **条件语义**：同名分组内多选（服务保障/增值服务）为 **ANY**（满足其一）；揽收率/退款率为百分比小数（`≥95%` → `0.95`）；`<95%`、`>0.3%` 等反向条件也支持。
- **中文标签映射**：发货时效 `当天发货=12h / 24小时发货=24h / 48小时发货=48h`；揽收率 `24/48小时揽收率≥95%|≥99%|<95%`；退款率 `品质退款率 ≤0.005%/≤0.15%/≤0.30%/>0.3%`、`总退款率 ≤1%/≤3%/≤5%`；服务保障 `7天无理由退换货 / 实力商家 / 认证工厂`；履约质量 `5星 / 4.5-5.0星 / 4-4.5星 / 4星以下`；增值服务 `免费赊账 / 一件代发 / 一件代发包邮 / 支持{抖音,快手,微信小店,淘宝,拼多多,小红书,京东}密文下单`。
- **不认识的标签一律 40001**，绝不静默忽略过滤条件（例如 `综合体验分 4.2星` 这种面板不存在的档位会被拒绝）。
- **指标缺失策略**：上游拿不到揽收率/退款率/体验分时默认按未通过处理，原因码 `metric_unavailable`；显式 `allowUnknownMetrics: true` 才放行（用于数据源不全的灰度期）。
- **返回**：`{ filters, preset, scope, stats:{candidates,matched,rejected}, matched:[{offerId,title,supplier,price,moq,metrics}], rejected:[{...,reasons:[{filter,expected,actual,code}]}] }`。
- 不传 `keywords` / `offerIds` 时在服务端默认候选池上过滤；传 `offerIds` 时只在该货源池内过滤。


## 5. 统一信封

每个 `tools/call` 无论成功失败都返回同一结构（`content[0].text` 与 `structuredContent` 内容一致）：

```json
{
  "success": true,
  "data": { "...": "工具业务数据" },
  "usage": { "costCents": 0, "unit": "call", "quantity": 1 },
  "error": null,
  "server": { "name": "mcp-1688", "version": "1.0.0", "toolVersion": "1.0", "elapsedMs": 12 },
  "traceId": "7f3c9e2a1b4d4c8e9f0a1b2c3d4e5f60",
  "replayed": false
}
```

失败时 `success=false`、`error` 为归一化错误对象、`isError=true`：

```json
{
  "code": 42001,
  "category": "rate_limit",
  "label": "上游频控",
  "message": "上游限频，建议指数退避后重试：HTTP 429 Too Many Requests",
  "retryable": true,
  "upstream": { "code": 429, "message": "HTTP 429 Too Many Requests" },
  "data": null
}
```

上游私有码/私有文案只放在 `error.upstream`，平台只依赖归一化 `code`。

| code | 含义 | 可重试 | 典型处理 |
| --- | --- | --- | --- |
| `40001` | 参数/协议错误（schema、operationId 格式、凭证进 body） | 否 | 修正入参 |
| `41001` | 鉴权失败（HMAC/凭证/1688 登录态） | 否 | 修凭证或重新登录 |
| `41009` | nonce 重放 | 否 | 重新签名 |
| `42001` | 频控/并发闸门 | **是** | 指数退避重试 |
| `42002` | 配额耗尽 | 否 | 换配额/次日再试 |
| `43002` | 权限不足 | 否 | 开权限 |
| `43009` | 幂等冲突（同 operationId 参数被篡改/仍在执行） | 否 | 对账，勿改参数重放 |
| `43010` | 业务拒绝（类目资质、未配置下单网关等） | 否 | 转人工 |
| `50001` | 上游网络/超时 | **是** | 平台重试 ≤3 次 |

## 6. 幂等账本

- 写操作（write/irreversible）必须带 `operationId`，格式 `op-{taskId}-{stepCode}-{contentHash16}`（正则 `^op-[A-Za-z0-9._:-]{4,124}$`）。
- 账本：`.data/ledger.db`，SQLite WAL，主键 `(shop_key, operation_id)`，状态 `EXECUTING → SUCCEEDED / FAILED`。
- 同 `operationId` + 同参数重放：直接回历史结果，`replayed: true`，**不会二次调用上游**。
- 同 `operationId` 但参数（去掉 operationId 后规范化 JSON 的 sha256）不一致 → `43009`。
- 可重试失败（`50001`/`42001`）允许平台用同一 `operationId` 真正重试；其它失败按终态回放。
- 保留 ≥30 天；启动时与每 6 小时清理一次。
- `meta.list_operations({operationIds, since, limit})` 供平台做孤儿操作对账。

## 7. 验收测试

```bash
npm test        # 49 项：HMAC/账本/凭证单测 + HTTP 契约 8 项
npm run test:unit
```

`test/http-contract.test.mjs` 逐项覆盖规范 checklist：

1. `GET /healthz` → 200 且中位延迟 <50ms；
2. 缺/错签名 → 401 + `41001`；nonce 重放 → 401 + `41009`；
3. `tools/list` 语义工具 ≤8、总数 ≤10、每个工具三处都有 `x-risk`、默认隐藏 `1688.*`、JIT 头可显式挂载；
4. 同一 `operationId` 连调两次写操作：第二次 `replayed:true`、上游调用次数仍为 1；
5. 同 `operationId` 改参数 → `43009`；
6. 上游超时 → `50001`（retryable）、限流 → `42001`（retryable）、配额 → `42002`（不可重试）；可重试失败后同 `operationId` 重试会真正重跑；
7. 写操作缺凭证 → `41001`、缺 `operationId` → `40001`、凭证塞进参数体 → `40001`；
8. 只读工具返回统一信封（`server.name/version`、`usage.unit='call'`）；`publish_sourcing_order confirm:false` → `43010`。

全部离线：mock 适配器 + 内存账本，不启动 Chrome、不访问外网。

## 8. 目录结构

```
tools/mcp-1688/
├── src/
│   ├── index.js                 # 启动入口：账本/凭证/适配器/HTTP/优雅退出
│   ├── config.js                # 全部环境变量与默认值（含旧版浏览器参数）
│   ├── core/errors.js           # 归一化错误码 + ContractError
│   ├── core/envelope.js         # 统一信封
│   ├── core/validate.js         # 轻量 JSON Schema 校验
│   ├── http/server.js           # POST /mcp、GET /healthz、HMAC/凭证/协议协商
│   ├── http/auth.js             # MCP-HMAC 签名与校验
│   ├── ledger/db.js             # SQLite WAL 幂等账本
│   ├── security/credentials.js  # 凭证解码/隔离校验/AES-256-GCM 缓存
│   ├── mcp/server.js            # 低层 MCP Server：tools/list + tools/call 编排
│   ├── tools/catalog.js         # 17 个工具定义、分级、x-risk、JIT 暴露策略
│   ├── domain/supplier-filters.js # 供应商筛选条件归一化/预设策略/命中判定
│   ├── adapters/{index,mock,real}.js
│   ├── browser.js / mtop.js / capture.js / tools/*.js   # 旧版 1688 抓取能力（real adapter 复用）
├── scripts/sign.mjs             # HMAC 签名/curl 生成
├── test/unit/*.test.mjs         # auth / ledger / credentials 单测
├── test/http-contract.test.mjs  # 规范 checklist 验收
└── .data/                       # 运行时：账本、凭证缓存、草稿（已 gitignore）
```

## 9. 与旧版（stdio）的差异

| 项 | 旧版 | 现在 |
| --- | --- | --- |
| 传输 | stdio（由 MCP 客户端拉起） | Streamable HTTP，`POST /mcp` 单入口 |
| 鉴权 | 无（依赖本地进程信任） | 强制 MCP-HMAC + 时间窗 + nonce 防重放 |
| 工具 | 5 个平铺（search/image/offer/login/status） | 语义 6 + 元 3 + 通用 7（默认隐身） |
| 返回 | 裸 JSON | 统一信封（usage/server/traceId/replayed） |
| 写操作 | 无 | 幂等账本 + HITL 保护 + `43009` 篡改检测 |
| 凭证 | 全局浏览器登录态 | 每请求 `X-Shop-Credential`，按店隔离 |
| 测试 | 手工 smoke/stdio 脚本 | 49 项自动化测试，可离线跑 |

旧的 `test/smoke.mjs`、`mcp-client.mjs`、`run-image.mjs`、`run-offer.mjs` 已随 stdio 入口移除；
需要用真实浏览器时，先起服务再按 `scripts/sign.mjs` 生成的 curl 调用即可。

## 10. 已知限制

- nonce 与凭证缓存是**单进程内存**：多副本部署需要 sticky routing 或共享存储（Redis）。
- mock 模式只模拟 1688 行为，不代表真实页面结构；真实抓取仍受 1688 反爬/滑块影响，需要人工过验证。
- 正式下单未接入平台采购通道（`Z1688_ORDER_GATEWAY`）前，`publish_sourcing_order` 一律 `43010`，不会“假装成功”。
- 账本与凭证缓存写在 `.data/`，请确保该目录权限与备份策略；生产建议单独挂载并限制读写权限。
