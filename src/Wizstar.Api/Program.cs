using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Wizstar.Agents.Governance;
using Wizstar.Agents.Ledger;
using Wizstar.Agents.Profiles;
using Wizstar.Agents.Runtime;
using Wizstar.Agents.Tools;
using Wizstar.Api.Middleware;
using Wizstar.Api.Endpoints;
using Wizstar.Api.Services;
using Wizstar.Contracts;
using Wizstar.Data;
using Wizstar.Data.Llm;
using Wizstar.Data.Settings;
using SqlSugar;
using Wizstar.Mcp;

var builder = WebApplication.CreateBuilder(args);

// ── JSON：camelCase + 中文不转 \uXXXX（与信封层同一口径）──────────────────────
builder.Services.AddControllers().AddJsonOptions(options =>
{
    options.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.JsonSerializerOptions.PropertyNameCaseInsensitive = true;
    options.JsonSerializerOptions.Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping;
});

// 框架级模型绑定失败也走统一错误信封
builder.Services.Configure<ApiBehaviorOptions>(options =>
{
    options.InvalidModelStateResponseFactory = context =>
    {
        var fields = context.ModelState
            .Where(entry => entry.Value?.Errors.Count > 0)
            .Select(entry => entry.Key)
            .Where(key => !string.IsNullOrWhiteSpace(key))
            .Distinct()
            .ToArray();

        var message = fields.Length == 0
            ? "请求参数不合法"
            : $"请求参数不合法: {string.Join(", ", fields)}";

        return new BadRequestObjectResult(
            new ApiEnvelope<object>(false, null,
                new ApiError(ErrorCodes.ValidationError, message, context.HttpContext.TraceIdentifier),
                context.HttpContext.TraceIdentifier))
        {
            ContentTypes = { "application/json; charset=utf-8" }
        };
    };
});

// ── CORS：Electron file://（Origin: null）可直连；本期无鉴权，不启用 Credentials ──
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy => policy.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod());
});

// ── HttpClient 命名通道 ──────────────────────────────────────────────────────
// llm：OpenAI 兼容模型端点；mcp：MCP JSON-RPC 调用。
// 本地回环服务不得走系统代理（实测：HTTP_PROXY 会把 127.0.0.1 的 POST /mcp 串成
// 绝对地址转发，Node 端 req.url 失配返回 404）。挂 LoopbackBypassProxy 强制直连回环。
builder.Services.AddHttpClient("llm")
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        Proxy = new LoopbackBypassProxy(HttpClient.DefaultProxy),
        UseProxy = true,
        PooledConnectionLifetime = TimeSpan.FromMinutes(2)
    });
builder.Services.AddHttpClient("mcp")
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        PooledConnectionLifetime = TimeSpan.FromMinutes(2),
        UseProxy = true,
        Proxy = new LoopbackBypassProxy(HttpClient.DefaultProxy)
    });

// ── MAF 内核 ────────────────────────────────────────────────────────────────
builder.Services.AddSingleton<AgentCatalog>(sp => new AgentCatalog(
    Path.Combine(builder.Environment.ContentRootPath, "config/agents.yaml"),
    sp.GetRequiredService<ILogger<AgentCatalog>>()));
builder.Services.AddSingleton<ConversationStore>();
builder.Services.AddSingleton<ChatClientProvider>();
builder.Services.AddSingleton<AgentRunner>();

// ── 工具总线：内置演示工具 + MCP 工具桥接（ToolRegistry 注入全部 IToolProvider）──
builder.Services.AddSingleton<BuiltinToolsProvider>();
builder.Services.AddSingleton<McpToolProvider>();
builder.Services.AddSingleton<IToolProvider>(sp => sp.GetRequiredService<BuiltinToolsProvider>());
builder.Services.AddSingleton<IToolProvider>(sp => sp.GetRequiredService<McpToolProvider>());
builder.Services.AddSingleton<ToolRegistry>();
builder.Services.AddSingleton<ToolInvoker>();

// ── 治理与账本 ──────────────────────────────────────────────────────────────
builder.Services.AddSingleton<IApprovalStore, InMemoryApprovalStore>();
builder.Services.AddSingleton(sp => new OperationLedger(
    builder.Configuration["Ledger:Path"] ?? "data/ledger.db",
    sp.GetRequiredService<ILogger<OperationLedger>>()));

