using SqlSugar;
using Wizstar.Agents.Audit;
using Wizstar.Data.Entities;

namespace Wizstar.Api.Services;

/// <summary>MySQL 审计轨迹写入（wiz_audit_log）；失败只记日志，不阻断工具主流程。</summary>
public sealed class DbAuditTrail(ISqlSugarClient db, ILogger<DbAuditTrail> logger) : IAuditTrail
{
    private const int MaxResultChars = 8000;

    public Task RecordAsync(AuditTrailEntry entry, CancellationToken cancellationToken = default)
    {
        try
        {
            db.Insertable(new AuditLogRecord
            {
                AgentKey = entry.AgentKey ?? string.Empty,
                ConversationId = NullIfEmpty(entry.ConversationId),
                TraceId = NullIfEmpty(entry.TraceId),
                ServerId = NullIfEmpty(entry.ServerId),
                Action = entry.Action ?? string.Empty,
                RiskLevel = entry.RiskLevel ?? "read",
                ArgumentsJson = NullIfEmpty(entry.ArgumentsJson),
                ResultJson = Truncate(entry.ResultJson, MaxResultChars),
                Status = entry.Status ?? "executed",
                ErrorCode = entry.ErrorCode,
                ErrorMessage = Truncate(entry.ErrorMessage, 500),
                ElapsedMs = entry.ElapsedMs,
                ApprovalId = NullIfEmpty(entry.ApprovalId),
                PipelineId = NullIfEmpty(entry.PipelineId),
                ProjectNo = NullIfEmpty(entry.ProjectNo),
                CreatedAtUtc = DateTime.UtcNow,
            }).ExecuteCommand();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "审计轨迹写入失败: agent={Agent} action={Action}", entry.AgentKey, entry.Action);
        }
        return Task.CompletedTask;
    }

    private static string? NullIfEmpty(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static string? Truncate(string? value, int max) =>
        string.IsNullOrEmpty(value) || value.Length <= max ? value : value[..max] + "…";
}
