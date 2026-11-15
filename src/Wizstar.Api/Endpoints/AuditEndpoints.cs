using SqlSugar;
using Wizstar.Agents.Profiles;
using Wizstar.Api.Pipelines;
using Wizstar.Contracts;
using Wizstar.Data.Entities;

namespace Wizstar.Api.Endpoints;

/// <summary>轨迹日志：统一审计表（工具调用 / HITL / 流水线动作）查询与筛选。</summary>
public static class AuditEndpoints
{
    public static void MapAuditEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/audit").WithTags("Audit");

        group.MapGet("/logs", (
            int? sinceHours, string? agent, string? severity, string? pipelineId,
            string? keyword, int? limit,
            ISqlSugarClient db, AgentCatalog agents, PipelineCatalog pipelines,
            HttpContext context) =>
        {
            var query = db.Queryable<AuditLogRecord>();
            if (sinceHours is > 0)
            {
                var since = DateTime.UtcNow.AddHours(-sinceHours.Value);
                query = query.Where(r => r.CreatedAtUtc >= since);
            }

            var rows = query
                .OrderByDescending(r => r.Id)
                .Take(Math.Clamp(limit ?? 300, 1, 1000))
                .ToList();

            if (!string.IsNullOrWhiteSpace(agent))
            {
                rows = rows.Where(r => string.Equals(r.AgentKey, agent.Trim(), StringComparison.OrdinalIgnoreCase)).ToList();
            }
            if (!string.IsNullOrWhiteSpace(pipelineId))
            {
                rows = rows.Where(r => string.Equals(r.PipelineId, pipelineId.Trim(), StringComparison.OrdinalIgnoreCase)).ToList();
            }
            if (!string.IsNullOrWhiteSpace(severity) && !string.Equals(severity, "all", StringComparison.OrdinalIgnoreCase))
            {
                rows = rows.Where(r => SeverityOf(r) == severity.Trim().ToLowerInvariant()).ToList();
            }
            if (!string.IsNullOrWhiteSpace(keyword))
            {
                var kw = keyword.Trim();
                rows = rows.Where(r =>
                    Contains(r.AgentKey, kw) || Contains(r.Action, kw) || Contains(r.ServerId, kw)
                    || Contains(r.ArgumentsJson, kw) || Contains(r.ErrorMessage, kw)
                    || Contains(r.ProjectNo, kw) || Contains(r.PipelineId, kw)).ToList();
            }

            var items = rows.Select(r =>
            {
                var status = StatusMeta(r);
                var pipelineName = pipelines.Get(r.PipelineId)?.Name;
                return new
                {
                    id = r.Id,
                    at = DateTime.SpecifyKind(r.CreatedAtUtc, DateTimeKind.Utc),
                    agentKey = r.AgentKey,
                    agentName = string.Equals(r.AgentKey, "system", StringComparison.OrdinalIgnoreCase)
                        ? "System"
                        : agents.Find(r.AgentKey)?.DisplayName ?? r.AgentKey,
                    serverId = r.ServerId,
                    action = r.Action,
                    riskLevel = r.RiskLevel,
                    argumentsJson = r.ArgumentsJson,
                    resultJson = r.ResultJson,
                    status = r.Status,
                    statusLabel = status.Label,
                    statusTone = status.Tone,
                    severity = SeverityOf(r),
                    errorCode = r.ErrorCode,
                    errorMessage = r.ErrorMessage,
                    elapsedMs = r.ElapsedMs,
                    approvalId = r.ApprovalId,
                    pipelineId = r.PipelineId,
                    pipelineName,
                    projectNo = r.ProjectNo,
                };
            }).ToList();

            return Results.Ok(ApiEnvelope<object>.Ok(items, context.TraceIdentifier));
        });
    }

    private static (string Label, string Tone) StatusMeta(AuditLogRecord row)
    {
        var status = row.Status ?? string.Empty;
        if (string.Equals(status, "pending_approval", StringComparison.OrdinalIgnoreCase))
            return ("Pending / 待审批", "amber");
        if (string.Equals(status, "approved", StringComparison.OrdinalIgnoreCase))
            return ("Approved / 已批准（待执行）", "cyan");
        if (string.Equals(status, "rejected", StringComparison.OrdinalIgnoreCase))
            return ("Rejected / 已驳回", "rose");
        if (string.Equals(status, "budget_exceeded", StringComparison.OrdinalIgnoreCase))
            return ("Blocked / 拦截", "amber");
        if (string.Equals(status, "replayed", StringComparison.OrdinalIgnoreCase))
            return ("Replay / 回放", "cyan");
        if (status.StartsWith("error_", StringComparison.OrdinalIgnoreCase) || string.Equals(status, "failed", StringComparison.OrdinalIgnoreCase))
            return ($"Error / 异常{(row.ErrorCode is null ? string.Empty : " (" + row.ErrorCode + ")")}", "rose");
        if (string.Equals(status, "executed", StringComparison.OrdinalIgnoreCase))
            return ("Success / 成功", "green");
        return (status, "slate");
    }

    private static string SeverityOf(AuditLogRecord row)
    {
        var status = row.Status ?? string.Empty;
        if (status.StartsWith("error_", StringComparison.OrdinalIgnoreCase)
            || string.Equals(status, "failed", StringComparison.OrdinalIgnoreCase))
            return "error";
        if (string.Equals(status, "pending_approval", StringComparison.OrdinalIgnoreCase)
            || string.Equals(status, "budget_exceeded", StringComparison.OrdinalIgnoreCase)
            || string.Equals(status, "approved", StringComparison.OrdinalIgnoreCase)
            || string.Equals(status, "rejected", StringComparison.OrdinalIgnoreCase))
            return "warn";
        return "success";
    }

    private static bool Contains(string? value, string keyword) =>
        !string.IsNullOrEmpty(value) && value.Contains(keyword, StringComparison.OrdinalIgnoreCase);
}
