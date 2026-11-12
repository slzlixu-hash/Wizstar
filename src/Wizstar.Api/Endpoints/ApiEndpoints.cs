using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Wizstar.Agents.Governance;
using Wizstar.Agents.Ledger;
using Wizstar.Agents.Profiles;
using Wizstar.Agents.Runtime;
using Wizstar.Contracts;
using Wizstar.Mcp;

namespace Wizstar.Api.Endpoints;

/// <summary>
/// Agent 端点：名册查询 + 对话（SSE 流式 / JSON 兜底）。
/// </summary>
public static class AgentEndpoints
{
    public static void MapAgentEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/agents").WithTags("Agents");

        group.MapGet("/", (AgentCatalog catalog) =>
        {
            var data = catalog.GetAll().Select(profile => new
            {
                key = profile.Key,
                name = profile.Name,
                displayName = profile.DisplayName,
                description = profile.Description,
                enabled = profile.Enabled,
                maxSteps = profile.MaxSteps,
                allowedTools = profile.AllowedTools,
                systemPromptPreview = profile.SystemPrompt.Length > 120
                    ? profile.SystemPrompt[..120] + "…"
                    : profile.SystemPrompt
            });
            return Results.Ok(ApiEnvelope<object>.Ok(data, string.Empty));
        });

        group.MapPost("/{key}/chat", async (
            string key,
            ChatRequest request,
            HttpContext http,
            AgentRunner runner,
            ConversationStore conversations,
            CancellationToken ct) =>
        {
            var options = new AgentRunOptions(
                key,
                conversations.NormalizeConversationId(request.ConversationId),
                request.Message ?? string.Empty);

            // JSON 直连（非流式）：测试与脚本优先
            var accept = http.Request.Headers.Accept.ToString();
            if (!accept.Contains("text/event-stream", StringComparison.OrdinalIgnoreCase))
            {
                var result = await runner.RunAsync(options, ct).ConfigureAwait(false);
                return Results.Ok(ApiEnvelope<AgentRunResult>.Ok(result, http.TraceIdentifier));
            }

            // SSE 流式：meta → tool → delta* → done
            http.Response.StatusCode = StatusCodes.Status200OK;
            http.Response.ContentType = "text/event-stream; charset=utf-8";
            http.Response.Headers.CacheControl = "no-cache";

            await foreach (var e in runner.StreamAsync(options, ct).ConfigureAwait(false))
            {
                var (name, payload) = e switch
                {
                    AgentRunEvent.Meta m => ("meta", JsonSerializer.Serialize(new
                    {
                        agentKey = m.AgentKey,
                        conversationId = m.ConversationId,
                        mode = m.Mode,
                        offlineReason = m.OfflineReason,
                        assembledTools = m.AssembledTools
                    })),
                    AgentRunEvent.ToolEvent t => ("tool", JsonSerializer.Serialize(t.Trace, new JsonSerializerOptions
                    {
                        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
                    })),
                    AgentRunEvent.Delta d => ("delta", JsonSerializer.Serialize(new { text = d.Text })),
                    AgentRunEvent.Done done => ("done", JsonSerializer.Serialize(done.Result, new JsonSerializerOptions
                    {
                        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
                    })),
                    _ => ("event", "{}")
                };

                await http.Response.WriteAsync($"event: {name}\ndata: {payload}\n\n", Encoding.UTF8, ct).ConfigureAwait(false);
                await http.Response.Body.FlushAsync(ct).ConfigureAwait(false);
            }

            return Results.Empty;
        });
    }
}

public sealed record ChatRequest(string? Message, string? ConversationId);

/// <summary>
/// 审批端点（HITL）：列出 / 批准 / 拒绝。
/// 口径：服务端从不自动批准；批准后不自动执行——下一次携带相同 operationId 的调用才真正执行。
/// </summary>
public static class ApprovalEndpoints
{
    public static void MapApprovalEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/approvals").WithTags("Approvals");

        group.MapGet("/", (IApprovalStore store, string? status, int? limit) =>
        {
            var data = store.List(status, Math.Clamp(limit ?? 100, 1, 500));
            return Results.Ok(ApiEnvelope<object>.Ok(data, string.Empty));
        });

