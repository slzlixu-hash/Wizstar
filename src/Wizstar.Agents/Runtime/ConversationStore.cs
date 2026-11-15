using Microsoft.Extensions.AI;

namespace Wizstar.Agents.Runtime;

/// <summary>
/// 会话存储契约：按 conversationId 保留消息历史。
/// 内存实现见 <see cref="ConversationStore"/>；需要跨进程持久化时由宿主提供 DB 实现。
/// </summary>
public interface IConversationStore
{
    string NormalizeConversationId(string? conversationId);

    List<ChatMessage> GetHistory(string conversationId, string agentKey);

    void Append(string conversationId, string agentKey, ChatMessage message);
}

/// <summary>
/// 会话存储（内存实现，进程重启即清空）：同一 conversationId 内保留最近 100 条消息。
/// 口径：Short-term Memory = 会话内消息与状态。
/// </summary>
public sealed class ConversationStore : IConversationStore
{
    private const int MaxConversations = 200;
    private const int MaxMessagesPerConversation = 100;

    private readonly object _lock = new();
    private readonly Dictionary<string, List<ChatMessage>> _conversations = new(StringComparer.Ordinal);
    private readonly Queue<string> _order = new();

    public string NormalizeConversationId(string? conversationId)
    {
        var id = (conversationId ?? string.Empty).Trim();
        return id.Length > 0 && id.Length <= 64 ? id : "conv-" + Guid.NewGuid().ToString("N")[..12];
    }

    /// <summary>缓存键按 Agent 分区：同一 conversationId 在不同 Agent 下互不可见。</summary>
    private static string Key(string conversationId, string agentKey) =>
        (string.IsNullOrWhiteSpace(agentKey) ? "-" : agentKey) + "" + conversationId;

    public List<ChatMessage> GetHistory(string conversationId, string agentKey)
    {
        var key = Key(conversationId, agentKey);
        lock (_lock)
        {
            return _conversations.TryGetValue(key, out var history)
                ? [.. history]
                : [];
        }
    }

    public void Append(string conversationId, string agentKey, ChatMessage message)
    {
        var key = Key(conversationId, agentKey);
        lock (_lock)
        {
            if (!_conversations.TryGetValue(key, out var history))
            {
                history = [];
                _conversations[key] = history;
                _order.Enqueue(key);

                // 简单的容量保护：最旧会话逐出（内存实现，重启即清空）
                while (_order.Count > MaxConversations && _order.TryDequeue(out var oldest))
                {
                    _conversations.Remove(oldest);
                }
            }

            history.Add(message);
            if (history.Count > MaxMessagesPerConversation)
            {
                history.RemoveRange(0, history.Count - MaxMessagesPerConversation);
            }
        }
    }
}
