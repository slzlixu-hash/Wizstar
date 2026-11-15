using System.Text.Json;
using Microsoft.Extensions.AI;
using SqlSugar;
using Wizstar.Agents.Profiles;
using Wizstar.Agents.Runtime;
using Wizstar.Api.Middleware;
using Wizstar.Api.Services;
using Wizstar.Contracts;
using Wizstar.Data.Entities;

namespace Wizstar.Api.Endpoints;

/// <summary>
/// Agent 记忆 / 知识库 / 上下文设置 / 会话历史端点。
/// 全部按 agentKey 隔离：一个 Agent 的长期记忆不会进另一个 Agent 的上下文。
/// </summary>
public static class AgentMemoryEndpoints
{
    public static void MapAgentMemoryEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/agents/{key}").WithTags("Agents");

        group.MapGet("/memory", (string key, AgentMemoryService service, HttpContext context) =>
            Results.Ok(ApiEnvelope<object>.Ok(service.GetBundle(key), context.TraceIdentifier)));

        group.MapPost("/memory", (string key, AgentMemoryRequest? request, AgentMemoryService service, HttpContext context) =>
        {
            if (request is null || string.IsNullOrWhiteSpace(request.Subject) || string.IsNullOrWhiteSpace(request.ValueText))
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, "记忆主题与内容不能为空", context.TraceIdentifier));
            }

            var actor = CurrentUser.From(context)?.Username;
            var id = service.AddMemory(
                key, request.Subject, request.Metric, request.ValueText, request.Confidence, actor,
                request.Tags, request.ExpiresAt, request.SyncAgentKeys, request.Confirmed ?? true);
            return Results.Ok(ApiEnvelope<object>.Ok(new { id, agentKey = key }, context.TraceIdentifier));
        });

        group.MapPut("/memory/{id:long}", (
            string key, long id, AgentMemoryUpdateRequest? request, AgentMemoryService service, HttpContext context) =>
        {
            if (request is null)
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, "缺少记忆更新入参", context.TraceIdentifier));
            }
            var actor = CurrentUser.From(context)?.Username;
            var ok = service.UpdateMemory(
                key, id, request.Subject, request.Metric, request.ValueText, request.Confidence,
                request.Tags, request.ExpiresAt, request.SyncAgentKeys, request.Confirmed, actor);
            return ok
                ? Results.Ok(ApiEnvelope<object>.Ok(new { id, updated = true }, context.TraceIdentifier))
                : Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"记忆不存在: {id}", context.TraceIdentifier));
        });

        group.MapDelete("/memory/{id:long}", (string key, long id, AgentMemoryService service, HttpContext context) =>
        {
            var removed = service.DeleteMemory(key, id);
            return removed
                ? Results.Ok(ApiEnvelope<object>.Ok(new { id, removed = true }, context.TraceIdentifier))
                : Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"记忆不存在: {id}", context.TraceIdentifier));
        });

        /* 自学习：扫描近 7 天驳回 / 微信小店审核 / 退货率，产出 0~5 条待确认候选。 */
        group.MapPost("/memory/learn", (string key, AgentMemoryService service, HttpContext context) =>
        {
            var actor = CurrentUser.From(context)?.Username;
            var result = service.Learn(key, actor);
            return Results.Ok(ApiEnvelope<object>.Ok(result, context.TraceIdentifier));
        });

        /* 确认候选：replace=true 自动归档同主题旧规则；syncAgentKeys 跨 Agent 分发。 */
        group.MapPost("/memory/{id:long}/confirm", (
            string key, long id, MemoryConfirmRequest? request, AgentMemoryService service, HttpContext context) =>
        {
            var actor = CurrentUser.From(context)?.Username;
            var result = service.ConfirmMemory(key, id, request?.Replace ?? false, request?.SyncAgentKeys, actor);
            return Results.Ok(ApiEnvelope<object>.Ok(result, context.TraceIdentifier));
        });

        group.MapPost("/memory/{id:long}/reject", (string key, long id, AgentMemoryService service, HttpContext context) =>
        {
            var ok = service.RejectMemory(key, id);
            return ok
                ? Results.Ok(ApiEnvelope<object>.Ok(new { id, rejected = true }, context.TraceIdentifier))
                : Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"记忆不存在: {id}", context.TraceIdentifier));
        });

        group.MapPost("/memory/{id:long}/archive", (string key, long id, AgentMemoryService service, HttpContext context) =>
        {
            var ok = service.ArchiveMemory(key, id);
            return ok
                ? Results.Ok(ApiEnvelope<object>.Ok(new { id, archived = true }, context.TraceIdentifier))
                : Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"记忆不存在: {id}", context.TraceIdentifier));
        });

        /* 白盒预览：给定场景标签，实时演算 Layer 3 注入了哪些规则。 */
        group.MapGet("/memory/preview", (
            string key, string? tags, AgentMemoryService service, HttpContext context) =>
        {
            var list = (tags ?? string.Empty)
                .Split([',', '，'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .ToList();
            var preview = service.Preview(key, list);
            return Results.Ok(ApiEnvelope<object>.Ok(preview, context.TraceIdentifier));
        });

        group.MapGet("/memory/scopes", (string key, AgentMemoryService service, HttpContext context) =>
        {
            var scopes = service.Scopes(key);
            return Results.Ok(ApiEnvelope<object>.Ok(scopes, context.TraceIdentifier));
        });

        group.MapGet("/memory/team", (string key, int? limit, AgentMemoryService service, HttpContext context) =>
        {
            var rows = service.TeamMemories(limit ?? 50);
            return Results.Ok(ApiEnvelope<object>.Ok(rows, context.TraceIdentifier));
        });

        group.MapGet("/memory/team/overview", (string key, AgentMemoryService service, HttpContext context) =>
            Results.Ok(ApiEnvelope<object>.Ok(service.TeamOverview(), context.TraceIdentifier)));

        group.MapPost("/memory/team/broadcast", (string key, AgentMemoryService service, HttpContext context) =>
        {
            var count = service.ShareAllToTeam(key);
            return Results.Ok(ApiEnvelope<object>.Ok(new { shared = count }, context.TraceIdentifier));
        });

        group.MapPut("/memory/team/{id:long}", (
            string key, long id, TeamRuleUpdateRequest? request, AgentMemoryService service, HttpContext context) =>
        {
            var updated = service.UpdateTeamRule(
                id, request?.Subject, request?.Metric, request?.ValueText,
                request?.Tags, request?.SyncAgentKeys, request?.ExpiresAt);
            return updated is null
                ? Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"共享规则不存在: {id}", context.TraceIdentifier))
                : Results.Ok(ApiEnvelope<object>.Ok(updated, context.TraceIdentifier));
        });

        group.MapPost("/memory/team/{id:long}/unshare", (
            string key, long id, AgentMemoryService service, HttpContext context) =>
        {
            var ok = service.UnshareTeamRule(id);
            return ok
                ? Results.Ok(ApiEnvelope<object>.Ok(new { id, unshared = true }, context.TraceIdentifier))
                : Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"共享规则不存在或已下线: {id}", context.TraceIdentifier));
        });

        group.MapPost("/knowledge", (string key, AgentKnowledgeRequest? request, AgentMemoryService service, HttpContext context) =>
        {
            if (request is null || string.IsNullOrWhiteSpace(request.Title) || string.IsNullOrWhiteSpace(request.Content))
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, "知识标题与内容不能为空", context.TraceIdentifier));
            }

            var id = service.AddKnowledge(key, request.Title, request.Tags, request.Content);
            return Results.Ok(ApiEnvelope<object>.Ok(new { id, agentKey = key }, context.TraceIdentifier));
        });

        group.MapPut("/knowledge/{id:long}", (
            string key, long id, AgentKnowledgeUpdateRequest? request, AgentMemoryService service, HttpContext context) =>
        {
            if (request is null)
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, "缺少知识更新入参", context.TraceIdentifier));
            }
            var updated = service.UpdateKnowledge(
                key, id, request.Title, request.Tags, request.Content, request.Enabled);
            return updated is null
                ? Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"知识条目不存在: {id}", context.TraceIdentifier))
                : Results.Ok(ApiEnvelope<object>.Ok(updated, context.TraceIdentifier));
        });

        group.MapDelete("/knowledge/{id:long}", (string key, long id, AgentMemoryService service, HttpContext context) =>
        {
            var removed = service.DeleteKnowledge(key, id);
            return removed
                ? Results.Ok(ApiEnvelope<object>.Ok(new { id, removed = true }, context.TraceIdentifier))
                : Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"知识条目不存在: {id}", context.TraceIdentifier));
        });

        group.MapPut("/context", (string key, AgentContextSettingsRequest? request, AgentMemoryService service, HttpContext context) =>
        {
            var settings = service.UpdateSettings(
                key, request?.MaxMemoryChars, request?.MaxKnowledgeChars, request?.EnableL1Extraction);
            return Results.Ok(ApiEnvelope<object>.Ok(settings, context.TraceIdentifier));
        });

        /* 会话列表：最近对话（按 Agent 独立），供 Chat 面板左侧会话列表使用。
           指挥官还会带上群聊会诊会话（AgentKey=__group__），左侧统一展示。 */
        group.MapGet("/sessions", (
            string key, int? limit, bool? includeArchived, AgentCatalog catalog, ISqlSugarClient db,
            GroupChatService groups, HttpContext context) =>
        {
            if (catalog.Find(key) is null)
            {
                return Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"名册中不存在 Agent: {key}", context.TraceIdentifier));
            }

            var take = Math.Clamp(limit ?? 20, 1, 100);
            // 排除群聊内部会话（"{groupId}:{agentKey}"）：它们只作为专员记忆通道，不在单聊列表露头
            var query = db.Queryable<AgentSessionRecord>()
                .Where(r => r.AgentKey == key && !r.ConversationId.Contains(":"));
            if (includeArchived != true)
            {
                query = query.Where(r => r.ArchivedAtUtc == null);
            }
            var rows = query
                .OrderByDescending(r => r.UpdatedAtUtc)
                .Take(take)
                .ToList();

            var sessions = rows.Select(row =>
            {
                var messages = AgentSessionParsing.ParseStoredMessages(row.MessagesJson);
                var last = messages.LastOrDefault();
                return new SessionItem(
                    row.ConversationId,
                    new DateTimeOffset(DateTime.SpecifyKind(row.UpdatedAtUtc, DateTimeKind.Utc)),
                    messages.Count,
                    AgentSessionParsing.Truncate(last?.Text ?? string.Empty, 80),
                    "single",
                    null,
                    null,
                    row.ArchivedAtUtc is not null);
            }).ToList();

            if (string.Equals(key, GroupChatService.HostKey, StringComparison.OrdinalIgnoreCase))
            {
                sessions.AddRange(groups.ListRecent(take, includeArchived == true).Select(g => new SessionItem(
                    g.ConversationId,
                    g.UpdatedAt,
                    g.MessageCount,
                    g.Preview,
                    "group",
                    g.Title,
                    g.Participants,
                    g.Archived)));
            }

            var ordered = sessions.OrderByDescending(s => s.UpdatedAt).Take(take).ToList();
            return Results.Ok(ApiEnvelope<object>.Ok(new { agentKey = key, sessions = ordered }, context.TraceIdentifier));
        });

        /* 归档 / 恢复：只隐藏于列表，历史仍可读；群聊归档后拒绝继续会诊。 */
        group.MapPost("/sessions/{conversationId}/archive", (
            string key, string conversationId, SessionArchiveRequest? request,
            AgentCatalog catalog, ISqlSugarClient db, HttpContext context) =>
        {
            if (catalog.Find(key) is null)
            {
                return Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"名册中不存在 Agent: {key}", context.TraceIdentifier));
            }
            var row = FindManagedSession(db, key, conversationId);
            if (row is null)
            {
                return Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"会话不存在或不属于该 Agent: {conversationId}", context.TraceIdentifier));
            }

            var archived = request?.Archived ?? true;
            var at = archived ? DateTime.UtcNow : (DateTime?)null;
            db.Updateable<AgentSessionRecord>()
                .SetColumns(r => r.ArchivedAtUtc == at)
                .Where(r => r.ConversationId == conversationId)
                .ExecuteCommand();

            return Results.Ok(ApiEnvelope<object>.Ok(
                new { conversationId, archived, archivedAt = at }, context.TraceIdentifier));
        });

        /* 删除：群聊同时清掉 "{groupId}:{agentKey}" 内部通道，避免残留专员记忆。 */
        group.MapDelete("/sessions/{conversationId}", (
            string key, string conversationId, AgentCatalog catalog, ISqlSugarClient db, HttpContext context) =>
        {
            if (catalog.Find(key) is null)
            {
                return Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"名册中不存在 Agent: {key}", context.TraceIdentifier));
            }
            var row = FindManagedSession(db, key, conversationId);
            if (row is null)
            {
                return Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"会话不存在或不属于该 Agent: {conversationId}", context.TraceIdentifier));
            }

            var removed = string.Equals(row.AgentKey, GroupChatService.GroupAgentKey, StringComparison.Ordinal)
                ? db.Deleteable<AgentSessionRecord>()
                    .Where(r => r.ConversationId == conversationId || r.ConversationId.StartsWith(conversationId + ":"))
                    .ExecuteCommand()
                : db.Deleteable<AgentSessionRecord>()
                    .Where(r => r.ConversationId == conversationId)
                    .ExecuteCommand();

            return Results.Ok(ApiEnvelope<object>.Ok(
                new { conversationId, removed = removed > 0, deletedRows = removed }, context.TraceIdentifier));
        });

        /* 会话历史：切回工作台时恢复上次对话（按 Agent 独立）。 */
        group.MapGet("/conversations/{conversationId}", (
            string key, string conversationId, AgentCatalog catalog, IConversationStore store, HttpContext context) =>
        {
            if (catalog.Find(key) is null)
            {
                return Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"名册中不存在 Agent: {key}", context.TraceIdentifier));
            }

            var history = store.GetHistory(conversationId, key)
                .Where(m => m.Role != ChatRole.System)
                .Select(m => new
                {
                    role = m.Role == ChatRole.Assistant ? "assistant" : "user",
                    text = string.Join("", m.Contents.OfType<TextContent>().Select(c => c.Text)),
                })
                .Where(m => !string.IsNullOrWhiteSpace(m.text))
                .ToList();

            return Results.Ok(ApiEnvelope<object>.Ok(new { conversationId, agentKey = key, messages = history }, context.TraceIdentifier));
        });
    }

    /// <summary>会话归属：本人单聊，或指挥官管理下的群聊会话。</summary>
    private static AgentSessionRecord? FindManagedSession(ISqlSugarClient db, string key, string conversationId)
    {
        var row = db.Queryable<AgentSessionRecord>().First(r => r.ConversationId == conversationId);
        if (row is null)
        {
            return null;
        }
        if (string.Equals(row.AgentKey, key, StringComparison.OrdinalIgnoreCase))
        {
            return row;
        }
        return string.Equals(row.AgentKey, GroupChatService.GroupAgentKey, StringComparison.Ordinal)
            && string.Equals(key, GroupChatService.HostKey, StringComparison.OrdinalIgnoreCase)
            ? row
            : null;
    }
}

