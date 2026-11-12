using Wizstar.Contracts;

namespace Wizstar.Agents.Tools;

/// <summary>解析后的注册条目：描述符 + 供给器 + 模型可见函数名。</summary>
public sealed record RegisteredTool(ToolDescriptor Descriptor, IToolProvider Provider, string ModelName);

/// <summary>
/// 工具注册表：把所有 IToolProvider 的工具按 Agent 的通配授权清单装配成函数集。
///
/// 硬口径（沿用 v2.0 三条硬口径之一）：单次运行工具数硬上限 8，超限直接拒绝启动，
/// 绝不静默截断——工具太多会撑爆大模型 Context（规范 §3：大模型注意力保护）。
/// </summary>
public sealed class ToolRegistry(IEnumerable<IToolProvider> providers, ILogger<ToolRegistry> logger)
{
    /// <summary>单次运行工具数硬上限。</summary>
    public const int MaxToolsPerRun = 8;

    private readonly IToolProvider[] _providers = providers.ToArray();

    /// <summary>
    /// 按 Agent 授权清单装配工具。授权条目支持 "*"、"serverId.*"、"serverId.tool"。
    /// filter 用于运行时动态过滤（如离线服务剔除、dry-run 场景），返回 false 的工具被剔除。
    /// </summary>
    public IReadOnlyList<RegisteredTool> ResolveForAgent(
        Profiles.AgentProfile agent,
        Func<ToolDescriptor, bool>? filter = null)
    {
        var allTools = new List<(ToolDescriptor Descriptor, IToolProvider Provider)>();
        foreach (var provider in _providers)
        {
            foreach (var tool in provider.ListTools())
            {
                allTools.Add((tool, provider));
            }
        }

        var selected = new List<RegisteredTool>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var (descriptor, provider) in allTools)
        {
            if (filter is not null && !filter(descriptor))
            {
                continue;
            }

            if (!IsAllowed(agent.AllowedTools, descriptor))
            {
                continue;
            }

            var modelName = ModelFunctionName(descriptor.ServerId, descriptor.Name);
            if (!seen.Add(modelName))
            {
                continue;
            }

            // 硬上限：超出直接拒绝启动，不静默截断
            if (selected.Count + 1 > MaxToolsPerRun)
            {
                throw ApiException.Validation(
                    $"Agent {agent.Key} 装配工具数超过硬上限 {MaxToolsPerRun}（当前 {selected.Count + 1}），拒绝启动。" +
                    "请收窄 allowedTools 授权范围");
            }

            selected.Add(new RegisteredTool(descriptor, provider, modelName));
        }

        logger.LogInformation(
            "Agent 工具装配完成: agent={AgentKey} 工具={Count}/{Limit} ({Tools})",
            agent.Key, selected.Count, MaxToolsPerRun,
            string.Join(", ", selected.Select(t => t.ModelName)));

        return selected;
    }

    /// <summary>与模型可见函数名对应的反向查找（tool_call 事件归位用）。</summary>
    public static string ModelFunctionName(string serverId, string toolName) =>
        Sanitize(serverId) + "__" + Sanitize(toolName);

    /// <summary>模型函数名必须是 ^[a-zA-Z0-9_-]{1,64}$（OpenAI 约束）。</summary>
    private static string Sanitize(string value)
    {
        var chars = value.Select(ch =>
            ch is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '-' or '_' ? ch : '-');
        var name = new string(chars.ToArray());
        return name.Length <= 40 ? name : name[..40];
    }

    internal static bool IsAllowed(IReadOnlyList<string> allowed, ToolDescriptor descriptor)
    {
        if (allowed.Count == 0)
        {
            return false; // 未声明授权清单 = 一个工具都不给（最小权限）
        }

        var canonical = descriptor.ServerId + "." + descriptor.Name;
        foreach (var entry in allowed)
        {
            var pattern = (entry ?? string.Empty).Trim();
            if (pattern.Length == 0)
            {
                continue;
            }

            if (pattern == "*")
            {
                return true;
            }

            if (pattern.EndsWith(".*", StringComparison.Ordinal)
                && canonical.StartsWith(pattern[..^1], StringComparison.Ordinal))
            {
                return true;
            }

            if (string.Equals(pattern, canonical, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }
}
