using SqlSugar;

namespace Wizstar.Data.Entities;

/// <summary>HITL 审批单持久化记录（CodeFirst）。</summary>
[SugarTable("wiz_approval", TableDescription = "irreversible 工具的审批单")]
public class ApprovalRecord
{
    [SugarColumn(IsPrimaryKey = true, Length = 64, ColumnDescription = "审批单 ID")]
    public string Id { get; set; } = string.Empty;

    [SugarColumn(Length = 64, IndexGroupNameList = new[] { "ix_agent" }, ColumnDescription = "Agent Key")]
    public string AgentKey { get; set; } = string.Empty;

    [SugarColumn(Length = 64, ColumnDescription = "会话 ID")]
    public string ConversationId { get; set; } = string.Empty;

    [SugarColumn(Length = 64, ColumnDescription = "TraceId")]
    public string TraceId { get; set; } = string.Empty;

    [SugarColumn(Length = 128, ColumnDescription = "工具名")]
    public string ToolName { get; set; } = string.Empty;

    [SugarColumn(Length = 16, ColumnDescription = "风险等级 read/write/irreversible")]
    public string RiskLevel { get; set; } = string.Empty;

    [SugarColumn(Length = 64, IndexGroupNameList = new[] { "ix_operation" }, ColumnDescription = "幂等操作 ID")]
    public string OperationId { get; set; } = string.Empty;

    [SugarColumn(ColumnDataType = "longtext", ColumnDescription = "工具参数 JSON")]
    public string ArgumentsJson { get; set; } = "{}";

    /// <summary>0=Pending 1=Approved 2=Rejected</summary>
    [SugarColumn(ColumnDescription = "审批状态 0=待审批 1=已批准 2=已拒绝")]
    public int Status { get; set; }

    [SugarColumn(ColumnDescription = "创建时间（UTC）")]
    public DateTime CreatedAtUtc { get; set; }

    [SugarColumn(IsNullable = true, ColumnDescription = "决策时间（UTC）")]
    public DateTime? DecidedAtUtc { get; set; }

    [SugarColumn(Length = 64, IsNullable = true, ColumnDescription = "决策人")]
    public string? DecidedBy { get; set; }
}
