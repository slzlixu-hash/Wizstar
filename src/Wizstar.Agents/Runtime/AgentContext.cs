using System.Text;

namespace Wizstar.Agents.Runtime;

/// <summary>
/// 一次运行注入的长期记忆 / 知识库上下文块（与 systemPrompt 分开成独立 system 消息，便于审计）。
/// </summary>
public sealed record AgentContextBlock(
    string? MemoryText,
    string? KnowledgeText,
    IReadOnlyList<long> MemoryIds,
    IReadOnlyList<long> KnowledgeIds,
    int TotalChars,
    bool Truncated,
    int MaxMemoryChars,
    int MaxKnowledgeChars)
{
    public static AgentContextBlock Empty { get; } = new(null, null, [], [], 0, false, 0, 0);

    public bool IsEmpty => string.IsNullOrWhiteSpace(MemoryText) && string.IsNullOrWhiteSpace(KnowledgeText);

    /// <summary>拼成一条 system 消息；没有内容时返回 null。</summary>
    public string? ToSystemMessage()
    {
        if (IsEmpty)
        {
            return null;
        }

        var sb = new StringBuilder();
        sb.AppendLine("以下是该 Agent 的长期记忆与知识库（平台注入，可能不完整）：");
        if (!string.IsNullOrWhiteSpace(MemoryText))
        {
            sb.AppendLine();
            sb.AppendLine("【长期记忆】");
            sb.AppendLine(MemoryText);
        }
        if (!string.IsNullOrWhiteSpace(KnowledgeText))
        {
            sb.AppendLine();
            sb.AppendLine("【知识库】");
            sb.AppendLine(KnowledgeText);
        }
        if (Truncated)
        {
            sb.AppendLine();
            sb.AppendLine("（注意：注入内容已按配置上限截断；缺失信息请如实说明，不要臆造。）");
        }
        return sb.ToString().TrimEnd();
    }
}

/// <summary>
/// Agent 上下文提供者：加载该 Agent 的长期记忆 + 知识库，并在运行后记录注入快照。
/// 生产实现走 MySQL（agent_memory / agent_knowledge_item / agent_context_setting / agent_context_snapshot）。
/// </summary>
public interface IAgentContextProvider
{
    Task<AgentContextBlock> BuildAsync(
        string agentKey,
        string conversationId,
        IReadOnlyList<string>? tags,
        CancellationToken cancellationToken);

    Task RecordAsync(string agentKey, string conversationId, AgentContextBlock block, CancellationToken cancellationToken);
}

