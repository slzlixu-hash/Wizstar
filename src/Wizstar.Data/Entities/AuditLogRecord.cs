using SqlSugar;

namespace Wizstar.Data.Entities;

/// <summary>统一审计轨迹：Agent 工具调用 / HITL / 流水线动作，供「轨迹日志」界面查询。</summary>
[SugarTable("wiz_audit_log", TableDescription = "Agent 工具与流水线统一审计轨迹")]
public class AuditLogRecord
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnDescription = "自增主键")]
    public long Id { get; set; }

    [SugarColumn(Length = 64, IndexGroupNameList = new[] { "ix_audit_agent" }, ColumnDescription = "Agent Key")]
    public string AgentKey { get; set; } = string.Empty;

    [SugarColumn(Length = 64, IsNullable = true, ColumnDescription = "会话 ID")]
    public string? ConversationId { get; set; }

    [SugarColumn(Length = 64, IsNullable = true, ColumnDescription = "TraceId")]
    public string? TraceId { get; set; }

    [SugarColumn(Length = 64, IsNullable = true, ColumnDescription = "来源服务（builtin / mcp-xxx / pipeline）")]
    public string? ServerId { get; set; }

    [SugarColumn(Length = 128, ColumnDescription = "动作 / 工具名")]
    public string Action { get; set; } = string.Empty;

    [SugarColumn(Length = 16, ColumnDescription = "风险等级 read/write/irreversible")]
    public string RiskLevel { get; set; } = "read";

    [SugarColumn(ColumnDataType = "longtext", IsNullable = true, ColumnDescription = "参数 JSON")]
    public string? ArgumentsJson { get; set; }

    [SugarColumn(ColumnDataType = "longtext", IsNullable = true, ColumnDescription = "结果 JSON（截断）")]
    public string? ResultJson { get; set; }

    [SugarColumn(Length = 32, ColumnDescription = "状态 executed/replayed/pending_approval/error_xxx/budget_exceeded")]
    public string Status { get; set; } = "executed";

    [SugarColumn(IsNullable = true, ColumnDescription = "错误码")]
    public int? ErrorCode { get; set; }

    [SugarColumn(Length = 512, IsNullable = true, ColumnDescription = "错误信息")]
    public string? ErrorMessage { get; set; }

    [SugarColumn(IsNullable = true, ColumnDescription = "耗时 ms")]
    public long? ElapsedMs { get; set; }

    [SugarColumn(Length = 64, IsNullable = true, ColumnDescription = "审批单 ID")]
    public string? ApprovalId { get; set; }

    [SugarColumn(Length = 64, IsNullable = true, ColumnDescription = "工作流配方 ID")]
    public string? PipelineId { get; set; }

    [SugarColumn(Length = 64, IsNullable = true, ColumnDescription = "任务编号")]
    public string? ProjectNo { get; set; }

    [SugarColumn(IndexGroupNameList = new[] { "ix_audit_time" }, ColumnDescription = "创建时间（UTC）")]
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
}
