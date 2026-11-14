using Wizstar.Agents.Profiles;
using Wizstar.Agents.Runtime;
using Wizstar.Contracts;
using Wizstar.Mcp;

namespace Wizstar.Api.Endpoints;

/// <summary>
/// 前端启动引导端点：一次返回 health / agents / mcp 快照，供 WorkBenchUI 首屏预取。
/// 只读聚合，不改变任何治理、审批、账本口径；失败时前端整站进入离线重试页，不回退演示数据。
/// </summary>
public static class UiEndpoints
{
    public static void MapUiEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/ui/bootstrap", (
            IConfiguration configuration,
            AgentCatalog catalog,
            ChatClientProvider chat,
            McpCatalog mcp,
            McpToolProvider toolProvider) =>
        {
            var snapshots = mcp.ListSnapshots();

            var data = new
            {
                endpoint = configuration["Ui:Endpoint"] ?? "127.0.0.1:5301",
                version = "0.1.0",
                chatMode = chat.Mode,
                chatOfflineReason = chat.OfflineReason,
                agents = catalog.GetAll().Select(p => new
                {
                    key = p.Key,
                    name = p.Name,
                    displayName = p.DisplayName,
                    description = p.Description,
                    enabled = p.Enabled,
                    maxSteps = p.MaxSteps,
                    allowedTools = p.AllowedTools,
                    systemPromptPreview = p.SystemPrompt.Length > 120
                        ? p.SystemPrompt[..120] + "…"
                        : p.SystemPrompt
                }).ToArray(),
                mcp = new
                {
                    connected = snapshots.Count(s => s.State == McpServiceState.Connected),
                    offline = snapshots.Count(s => s.State == McpServiceState.Offline),
                    error = snapshots.Count(s => s.State == McpServiceState.Error),
                    disabled = snapshots.Count(s => s.State == McpServiceState.Disabled),
                    servers = snapshots,
                    tools = toolProvider.ListTools()
                }
            };

            return Results.Ok(ApiEnvelope<object>.Ok(data, "ui/bootstrap"));
        }).WithTags("Ui");
    }
}
