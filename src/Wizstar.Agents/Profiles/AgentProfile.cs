namespace Wizstar.Agents.Profiles;

/// <summary>
/// Agent 名册条目：人设由后端固化，请求体注入不了 SystemPrompt。
/// AllowedTools 为通配授权清单（规范：即插即用 Step 2）：
///   "*"            → 全量工具；
///   "serverId.*"   → 某个 MCP 服务的全部工具；
///   "serverId.tool"→ 精确授权单个工具。
/// </summary>
public sealed record AgentProfile(
    string Key,
    string Name,
    string DisplayName,
    string Description,
    string SystemPrompt,
    IReadOnlyList<string> AllowedTools,
    int MaxSteps,
    bool Enabled);

/// <summary>agents.yaml 的反序列化模型（camelCase 字段，均带默认值）。</summary>
public sealed class AgentEntry
{
    public string Key { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string SystemPrompt { get; set; } = string.Empty;
    public List<string>? AllowedTools { get; set; }
    public int MaxSteps { get; set; } = 8;
    public bool Enabled { get; set; } = true;
}

public sealed class AgentFile
{
    public List<AgentEntry> Agents { get; set; } = [];
}