// ── MCP 即插即用 ────────────────────────────────────────────────────────────
builder.Services.AddSingleton<McpCatalog>();
builder.Services.AddSingleton<McpReconciler>();
builder.Services.AddHostedService<McpHealthMonitor>();

// ── 持久层：SqlSugar + 本地 MySQL（Wizstar 库，CodeFirst）────────────────────
var mySqlConnectionString = builder.Configuration["Database:MySql"] ?? string.Empty;
if (string.IsNullOrWhiteSpace(mySqlConnectionString))
{
    throw new InvalidOperationException("缺少 Database:MySql 连接串配置（appsettings.json）");
}
// SqlSugarClient 单例在并发请求下会复用同一 MySqlConnection；改用 SqlSugarScope 隔离连接。
builder.Services.AddSingleton<ISqlSugarClient>(_ => DbInitializer.CreateScopeClient(mySqlConnectionString));

// ── 平台级运行时配置（sys_risk_policy KV）：风控等级策略 + 环境开关 ──────────────
builder.Services.AddSingleton(sp => new RuntimeSettingsStore(
    sp.GetRequiredService<ISqlSugarClient>(),
    msg => sp.GetRequiredService<ILogger<RuntimeSettingsStore>>().LogWarning("{Message}", msg)));
builder.Services.AddSingleton<IRiskPolicyProvider, DbRiskPolicyProvider>();

// ── 登录鉴权：sys_user 表 + 无状态令牌 ────────────────────────────────────────
// 默认管理员 admin / admin123 首次启动自动种子到 sys_user（已存在则不覆盖密码）；
// 令牌秘钥取 Auth:Secret，留空时按本机机器名/用户名派生稳定密钥（不落仓库）。
builder.Services.AddSingleton<IUserStore, SqlUserStore>();
builder.Services.AddSingleton(_ => new AuthTokenService(
    builder.Configuration["Auth:Secret"],
    builder.Configuration.GetValue("Auth:TokenHours", 12)));
builder.Services.AddSingleton<AuthService>();

// ── LLM 动态配置：系统设置页写入 → 运行时热切 live/offline ──────────────────────
// 主密钥留空时由 ApiKeyProtector 派生本机开发值；生产环境用 WIZSTAR_MASTER_KEY 注入。
builder.Services.AddSingleton(_ => new LlmRuntimeDefaults(
    builder.Configuration.GetValue("LLM:Temperature", 0.7),
    builder.Configuration.GetValue("LLM:MaxOutputTokens", 2048),
    builder.Configuration.GetValue("LLM:TimeoutSeconds", 120)));
builder.Services.AddSingleton(sp => new LlmConfigStore(
    sp.GetRequiredService<ISqlSugarClient>(),
    builder.Configuration["Security:MasterKey"],
    sp.GetRequiredService<LlmRuntimeDefaults>(),
    msg => sp.GetRequiredService<ILogger<LlmConfigStore>>().LogWarning("{Message}", msg)));
builder.Services.AddSingleton<ILlmRuntimeSettingsProvider>(sp => sp.GetRequiredService<LlmConfigStore>());

var app = builder.Build();

// 顺序：CORS 最外层（错误响应也带 CORS 头）→ 异常统一 → 登录态校验 → 端点
app.UseCors();
app.UseMiddleware<ExceptionHandlingMiddleware>();
app.UseMiddleware<AuthMiddleware>();

app.MapAuthEndpoints();
app.MapAgentEndpoints();
app.MapApprovalEndpoints();
app.MapMcpEndpoints();
app.MapOperationsEndpoints();
app.MapUiEndpoints();
app.MapLlmEndpoints();
app.MapBusinessEndpoints();
app.MapSettingsEndpoints();

