using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Wizstar.Agents.Governance;
using Wizstar.Agents.Ledger;
using Wizstar.Agents.Profiles;
using Wizstar.Agents.Runtime;
using Wizstar.Agents.Tools;
using Wizstar.Api.Middleware;
using Wizstar.Api.Endpoints;
using Wizstar.Contracts;
using Wizstar.Data;
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
builder.Services.AddSingleton<SqlSugarClient>(_ => DbInitializer.CreateClient(mySqlConnectionString));

var app = builder.Build();

// 顺序：CORS 最外层（错误响应也带 CORS 头）→ 异常统一 → 端点
app.UseCors();
app.UseMiddleware<ExceptionHandlingMiddleware>();

app.MapAgentEndpoints();
app.MapApprovalEndpoints();
app.MapMcpEndpoints();
app.MapOperationsEndpoints();
app.MapUiEndpoints();

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
    var summary = await app.Services.GetRequiredService<McpReconciler>()
        .ReconcileAsync(app.Lifetime.ApplicationStopping).ConfigureAwait(false);
    logger.LogInformation("MCP 对账完成: 新增={Added} 刷新={Refreshed} 移除={Removed} 失败={Failed}",
        summary.Added, summary.Refreshed, summary.Removed, summary.Failed);
}
catch (Exception ex)
{
    logger.LogWarning(ex, "MCP 启动对账失败（健康心跳会在下个周期重试）");
}

app.Run();

/// <summary>供集成测试 / 宿主引用。</summary>
public partial class Program;
