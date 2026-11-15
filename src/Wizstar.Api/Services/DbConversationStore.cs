using System.Text.Json;
using Microsoft.Extensions.AI;
using SqlSugar;
using Wizstar.Agents.Runtime;
using Wizstar.Data.Entities;

namespace Wizstar.Api.Services;

/// <summary>
/// 持久化会话存储：内存缓存 + MySQL（wiz_agent_session）。
///
/// - 每个 Agent 的上下文互相独立（会话 ID 由前端按 Agent 固定，历史按 conversationId 隔离）；
/// - 首次读取会话时从库里回填内存缓存，进程重启后历史不丢；
/// - 只持久化 user/assistant 文本（工具调用细节进审计/账本，不进对话历史）。
/// </summary>
public sealed class DbConversationStore(ISqlSugarClient db, ILogger<DbConversationStore> logger) : IConversationStore
{
    private const int MaxPersistedMessages = 100;

    private readonly ConversationStore _cache = new();

    public string NormalizeConversationId(string? conversationId) => _cache.NormalizeConversationId(conversationId);

    public List<ChatMessage> GetHistory(string conversationId, string agentKey)
    {
        var cached = _cache.GetHistory(conversationId, agentKey);
        if (cached.Count > 0)
        {
            return cached;
        }

        try
        {
            var row = db.Queryable<AgentSessionRecord>().First(r => r.ConversationId == conversationId);
            if (row is null || string.IsNullOrWhiteSpace(row.MessagesJson))
            {
                return [];
            }
            if (!string.Equals(row.AgentKey, agentKey, StringComparison.Ordinal))
            {
                // 同一 conversationId 被另一个 Agent 占用：按空历史处理，绝不串台
                logger.LogDebug("会话归属不匹配，按空历史处理: conv={ConversationId} owner={Owner} expect={AgentKey}",
                    conversationId, row.AgentKey, agentKey);
                return [];
            }

            var stored = JsonSerializer.Deserialize<List<StoredMessage>>(row.MessagesJson) ?? [];
            var history = new List<ChatMessage>();
            foreach (var item in stored)
            {
                var role = MapRole(item.Role);
                var message = new ChatMessage(role, item.Text ?? string.Empty);
                history.Add(message);
                _cache.Append(conversationId, agentKey, message);
            }
            return history;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "会话历史读取失败（按空历史继续）: conv={ConversationId}", conversationId);
            return [];
        }
    }

    public void Append(string conversationId, string agentKey, ChatMessage message)
    {
        _cache.Append(conversationId, agentKey, message);
        Persist(conversationId, agentKey);
    }

    private void Persist(string conversationId, string agentKey)
    {
        try
        {
            var history = _cache.GetHistory(conversationId, agentKey)
                .Where(m => m.Role != ChatRole.System)
                .Select(m => new StoredMessage(m.Role.Value, TextOf(m)))
                .Where(m => !string.IsNullOrWhiteSpace(m.Text))
                .TakeLast(MaxPersistedMessages)
                .ToList();

            var json = JsonSerializer.Serialize(history);
            var existing = db.Queryable<AgentSessionRecord>().First(r => r.ConversationId == conversationId);
            if (existing is not null && !string.Equals(existing.AgentKey, agentKey, StringComparison.Ordinal))
            {
                logger.LogWarning("会话 ID 已被其他 Agent 占用，本次不落库: conv={ConversationId} owner={Owner} expect={AgentKey}",
                    conversationId, existing.AgentKey, agentKey);
                return;
            }
            if (existing is not null)
            {
                db.Updateable<AgentSessionRecord>()
                    .SetColumns(r => r.AgentKey == agentKey)
                    .SetColumns(r => r.MessagesJson == json)
                    .SetColumns(r => r.UpdatedAtUtc == DateTime.UtcNow)
                    .Where(r => r.ConversationId == conversationId)
                    .ExecuteCommand();
            }
            else
            {
                db.Insertable(new AgentSessionRecord
                {
                    ConversationId = conversationId,
                    AgentKey = agentKey,
                    MessagesJson = json,
                    UpdatedAtUtc = DateTime.UtcNow,
                }).ExecuteCommand();
            }
        }
        catch (Exception ex)
        {
            // 持久化失败不阻断对话：内存历史仍然可用
            logger.LogWarning(ex, "会话历史持久化失败: conv={ConversationId} agent={AgentKey}", conversationId, agentKey);
        }
    }

    private static string TextOf(ChatMessage message) =>
        string.Join("", message.Contents.OfType<TextContent>().Select(c => c.Text));

    private static ChatRole MapRole(string? role) => role switch
    {
        "assistant" => ChatRole.Assistant,
        "system" => ChatRole.System,
        "tool" => ChatRole.Tool,
        _ => ChatRole.User,
    };

    private sealed record StoredMessage(string Role, string? Text);
}