// ── 健康检查（含账本自检；失败 503，不阻塞其余端点）────────────────────────────
app.MapGet("/api/health", async (OperationLedger ledger, ChatClientProvider chat, AgentCatalog catalog, McpCatalog mcp, CancellationToken ct) =>
{
    string ledgerStatus;
    try
    {
        await ledger.ListSinceAsync(DateTimeOffset.UtcNow.AddMinutes(-1), 1, ct).ConfigureAwait(false);
        ledgerStatus = "ok";
    }
    catch (Exception)
    {
        ledgerStatus = "unavailable";
    }

    var snapshots = mcp.ListSnapshots();
    var data = new
    {
        status = ledgerStatus == "ok" ? "ok" : "degraded",
        version = "0.1.0",
        chatMode = chat.Mode,
        chatOfflineReason = chat.OfflineReason,
        agents = catalog.GetAll().Count(p => p.Enabled),
        ledger = ledgerStatus,
        mcp = new
        {
            connected = snapshots.Count(s => s.State == McpServiceState.Connected),
            offline = snapshots.Count(s => s.State == McpServiceState.Offline),
            error = snapshots.Count(s => s.State == McpServiceState.Error),
            disabled = snapshots.Count(s => s.State == McpServiceState.Disabled)
        }
    };

    return ledgerStatus == "ok"
        ? Results.Ok(ApiEnvelope<object>.Ok(data, "health"))
        : Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
});

// ── 启动自检与首轮流水线：名册 → 账本 → MCP 对账（只补缺，失败不阻塞启动）────────
var logger = app.Logger;

var catalogInstance = app.Services.GetRequiredService<AgentCatalog>();
logger.LogInformation("Agent 名册就绪: {Count} 个 Agent ({Names})",
    catalogInstance.GetAll().Count,
    string.Join(", ", catalogInstance.GetAll().Select(p => p.Key)));

if (builder.Configuration.GetValue("Database:AutoCreateTables", true))
{
    try
    {
        DbInitializer.Initialize(mySqlConnectionString, msg => logger.LogInformation("{Message}", msg));
        logger.LogInformation("MySQL 就绪: Wizstar 库（SqlSugar CodeFirst）");
    }
    catch (Exception ex)
    {
        logger.LogWarning(ex, "MySQL 初始化失败（连接串或服务状态问题），持久化能力降级");
    }

    // 默认管理员种子：admin / admin123（仅补缺，不覆盖已有密码）。
    // 单独兜底：种子失败不影响其余启动流程，但登录会不可用，日志需明确。
    try
    {
        app.Services.GetRequiredService<AuthService>().EnsureSeed();
    }
    catch (Exception ex)
    {
        logger.LogWarning(ex, "默认管理员种子失败（登录可能不可用），请检查 sys_user 表结构");
    }
}

// 种子逐项补缺：内置 DeepSeek + 两条模型定义 + 6 个 Agent 分派。
// 单独兜底：配置库异常不影响后续账本 / MCP 启动，ChatClientProvider 会自动回退 offline。
try
{
    app.Services.GetRequiredService<LlmConfigStore>().EnsureSeed();
    logger.LogInformation("LLM 配置种子就绪: 内置供应商 / 支持模型 / Agent 分派");
}
catch (Exception ex)
{
    logger.LogWarning(ex, "LLM 配置种子初始化失败，动态模型配置暂不可用");
}

try
{
    await app.Services.GetRequiredService<OperationLedger>()
        .ListSinceAsync(DateTimeOffset.UtcNow, 1).ConfigureAwait(false);
    logger.LogInformation("幂等账本就绪: SQLite WAL");
}
catch (Exception ex)
{
    logger.LogWarning(ex, "幂等账本初始化失败，写操作将不可用");
}

try
{
    // 「启动自动握手 MCP 服务」开关：关闭时只登记清单不建连（系统设置页可改，重启生效）
    var runtimeSettings = app.Services.GetRequiredService<RuntimeSettingsStore>();
    var autoHandshake = runtimeSettings.GetFlag(RuntimeSettingsStore.ToggleKey("auto-handshake"), true);

    var summary = await app.Services.GetRequiredService<McpReconciler>()
        .ReconcileAsync(app.Lifetime.ApplicationStopping, autoHandshake).ConfigureAwait(false);
    logger.LogInformation("MCP 对账完成: 新增={Added} 刷新={Refreshed} 移除={Removed} 失败={Failed} 自动握手={AutoHandshake}",
        summary.Added, summary.Refreshed, summary.Removed, summary.Failed, autoHandshake);
}
catch (Exception ex)
{
    logger.LogWarning(ex, "MCP 启动对账失败（健康心跳会在下个周期重试）");
}

app.Run();

/// <summary>供集成测试 / 宿主引用。</summary>
public partial class Program;