/// <summary>
/// 规则标签 / 同步范围工具（纯函数）：
///  - 无标签或 #全局 的规则对所有任务生效；
///  - 带 #保温杯 等标签的规则只在该任务标签命中时注入；
///  - sync_agent_keys 中的 Agent 也能命中同一条规则（跨专员分发）。
/// </summary>
public static class MemoryTagFilter
{
    public static IReadOnlyList<string> Split(string? tags) =>
        (tags ?? string.Empty)
            .Split([' ', ',', '，', ';', '；', '#'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

    public static bool IsGlobal(string? tags)
    {
        var parts = Split(tags);
        return parts.Count == 0
            || parts.All(t => string.Equals(t, "全局", StringComparison.OrdinalIgnoreCase));
    }

    public static bool MatchesTags(IReadOnlyList<string>? scopeTags, string? ruleTags)
    {
        if (IsGlobal(ruleTags))
        {
            return true;
        }
        if (scopeTags is null || scopeTags.Count == 0)
        {
            return false;
        }
        // #全局 表示不限 Agent / 类目；仍保留其它限定标签（如 #微信小店）
        var specific = Split(ruleTags)
            .Where(t => !string.Equals(t, "全局", StringComparison.OrdinalIgnoreCase))
            .ToList();
        return specific.Any(t => scopeTags.Any(s => string.Equals(s, t, StringComparison.OrdinalIgnoreCase)));
    }

    public static bool SharedWith(string? syncAgentKeys, string agentKey) =>
        !string.IsNullOrWhiteSpace(syncAgentKeys)
        && syncAgentKeys
            .Split([',', '，', ';', '；'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Any(k => string.Equals(k, agentKey, StringComparison.OrdinalIgnoreCase));

    public static bool IsExpired(DateTime? expiresAt, DateTime now) =>
        expiresAt is not null && expiresAt <= now;
}

/// <summary>上下文拼装器（纯函数，可单测）：按字符上限截断，保留排序靠前的条目。</summary>
public static class AgentContextComposer
{
    public sealed record MemoryFact(
        long Id, string Subject, string? Metric, string ValueText,
        decimal Confidence, string Status, DateTime UpdatedAt);

    public sealed record KnowledgeDoc(
        long Id, string Title, string? Tags, string Content, DateTime UpdatedAt);

    /// <summary>不应注入的记忆状态（被删除 / 过期 / 被驳回 / 已归档 / 待人工确认）。</summary>
    public static bool IsInjectableStatus(string? status) =>
        !string.Equals(status, "deleted", StringComparison.OrdinalIgnoreCase)
        && !string.Equals(status, "expired", StringComparison.OrdinalIgnoreCase)
        && !string.Equals(status, "rejected", StringComparison.OrdinalIgnoreCase)
        && !string.Equals(status, "archived", StringComparison.OrdinalIgnoreCase)
        && !string.Equals(status, "pending", StringComparison.OrdinalIgnoreCase);

    public static AgentContextBlock Compose(
        IReadOnlyList<MemoryFact> facts,
        IReadOnlyList<KnowledgeDoc> docs,
        int maxMemoryChars,
        int maxKnowledgeChars)
    {
        var memoryLimit = Math.Max(200, maxMemoryChars);
        var knowledgeLimit = Math.Max(200, maxKnowledgeChars);

        var (memoryText, memoryIds, memoryTruncated) = BuildMemory(facts, memoryLimit);
        var (knowledgeText, knowledgeIds, knowledgeTruncated) = BuildKnowledge(docs, knowledgeLimit);

        return new AgentContextBlock(
            memoryText,
            knowledgeText,
            memoryIds,
            knowledgeIds,
            (memoryText?.Length ?? 0) + (knowledgeText?.Length ?? 0),
            memoryTruncated || knowledgeTruncated,
            memoryLimit,
            knowledgeLimit);
    }

    private static (string?, List<long>, bool) BuildMemory(IReadOnlyList<MemoryFact> facts, int limit)
    {
        var sb = new StringBuilder();
        var ids = new List<long>();
        var truncated = false;

        foreach (var fact in facts.Where(f => IsInjectableStatus(f.Status)))
        {
            var metric = string.IsNullOrWhiteSpace(fact.Metric) ? string.Empty : "·" + fact.Metric;
            var line = $"- [{fact.Subject}{metric}] {Trim(fact.ValueText)}（置信度 {fact.Confidence:0.00}，状态 {fact.Status}，{fact.UpdatedAt:yyyy-MM-dd}）";
            if (sb.Length + line.Length + 1 > limit)
            {
                truncated = true;
                break;
            }
            sb.AppendLine(line);
            ids.Add(fact.Id);
        }

        return (sb.Length == 0 ? null : sb.ToString().TrimEnd(), ids, truncated);
    }

    private static (string?, List<long>, bool) BuildKnowledge(IReadOnlyList<KnowledgeDoc> docs, int limit)
    {
        var sb = new StringBuilder();
        var ids = new List<long>();
        var truncated = false;

        foreach (var doc in docs)
        {
            var tags = string.IsNullOrWhiteSpace(doc.Tags) ? string.Empty : $"（标签：{doc.Tags}）";
            var block = $"- {doc.Title}{tags}\n  {Trim(Reflow(doc.Content))}";
            if (sb.Length + block.Length + 2 > limit)
            {
                truncated = true;
                break;
            }
            sb.AppendLine(block);
            ids.Add(doc.Id);
        }

        return (sb.Length == 0 ? null : sb.ToString().TrimEnd(), ids, truncated);
    }

    private static string Trim(string value)
    {
        var text = (value ?? string.Empty).Trim();
        return text.Length <= 400 ? text : text[..400] + "…";
    }

    /// <summary>知识库正文压成单行（注入 system 消息，避免多行挤占上下文）。</summary>
    private static string Reflow(string value) =>
        string.Join(" ", (value ?? string.Empty)
            .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
}
