using SqlSugar;

namespace Wizstar.Data.Entities;

/// <summary>幂等操作账本持久化记录（CodeFirst），复合主键 (Scope, OperationId)。</summary>
[SugarTable("wiz_operation_ledger", TableDescription = "工具调用幂等账本")]
public class OperationRecord
{
    [SugarColumn(IsPrimaryKey = true, Length = 64, ColumnDescription = "作用域（agent:tool）")]
    public string Scope { get; set; } = string.Empty;

    [SugarColumn(IsPrimaryKey = true, Length = 64, ColumnDescription = "幂等操作 ID")]
    public string OperationId { get; set; } = string.Empty;

    [SugarColumn(Length = 64, ColumnDescription = "Agent Key")]
    public string AgentKey { get; set; } = string.Empty;

    [SugarColumn(Length = 128, ColumnDescription = "工具名")]
    public string ToolName { get; set; } = string.Empty;

    [SugarColumn(Length = 64, ColumnDescription = "参数摘要 SHA-256（防篡改比对）")]
    public string ArgumentsDigest { get; set; } = string.Empty;

    [SugarColumn(ColumnDataType = "longtext", ColumnDescription = "工具参数 JSON")]
    public string ArgumentsJson { get; set; } = "{}";

    [SugarColumn(ColumnDataType = "longtext", IsNullable = true, ColumnDescription = "执行结果 JSON")]
    public string? ResultJson { get; set; }

    [SugarColumn(Length = 16, ColumnDescription = "风险等级")]
    public string RiskLevel { get; set; } = string.Empty;

    /// <summary>0=记录待执行 1=已执行（结果可回放）</summary>
    [SugarColumn(ColumnDescription = "状态 0=登记 1=已执行")]
    public int Status { get; set; }

    [SugarColumn(ColumnDescription = "创建时间（UTC）")]
    public DateTime CreatedAtUtc { get; set; }

    [SugarColumn(IsNullable = true, ColumnDescription = "执行完成时间（UTC）")]
    public DateTime? CompletedAtUtc { get; set; }
}
