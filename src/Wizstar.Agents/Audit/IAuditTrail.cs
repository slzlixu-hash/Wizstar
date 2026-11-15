namespace Wizstar.Agents.Audit;

/// <summary>一条统一审计轨迹（工具调用 / 流水线动作）。</summary>
public sealed record AuditTrailEntry(
    string AgentKey,
    string? ConversationId,
    string? TraceId,
    string? ServerId,
    string Action,
    string RiskLevel,
    string? ArgumentsJson,
    string? ResultJson,
    string Status,
    int? ErrorCode,
    string? ErrorMessage,
    long? ElapsedMs,
    string? ApprovalId,
    string? PipelineId = null,
    string? ProjectNo = null);

/// <summary>轨迹写侧抽象：生产走 MySQL，失败不得阻断工具/流水线主流程。</summary>
public interface IAuditTrail
{
    Task RecordAsync(AuditTrailEntry entry, CancellationToken cancellationToken = default);
}
