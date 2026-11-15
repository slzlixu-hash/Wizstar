using System.Text.Json;
using SqlSugar;
using Wizstar.Api.Pipelines;
using Wizstar.Api.Services;
using Wizstar.Contracts;
using Wizstar.Data;
using Wizstar.Data.Entities;
using Wizstar.Data.Entities.Business;

namespace Wizstar.Api.Endpoints;

/// <summary>
/// 指挥官管理界面的聚合读数：最近协同日志（Agent 会话 + 流水线推进）与任务创建/终止的辅助端点。
/// 所有内容都来自真实表，不构造演示轨迹。
/// </summary>
public static class CommanderEndpoints
{
    private static readonly JsonSerializerOptions StoredJson = new() { PropertyNameCaseInsensitive = true };

    public static void MapCommanderEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/commander").WithTags("Commander");

        /* 协同与指令台的 Handoff 日志：最近 Agent 会话消息 + 最近流水线状态变化。 */
        group.MapGet("/activity", (ISqlSugarClient db, int? limit, HttpContext context) =>
        {
            var take = Math.Clamp(limit ?? 40, 1, 200);
            var items = new List<ActivityItem>();

            try
            {
                var sessions = db.Queryable<AgentSessionRecord>()
                    .Where(s => s.ArchivedAtUtc == null && !s.ConversationId.Contains(":"))
                    .OrderByDescending(s => s.UpdatedAtUtc)
                    .Take(20)
                    .ToList();

                foreach (var session in sessions)
                {
                    var messages = ParseMessages(session.MessagesJson);
                    if (messages.Count == 0)
                    {
                        continue;
                    }
                    var last = messages[^1];
                    var agentKey = string.Equals(session.AgentKey, GroupChatService.GroupAgentKey, StringComparison.Ordinal)
                        ? "群聊会诊"
                        : session.AgentKey;
                    items.Add(new ActivityItem(
                        "agent",
                        agentKey,
                        last.Role ?? "assistant",
                        Truncate(last.Text ?? string.Empty, 180),
                        new DateTimeOffset(DateTime.SpecifyKind(session.UpdatedAtUtc, DateTimeKind.Utc))));
                }
            }
            catch (Exception)
            {
                // 会话表不可用不影响流水线事件
            }

            try
            {
                var projects = db.Queryable<SkuProject>()
                    .OrderByDescending(p => p.UpdatedAt)
                    .Take(20)
                    .ToList();

                foreach (var project in projects)
                {
                    items.Add(new ActivityItem(
                        "pipeline",
                        "pipeline",
                        "system",
                        $"{project.Title} · 工序 {project.CurrentStage ?? "-"} · {project.StageStatus ?? "pending"}" +
                        (string.IsNullOrWhiteSpace(project.StageNote) ? string.Empty : " · " + project.StageNote),
                        new DateTimeOffset(DateTime.SpecifyKind(project.UpdatedAt, DateTimeKind.Local))));
                }
            }
            catch (Exception)
            {
                // 商品表不可用不影响会话事件
            }

            var ordered = items
                .OrderByDescending(i => i.At)
                .Take(take)
                .ToList();

            return Results.Ok(ApiEnvelope<object>.Ok(ordered, context.TraceIdentifier));
        });
    }

    private static List<StoredMessage> ParseMessages(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return [];
        }
        try
        {
            return JsonSerializer.Deserialize<List<StoredMessage>>(json, StoredJson) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static string Truncate(string value, int max) =>
        value.Length <= max ? value : value[..max] + "…";

    private sealed record StoredMessage(string? Role, string? Text);
}

/// <summary>协同日志条目：kind=agent（Agent 会话）| pipeline（流水线状态变化）。</summary>
public sealed record ActivityItem(
    string Kind,
    string AgentKey,
    string Role,
    string Text,
    DateTimeOffset At);

/// <summary>新建任务入参：工作流必填（决定 recipe 与首工序）。</summary>
public sealed record CreateProductTaskRequest(
    string? Title,
    string? PipelineId,
    string? Category,
    string? BatchId);
