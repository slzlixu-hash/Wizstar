using Wizstar.Api.Services;
using Wizstar.Contracts;

namespace Wizstar.Api.Endpoints;

/// <summary>
/// Agent 群聊协同会诊端点：建群 / 读会话 / 增删参会人 / 一轮接力发言。
/// 会话本体复用 wiz_agent_session（AgentKey=__group__），不新增表。
/// </summary>
public static class GroupChatEndpoints
{
    public static void MapGroupChatEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/agents/groups").WithTags("Agents");

        group.MapGet("/", (int? limit, GroupChatService service, HttpContext context) =>
        {
            var take = Math.Clamp(limit ?? 20, 1, 100);
            return Results.Ok(ApiEnvelope<object>.Ok(service.ListRecent(take), context.TraceIdentifier));
        });

        group.MapPost("/", (CreateGroupSessionRequest? request, GroupChatService service, HttpContext context) =>
        {
            var view = service.Create(request?.Title, request?.Participants, request?.SourceConversationId);
            return Results.Ok(ApiEnvelope<object>.Ok(view, context.TraceIdentifier));
        });

        group.MapGet("/{conversationId}", (string conversationId, GroupChatService service, HttpContext context) =>
        {
            var view = service.Get(conversationId);
            return view is null
                ? Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"群聊会话不存在: {conversationId}", context.TraceIdentifier))
                : Results.Ok(ApiEnvelope<object>.Ok(view, context.TraceIdentifier));
        });

        group.MapPut("/{conversationId}/participants", (
            string conversationId, UpdateGroupParticipantsRequest? request, GroupChatService service, HttpContext context) =>
        {
            var view = service.UpdateParticipants(conversationId, request?.Participants);
            return Results.Ok(ApiEnvelope<object>.Ok(view, context.TraceIdentifier));
        });

        group.MapPost("/{conversationId}/turn", async (
            string conversationId,
            GroupTurnRequest? request,
            GroupChatService service,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            var files = (request?.Attachments ?? [])
                .Where(a => a is not null)
                .Select(a => new GroupChatService.GroupAttachment(a.Name, a.Mime, a.Size, a.Text))
                .ToList();

            var view = await service.TurnAsync(
                conversationId, request?.Message, request?.Mentions, request?.Tags, files, cancellationToken)
                .ConfigureAwait(false);

            return Results.Ok(ApiEnvelope<object>.Ok(view, context.TraceIdentifier));
        });
    }
}

public sealed record CreateGroupSessionRequest(
    string? Title,
    IReadOnlyList<string>? Participants,
    string? SourceConversationId);

public sealed record UpdateGroupParticipantsRequest(IReadOnlyList<string>? Participants);

public sealed record GroupTurnRequest(
    string? Message,
    IReadOnlyList<string>? Mentions,
    IReadOnlyList<ChatAttachment>? Attachments,
    IReadOnlyList<string>? Tags);