        group.MapGet("/{id:guid}", (IApprovalStore store, Guid id) =>
        {
            var approval = store.Get(id);
            return approval is null
                ? Results.NotFound(ApiEnvelope<object>.Fail(ErrorCodes.ValidationError, $"审批单不存在: {id}", string.Empty))
                : Results.Ok(ApiEnvelope<object>.Ok(approval, string.Empty));
        });

        group.MapPost("/{id:guid}/{decision:regex(^(approve|reject)$)}", (
            IApprovalStore store, Guid id, string decision, [FromBody] DecisionRequest? request) =>
        {
            var status = decision == "approve" ? ApprovalStatus.Approved : ApprovalStatus.Rejected;
            var decided = store.Decide(id, status, request?.Note);
            return decided is null
                ? Results.Conflict(ApiEnvelope<object>.Fail(
                    ErrorCodes.BusinessRejected, $"审批单不存在或已决策: {id}", string.Empty))
                : Results.Ok(ApiEnvelope<object>.Ok(decided, string.Empty));
        });
    }
}

public sealed record DecisionRequest(string? Note);

/// <summary>
/// MCP 即插即用端点：服务快照 / 对账 / 单服务握手 / 工具清单。
/// </summary>
public static class McpEndpoints
{
    public static void MapMcpEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/mcp").WithTags("Mcp");

        group.MapGet("/servers", (McpCatalog catalog) =>
            Results.Ok(ApiEnvelope<object>.Ok(catalog.ListSnapshots(), string.Empty)));

        group.MapGet("/tools", (McpToolProvider provider) =>
            Results.Ok(ApiEnvelope<object>.Ok(provider.ListTools(), string.Empty)));

        group.MapPost("/reconcile", async (McpReconciler reconciler, CancellationToken ct) =>
        {
            var summary = await reconciler.ReconcileAsync(ct).ConfigureAwait(false);
            return Results.Ok(ApiEnvelope<McpReconcileSummary>.Ok(summary, string.Empty));
        });

        group.MapPost("/servers/{id}/handshake", async (string id, McpCatalog catalog, McpReconciler reconciler, CancellationToken ct) =>
        {
            if (catalog.GetConfig(id) is null)
            {
                return Results.NotFound(ApiEnvelope<object>.Fail(ErrorCodes.ValidationError, $"清单中未声明服务: {id}", string.Empty));
            }

            var ok = await reconciler.HandshakeAsync(id, ct).ConfigureAwait(false);
            var snapshot = catalog.ListSnapshots().FirstOrDefault(s => s.Id == id);
            return ok
                ? Results.Ok(ApiEnvelope<object>.Ok(snapshot, string.Empty))
                : Results.Json(
                    ApiEnvelope<object>.Fail(
                        ErrorCodes.NetworkError,
                        catalog.GetState(id)?.LastError ?? "握手失败",
                        string.Empty),
                    statusCode: StatusCodes.Status502BadGateway);
        });
    }
}

/// <summary>
/// 幂等账本对账端点：按 operationId 反查 / 时间窗口扫描（规范 §6 孤儿对账）。
/// </summary>
public static class OperationsEndpoints
{
    public static void MapOperationsEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/operations").WithTags("Operations");

        group.MapGet("/{operationId}", async (string operationId, string? scope, OperationLedger ledger, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(scope))
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, "缺少 scope 参数（账本主键为 (scope, operationId)）", string.Empty));
            }

            var record = await ledger.GetAsync(scope, operationId, ct).ConfigureAwait(false);
            return record is null
                ? Results.NotFound(ApiEnvelope<object>.Fail(ErrorCodes.ValidationError, "账本中无此记录", string.Empty))
                : Results.Ok(ApiEnvelope<object>.Ok(record, string.Empty));
        });

        group.MapGet("/", async (OperationLedger ledger, int? sinceHours, int? limit, CancellationToken ct) =>
        {
            var since = DateTimeOffset.UtcNow.AddHours(-Math.Clamp(sinceHours ?? 24, 1, 24 * 30));
            var records = await ledger.ListSinceAsync(since, Math.Clamp(limit ?? 200, 1, 1000), ct).ConfigureAwait(false);
            return Results.Ok(ApiEnvelope<object>.Ok(records, string.Empty));
        });
    }
}
