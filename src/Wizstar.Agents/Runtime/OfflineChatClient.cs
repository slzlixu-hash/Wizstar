using System.Runtime.CompilerServices;
using Microsoft.Extensions.AI;

namespace Wizstar.Agents.Runtime;

/// <summary>
/// 离线回退 <see cref="IChatClient"/>：未配置 LLM 或上游不可用时保证 Agent 可运行、输出确定。
/// 口径（沿用旧项目）：真实模型优先，回退显式标注 offline，不伪造在线。
/// 行为：把最后一条用户消息回显成受理语；相同输入 → 相同输出。
/// </summary>
public sealed class OfflineChatClient(string reason) : IChatClient
{
    /// <summary>为什么处于离线模式（进 health / chat meta 事件，让用户知道当前是回退状态）。</summary>
    public string Reason { get; } = string.IsNullOrWhiteSpace(reason) ? "未配置 LLM" : reason;

    public string Mode => "offline";

    public Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(messages);

        var goal = messages
            .LastOrDefault(message => message.Role == ChatRole.User)?
            .Text?
            .Trim() ?? string.Empty;

        var reply = string.IsNullOrEmpty(goal)
            ? $"离线回退模式（{Reason}）：未收到明确目标，请提供需要处理的事务。"
            : $"离线回退模式（{Reason}）：已受理目标「{goal}」。当前未接入真实模型，无法执行工具调用与深度分析；请在模型设置中配置 LLM 后重试。";

        return Task.FromResult(new ChatResponse(new ChatMessage(ChatRole.Assistant, reply)));
    }

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var response = await GetResponseAsync(messages, options, cancellationToken).ConfigureAwait(false);
        foreach (var message in response.Messages)
        {
            yield return new ChatResponseUpdate(message.Role, message.Text);
        }
    }

    public object? GetService(Type serviceType, object? serviceKey = null)
    {
        ArgumentNullException.ThrowIfNull(serviceType);

        if (serviceKey is not null)
        {
            return null;
        }

        return serviceType.IsInstanceOfType(this) ? this : null;
    }

    public void Dispose()
    {
        // 离线桩无资源需要释放
    }
}
