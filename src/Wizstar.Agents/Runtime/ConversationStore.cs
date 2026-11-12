using Microsoft.Extensions.AI;

namespace Wizstar.Agents.Runtime;

/// <summary>
/// 会话存储：按 conversationId 保留消息历史（内存实现，进程重启即清空）。
/// 口径：Short-term Memory = 会话内消息与状态；持久化留给业务库接入阶段（Phase 2）。
/// </summary>
public sealed class ConversationStore
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

    public List<ChatMessage> GetHistory(string conversationId)
    {
        lock (_lock)
        {
            return _conversations.TryGetValue(conversationId, out var history)
                ? [.. history]
                : [];
        }
    }

    public void Append(string conversationId, ChatMessage message)
    {
        lock (_lock)
        {
            if (!_conversations.TryGetValue(conversationId, out var history))
            {
                history = [];
                _conversations[conversationId] = history;
                _order.Enqueue(conversationId);

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