public sealed record AgentMemoryRequest(
    string? Subject,
    string? Metric,
    string? ValueText,
    decimal? Confidence,
    string? Tags,
    DateTime? ExpiresAt,
    IReadOnlyList<string>? SyncAgentKeys,
    bool? Confirmed);

public sealed record AgentMemoryUpdateRequest(
    string? Subject,
    string? Metric,
    string? ValueText,
    decimal? Confidence,
    string? Tags,
    DateTime? ExpiresAt,
    IReadOnlyList<string>? SyncAgentKeys,
    bool? Confirmed);

public sealed record MemoryConfirmRequest(bool? Replace, IReadOnlyList<string>? SyncAgentKeys);

public sealed record TeamRuleUpdateRequest(
    string? Subject,
    string? Metric,
    string? ValueText,
    string? Tags,
    IReadOnlyList<string>? SyncAgentKeys,
    DateTime? ExpiresAt);

internal static class AgentSessionParsing
{
    private static readonly JsonSerializerOptions Options = new() { PropertyNameCaseInsensitive = true };

    public static List<StoredMessage> ParseStoredMessages(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return [];
        }
        try
        {
            return JsonSerializer.Deserialize<List<StoredMessage>>(json, Options) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    public static string Truncate(string value, int max) =>
        value.Length <= max ? value : value[..max] + "…";

    public sealed record StoredMessage(string? Role, string? Text);
}

public sealed record AgentKnowledgeRequest(string? Title, string? Tags, string? Content);

public sealed record AgentKnowledgeUpdateRequest(
    string? Title, string? Tags, string? Content, bool? Enabled);

public sealed record AgentContextSettingsRequest(int? MaxMemoryChars, int? MaxKnowledgeChars, bool? EnableL1Extraction);

/// <summary>左侧会话列表项：kind=single（单聊）| group（群聊会诊，带参会人）。</summary>
public sealed record SessionItem(
    string ConversationId,
    DateTimeOffset UpdatedAt,
    int MessageCount,
    string Preview,
    string Kind,
    string? Title,
    IReadOnlyList<string>? Participants,
    bool Archived);

public sealed record SessionArchiveRequest(bool? Archived);
