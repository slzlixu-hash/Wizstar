using System.Text.Json;
using Wizstar.Agents.Tools;

namespace Wizstar.Agents.Governance;

/// <summary>
/// 风险分级判定（规范 §3.2 + §7 Checklist）：
///  ① 优先读服务端显式声明的 x-risk；
///  ② 动词兜底推断（read / write / irreversible 三级前缀表）；
///  ③ 未知动词默认 write（宁可多审，不可漏审）；
///  ④ 显式声明与动词推断取「更严重」的一档（x-risk 只升不降）。
/// </summary>
public static class RiskLevels
{
    public const string Read = "read";
    public const string Write = "write";
    public const string Irreversible = "irreversible";
}

public static class RiskClassifier
{
    /// <summary>产生财务、法律或不可逆公开影响：强制 HITL 审批。</summary>
    private static readonly string[] IrreversiblePrefixes =
        ["publish_", "pay_", "delete_", "refund_", "withdraw_", "cancel_"];

    /// <summary>改变外部状态但可逆 / 低风险。</summary>
    private static readonly string[] WritePrefixes =
        ["create_", "update_", "save_", "sync_", "submit_", "import_"];

    /// <summary>只读无副作用：直接放行，免审批。</summary>
    private static readonly string[] ReadPrefixes =
        ["get_", "query_", "search_", "list_", "fetch_", "count_", "meta."];

    /// <summary>严重度排序，用于「只升不降」合并。</summary>
    private static int Severity(string risk) => risk switch
    {
        RiskLevels.Read => 0,
        RiskLevels.Write => 1,
        RiskLevels.Irreversible => 2,
        _ => 1
    };

    /// <summary>
    /// 判定工具风险等级。declaredRisk 为服务端 x-risk（可空，未声明时完全依赖动词推断）。
    /// </summary>
    public static string Classify(ToolDescriptor tool, string? declaredRisk = null)
    {
        var declared = declaredRisk ?? tool.DeclaredRisk;
        var inferred = InferByVerb(tool.Name);

        if (string.IsNullOrWhiteSpace(declared))
        {
            return inferred;
        }

        // x-risk 只升不降：显式声明与动词推断取「更严重」的一档
        var normalized = Normalize(declared);
        return Severity(normalized) >= Severity(inferred) ? normalized : inferred;
    }

    /// <summary>x-risk 归一化：未知值按 write 处理（不信任声明，也不放行）。</summary>
    private static string Normalize(string? risk) => risk?.Trim().ToLowerInvariant() switch
    {
        RiskLevels.Read => RiskLevels.Read,
        RiskLevels.Write => RiskLevels.Write,
        RiskLevels.Irreversible => RiskLevels.Irreversible,
        _ => RiskLevels.Write
    };

    private static string InferByVerb(string toolName)
    {
        var name = (toolName ?? string.Empty).Trim().ToLowerInvariant();

        foreach (var prefix in IrreversiblePrefixes)
        {
            if (name.StartsWith(prefix, StringComparison.Ordinal))
            {
                return RiskLevels.Irreversible;
            }
        }

        foreach (var prefix in WritePrefixes)
        {
            if (name.StartsWith(prefix, StringComparison.Ordinal))
            {
                return RiskLevels.Write;
            }
        }

        foreach (var prefix in ReadPrefixes)
        {
            if (name.StartsWith(prefix, StringComparison.Ordinal))
            {
                return RiskLevels.Read;
            }
        }

        // 未知动词默认 write（宁可多审，不可漏审）
        return RiskLevels.Write;
    }

    /// <summary>风险是否需要 HITL 审批（仅 irreversible 强制挂起）。</summary>
    public static bool RequiresApproval(string risk) =>
        string.Equals(risk, RiskLevels.Irreversible, StringComparison.Ordinal);

    /// <summary>风险是否涉及副作用（写操作需要幂等账本保护）。</summary>
    public static bool IsMutating(string risk) => !string.Equals(risk, RiskLevels.Read, StringComparison.Ordinal);

    /// <summary>演示/测试辅助：把 risk 转成信封里的可读文案。</summary>
    public static string Describe(string risk) => risk switch
    {
        RiskLevels.Read => "只读（免审批）",
        RiskLevels.Write => "写操作（可逆）",
        RiskLevels.Irreversible => "不可逆（强制人工审批）",
        _ => risk
    };
}

/// <summary>演示工具/测试用的最小 schema 解析。</summary>
public static class ToolSchemaUtil
{
    private static readonly JsonElement EmptySchema =
        JsonElement.Parse("""{"type":"object","properties":{}}""");

    public static JsonElement ParseSchema(string? inputSchemaJson)
    {
        if (string.IsNullOrWhiteSpace(inputSchemaJson))
        {
            return EmptySchema;
        }

        try
        {
            using var document = JsonDocument.Parse(inputSchemaJson);
            return document.RootElement.ValueKind == JsonValueKind.Object
                ? document.RootElement.Clone()
                : EmptySchema;
        }
        catch (JsonException)
        {
            return EmptySchema;
        }
    }
}
