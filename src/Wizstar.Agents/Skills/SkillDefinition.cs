using YamlDotNet.Serialization;

namespace Wizstar.Agents.Skills;

/// <summary>
/// 一个 Skill = 连接大模型与 MCP 工具的“作业指导书”（SOP）：
/// 限定执行 Agent、精确切片的工具清单、SOP Prompt 与运行参数。
/// 落盘为 <c>skills/&lt;code&gt;.yaml</c>，保存后热加载。
/// </summary>
public sealed class SkillDefinition
{
    public string Code { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string? Description { get; set; }

    /// <summary>授权执行 Agent（agents.yaml 的 key）。</summary>
    public string Agent { get; set; } = string.Empty;

    public bool Enabled { get; set; } = true;

    /// <summary>chat：对话调用；auto：自动管线触发。</summary>
    public string TriggerMode { get; set; } = "chat";

    /// <summary>精确挂载的工具：serverId.tool / serverId.* / *。</summary>
    public List<string> AllowedTools { get; set; } = [];

    /// <summary>SOP 核心作业指令，运行时拼进该 Agent 的 System Prompt。</summary>
    public string Prompt { get; set; } = string.Empty;

    public double Temperature { get; set; } = 0.7;

    public int MaxOutputTokens { get; set; } = 2048;

    public int Retry { get; set; } = 2;

    [YamlIgnore]
    [System.Text.Json.Serialization.JsonIgnore]
    public string? SourcePath { get; set; }
}

public sealed record SkillIssue(string Level, string Message);

public static class SkillRules
{
    public static readonly System.Text.RegularExpressions.Regex CodePattern =
        new("^[a-z0-9][a-z0-9-_]{1,63}$", System.Text.RegularExpressions.RegexOptions.Compiled);

    public const string TriggerChat = "chat";
    public const string TriggerAuto = "auto";
    public const string TriggerBoth = "both";

    public static bool IsValidCode(string? code) =>
        !string.IsNullOrWhiteSpace(code) && CodePattern.IsMatch(code.Trim());

    /// <summary>触发模式支持 chat / auto / both（也兼容 chat,auto 写法）。</summary>
    public static IReadOnlyList<string> TriggerModes(string? mode)
    {
        var parts = (mode ?? string.Empty)
            .Split([',', '，', '+', ' ', '|'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(p => p.ToLowerInvariant())
            .ToList();
        var chat = parts.Count == 0 || parts.Contains(TriggerChat) || parts.Contains(TriggerBoth);
        var auto = parts.Contains(TriggerAuto) || parts.Contains(TriggerBoth);
        var modes = new List<string>();
        if (chat) modes.Add(TriggerChat);
        if (auto) modes.Add(TriggerAuto);
        return modes.Count == 0 ? [TriggerChat] : modes;
    }

    public static bool AllowsChat(string? mode) => TriggerModes(mode).Contains(TriggerChat);

    public static bool AllowsAuto(string? mode) => TriggerModes(mode).Contains(TriggerAuto);

    public static string NormalizeTriggerMode(string? mode)
    {
        var modes = TriggerModes(mode);
        if (modes.Count >= 2) return TriggerBoth;
        return modes[0];
    }

    public static SkillDefinition Normalize(SkillDefinition draft) => new()
    {
        Code = (draft.Code ?? string.Empty).Trim(),
        Name = (draft.Name ?? string.Empty).Trim(),
        Description = string.IsNullOrWhiteSpace(draft.Description) ? null : draft.Description.Trim(),
        Agent = (draft.Agent ?? string.Empty).Trim(),
        Enabled = draft.Enabled,
        TriggerMode = NormalizeTriggerMode(draft.TriggerMode),
        AllowedTools = (draft.AllowedTools ?? [])
            .Select(t => (t ?? string.Empty).Trim())
            .Where(t => t.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToList(),
        Prompt = (draft.Prompt ?? string.Empty).Trim(),
        Temperature = Math.Clamp(draft.Temperature, 0d, 2d),
        MaxOutputTokens = Math.Clamp(draft.MaxOutputTokens, 128, 32_000),
        Retry = Math.Clamp(draft.Retry, 0, 5),
        SourcePath = draft.SourcePath,
    };
}
