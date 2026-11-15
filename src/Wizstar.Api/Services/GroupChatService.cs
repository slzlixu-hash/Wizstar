using System.Text.Json;
using SqlSugar;
using Wizstar.Agents.Profiles;
using Wizstar.Agents.Runtime;
using Wizstar.Contracts;
using Wizstar.Data.Entities;

namespace Wizstar.Api.Services;

/// <summary>
/// Agent 群聊会诊：一个群会话（wiz_agent_session 中 AgentKey=__group__）承载多专员接力发言。
///
/// 规则（防死循环）：
///  - 每轮只有「被 @ 的专员」各发言 1 次（未指定视为全体在场专员）；
///  - 专员发言结束后，固定由指挥官发言 1 次做收敛总结（带「采纳并推进」标记）；
///  - 每位专员使用自己的 conversationId（"{groupId}:{key}"），记忆 / 上下文 / 工具授权严格隔离。
/// </summary>
public sealed class GroupChatService(
    ISqlSugarClient db,
    AgentCatalog catalog,
    AgentRunner runner,
    ILogger<GroupChatService> logger)
{
    public const string GroupAgentKey = "__group__";
    public const string HostKey = "commander";
    private const int MaxParticipants = 6;

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    public sealed record GroupMessageView(string Role, string? Name, string Text, string? Meta, bool CanAdopt);

    /// <summary>群聊附件（与单聊 ChatAttachment 同形，落在这里避免服务层反向依赖端点层）。</summary>
    public sealed record GroupAttachment(string? Name, string? Mime, long Size, string? Text);

    public sealed record GroupSessionView(
        string ConversationId,
        string Title,
        IReadOnlyList<string> Participants,
        IReadOnlyList<GroupMessageView> Messages,
        DateTimeOffset UpdatedAt);

    /// <summary>
    /// 建群。sourceConversationId 指向当前单聊会话时，直接把该会话「升级」成群聊：
    /// 原 user/assistant 历史映射为 user/commander 入 transcript，会话 ID 不变，左侧列表不留重复单聊。
    /// </summary>
    public GroupSessionView Create(string? title, IReadOnlyList<string>? participants, string? sourceConversationId = null)
    {
        var ids = NormalizeParticipants(participants);
        var cleanTitle = NormalizeTitle(title);

        if (!string.IsNullOrWhiteSpace(sourceConversationId))
        {
            var source = db.Queryable<AgentSessionRecord>()
                .First(r => r.ConversationId == sourceConversationId && r.AgentKey == HostKey);
            if (source is not null)
            {
                var history = ParseMessages(source.MessagesJson)
                    .Where(m => !string.IsNullOrWhiteSpace(m.Text))
                    .Select(m => new StoredMessage(
                        string.Equals(m.Role, "assistant", StringComparison.OrdinalIgnoreCase) ? HostKey : "user",
                        string.Equals(m.Role, "assistant", StringComparison.OrdinalIgnoreCase) ? "指挥官 Commander" : "你",
                        m.Text,
                        m.Meta,
                        false))
                    .ToList();

                source.AgentKey = GroupAgentKey;
                source.Title = cleanTitle;
                source.ParticipantsJson = JsonSerializer.Serialize(ids);
                source.MessagesJson = JsonSerializer.Serialize(history);
                source.UpdatedAtUtc = DateTime.UtcNow;
                db.Updateable(source)
                    .UpdateColumns(r => new
                    {
                        r.AgentKey, r.Title, r.ParticipantsJson, r.MessagesJson, r.UpdatedAtUtc
                    })
                    .ExecuteCommand();

                logger.LogInformation("单聊升级为群聊: {GroupId} participants={Participants} history={Count}",
                    source.ConversationId, string.Join(",", ids), history.Count);
                return Get(source.ConversationId)!;
            }
        }

        var id = "grp-" + Guid.NewGuid().ToString("N")[..16];
        var row = new AgentSessionRecord
        {
            ConversationId = id,
            AgentKey = GroupAgentKey,
            Title = cleanTitle,
            ParticipantsJson = JsonSerializer.Serialize(ids),
            MessagesJson = "[]",
            UpdatedAtUtc = DateTime.UtcNow,
        };
        db.Insertable(row).ExecuteCommand();
        logger.LogInformation("创建群聊会诊: {GroupId} participants={Participants}", id, string.Join(",", ids));
        return Get(id)!;
    }

    public GroupSessionView? Get(string conversationId)
    {
        var row = FindRow(conversationId);
        return row is null ? null : ToView(row);
    }

    public GroupSessionView UpdateParticipants(string conversationId, IReadOnlyList<string>? participants)
    {
        var row = FindRow(conversationId) ?? throw ApiException.Validation($"群聊会话不存在: {conversationId}");
        var ids = NormalizeParticipants(participants);
        db.Updateable<AgentSessionRecord>()
            .SetColumns(r => r.ParticipantsJson == JsonSerializer.Serialize(ids))
            .SetColumns(r => r.UpdatedAtUtc == DateTime.UtcNow)
            .Where(r => r.ConversationId == conversationId && r.AgentKey == GroupAgentKey)
            .ExecuteCommand();
        row.ParticipantsJson = JsonSerializer.Serialize(ids);
        return ToView(row);
    }

    /// <summary>一轮群聊：被 @ 专员各发言一次 → 指挥官收敛总结一次。</summary>
    public async Task<GroupSessionView> TurnAsync(
        string conversationId,
        string? message,
        IReadOnlyList<string>? mentions,
        IReadOnlyList<string>? tags,
        IReadOnlyList<GroupAttachment>? attachments,
        CancellationToken cancellationToken)
    {
        var row = FindRow(conversationId) ?? throw ApiException.Validation($"群聊会话不存在: {conversationId}");
        if (row.ArchivedAtUtc is not null)
        {
            throw ApiException.Validation("该群聊已归档，恢复后再继续会诊");
        }
        var body = (message ?? string.Empty).Trim();
        if (body.Length == 0)
        {
            throw ApiException.Validation("群聊指令不能为空");
        }

        var participants = ParseParticipants(row.ParticipantsJson);
        var transcript = ParseMessages(row.MessagesJson);
        var files = (attachments ?? [])
            .Where(a => a is not null && !string.IsNullOrWhiteSpace(a.Name))
            .Select(a => new AgentAttachment(a.Name!.Trim(), a.Mime, a.Size, a.Text))
            .ToList();

        transcript.Add(new StoredMessage("user", "你", body, files.Count > 0 ? "附件 " + files.Count + " 个" : null, false));

        // 本轮发言名单：@all/空 → 全体在场专员；否则只让被 @ 的专员发言
        var wanted = (mentions ?? [])
            .Select(m => (m ?? string.Empty).Trim().ToLowerInvariant())
            .Where(m => m.Length > 0)
            .ToList();
        var all = wanted.Count == 0 || wanted.Contains("all");
        var speakers = participants
            .Where(p => p != HostKey)
            .Where(p => all || wanted.Contains(p))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        var hostRequested = wanted.Contains(HostKey);

        var replies = new List<StoredMessage>();
        foreach (var key in speakers)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var profile = catalog.Find(key);
            var name = profile?.DisplayName ?? key;
            var prompt = BuildSpecialistPrompt(body, name, replies);
            try
            {
                var result = await runner.RunAsync(
                    new AgentRunOptions(key, $"{conversationId}:{key}", prompt, files, tags), cancellationToken)
                    .ConfigureAwait(false);
                var text = string.IsNullOrWhiteSpace(result.Output) ? result.Message : result.Output;
                var meta = string.IsNullOrWhiteSpace(result.Model)
                    ? $"通道 {result.Mode} · {result.ElapsedMs}ms"
                    : $"通道 {result.Mode} · {result.Model} · {result.ElapsedMs}ms";
                var stored = new StoredMessage(key, name, text, meta, false);
                transcript.Add(stored);
                replies.Add(stored);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "群聊专员发言失败: group={GroupId} agent={Agent}", conversationId, key);
                transcript.Add(new StoredMessage(key, name, "发言失败：" + ex.Message, "error", false));
            }
        }

        // 固定由指挥官收敛（防无限接力）
        if (speakers.Count > 0 || hostRequested || participants.Count == 1)
        {
            try
            {
                var summaryPrompt = BuildCommanderPrompt(body, replies);
                var result = await runner.RunAsync(
                    new AgentRunOptions(HostKey, $"{conversationId}:{HostKey}", summaryPrompt, [], tags),
                    cancellationToken).ConfigureAwait(false);
                var text = string.IsNullOrWhiteSpace(result.Output) ? result.Message : result.Output;
                transcript.Add(new StoredMessage(
                    HostKey, "指挥官 Commander", text,
                    string.IsNullOrWhiteSpace(result.Model)
                        ? $"通道 {result.Mode} · {result.ElapsedMs}ms"
                        : $"通道 {result.Mode} · {result.Model} · {result.ElapsedMs}ms", true));
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "群聊指挥官总结失败: group={GroupId}", conversationId);
                transcript.Add(new StoredMessage(HostKey, "指挥官 Commander", "总结失败：" + ex.Message, "error", false));
            }
        }

        db.Updateable<AgentSessionRecord>()
            .SetColumns(r => r.MessagesJson == JsonSerializer.Serialize(transcript))
            .SetColumns(r => r.UpdatedAtUtc == DateTime.UtcNow)
            .Where(r => r.ConversationId == conversationId && r.AgentKey == GroupAgentKey)
            .ExecuteCommand();

        row.MessagesJson = JsonSerializer.Serialize(transcript);
        row.UpdatedAtUtc = DateTime.UtcNow;
        return ToView(row);
    }

    /// <summary>会话列表用：最近群聊（含标题、参会人数、末条预览）。</summary>
    public List<GroupSessionSummary> ListRecent(int take, bool includeArchived = false)
    {
        var query = db.Queryable<AgentSessionRecord>()
            .Where(r => r.AgentKey == GroupAgentKey);
        if (!includeArchived)
        {
            query = query.Where(r => r.ArchivedAtUtc == null);
        }
        var rows = query
            .OrderByDescending(r => r.UpdatedAtUtc)
            .Take(take)
            .ToList();

        return rows.Select(row =>
        {
            var messages = ParseMessages(row.MessagesJson);
            var last = messages.LastOrDefault();
            var participants = ParseParticipants(row.ParticipantsJson);
            return new GroupSessionSummary(
                row.ConversationId,
                string.IsNullOrWhiteSpace(row.Title) ? "未命名会诊" : row.Title,
                participants,
                messages.Count,
                Truncate(last?.Text ?? string.Empty, 80),
                new DateTimeOffset(DateTime.SpecifyKind(row.UpdatedAtUtc, DateTimeKind.Utc)),
                row.ArchivedAtUtc is not null);
        }).ToList();
    }

    public sealed record GroupSessionSummary(
        string ConversationId,
        string Title,
        IReadOnlyList<string> Participants,
        int MessageCount,
        string Preview,
        DateTimeOffset UpdatedAt,
        bool Archived);

    // ---------------------------------------------------------------- 内部

    private AgentSessionRecord? FindRow(string conversationId) =>
        db.Queryable<AgentSessionRecord>()
            .First(r => r.ConversationId == conversationId && r.AgentKey == GroupAgentKey);

    private static string NormalizeTitle(string? title)
    {
        var value = (title ?? string.Empty).Trim();
        if (value.Length == 0)
        {
            return "未命名会诊";
        }
        // 与 Title 列 varchar(256) 对齐，避免超长主题在严格模式下写库失败
        return value.Length <= 200 ? value : value[..200];
    }

    private IReadOnlyList<string> NormalizeParticipants(IReadOnlyList<string>? participants)    {
        var ids = (participants ?? [])
            .Select(p => (p ?? string.Empty).Trim().ToLowerInvariant())
            .Where(p => p.Length > 0 && catalog.Find(p) is not null)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        // 指挥官固定为主持人
        if (!ids.Contains(HostKey, StringComparer.OrdinalIgnoreCase))
        {
            ids.Insert(0, HostKey);
        }
        if (ids.Count > MaxParticipants)
        {
            ids = ids.Take(MaxParticipants).ToList();
        }
        if (ids.Count < 2)
        {
            throw ApiException.Validation("群聊至少需要一位专员（当前只有指挥官）");
        }
        return ids;
    }

    private static List<string> ParseParticipants(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return [HostKey];
        }
        try
        {
            return JsonSerializer.Deserialize<List<string>>(json, JsonOptions) ?? [HostKey];
        }
        catch (JsonException)
        {
            return [HostKey];
        }
    }

    private static List<StoredMessage> ParseMessages(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return [];
        }
        try
        {
            return JsonSerializer.Deserialize<List<StoredMessage>>(json, JsonOptions) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static GroupSessionView ToView(AgentSessionRecord row) => new(
        row.ConversationId,
        string.IsNullOrWhiteSpace(row.Title) ? "未命名会诊" : row.Title,
        ParseParticipants(row.ParticipantsJson),
        ParseMessages(row.MessagesJson)
            .Select(m => new GroupMessageView(m.Role, m.Name, m.Text, m.Meta, m.CanAdopt))
            .ToList(),
        new DateTimeOffset(DateTime.SpecifyKind(row.UpdatedAtUtc, DateTimeKind.Utc)));

    private static string BuildSpecialistPrompt(string userMessage, string displayName, List<StoredMessage> priorReplies)
    {
        var lines = new List<string>
        {
            "【群聊会诊】指挥官主持，你是 " + displayName + "。",
            "用户诉求：" + userMessage,
        };
        if (priorReplies.Count > 0)
        {
            lines.Add("本轮其他专员已发言：");
            foreach (var r in priorReplies)
            {
                lines.Add($"- {r.Name}：{Truncate(r.Text, 800)}");
            }
        }
        lines.Add("请从你的职责给出结论与下一步（≤300 字），必要时点名其他专员；不要代替其他角色发言。");
        return string.Join("\n", lines);
    }

    private static string BuildCommanderPrompt(string userMessage, List<StoredMessage> replies)
    {
        var lines = new List<string>
        {
            "【群聊会诊 · 指挥官收敛】",
            "用户诉求：" + userMessage,
            "专员发言：",
        };
        foreach (var r in replies)
        {
            lines.Add($"- {r.Name}：{Truncate(r.Text, 1000)}");
        }
        lines.Add("请给出 1–3 条会诊结论与明确下一步（是否采纳、推进哪道工序），不要客套与重复，不要无限接力。");
        return string.Join("\n", lines);
    }

    private static string Truncate(string value, int max) =>
        value.Length <= max ? value : value[..max] + "…";

    private sealed record StoredMessage(
        string Role, string? Name, string Text, string? Meta, bool CanAdopt);
}
