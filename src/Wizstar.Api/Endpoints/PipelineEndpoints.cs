using System.Text.Json;
using SqlSugar;
using Wizstar.Agents.Audit;
using Wizstar.Api.Pipelines;
using Wizstar.Contracts;
using Wizstar.Data.Entities.Business;

namespace Wizstar.Api.Endpoints;

/// <summary>
/// 工作流配方与流水线推进端点。
///
/// 配方是声明式的（pipelines/*.yaml）：`GET /api/pipelines` 直接返回配置内容与校验问题，
/// 前端据此渲染时间线与面板；推进/审批只操作状态机，不按来源分支。
/// </summary>
public static class PipelineEndpoints
{
    public static void MapPipelineEndpoints(this IEndpointRouteBuilder app)
    {
        var recipes = app.MapGroup("/api/pipelines").WithTags("Pipelines");

        recipes.MapGet("/", (PipelineCatalog catalog, HttpContext context) =>
        {
            var list = catalog.All()
                .Select(r => new
                {
                    pipelineId = r.PipelineId,
                    name = r.Name,
                    triggerSource = r.TriggerSource,
                    description = r.Description,
                    enabled = r.Enabled,
                    stageCount = r.Stages.Count,
                    stages = r.Stages.Select(s => new
                    {
                        code = s.Code,
                        name = s.Name,
                        type = s.Type,
                        agent = s.Agent,
                        skill = s.Skill,
                        mode = s.Mode,
                        panel = s.Panel,
                        autoRule = s.AutoRule,
                        requireHuman = s.RequireHuman,
                        next = s.Next,
                    }),
                })
                .ToList();

            return Results.Ok(ApiEnvelope<object>.Ok(new
            {
                directory = catalog.Directory,
                pipelines = list,
                issues = catalog.Issues,
            }, context.TraceIdentifier));
        });

        recipes.MapGet("/{pipelineId}", (string pipelineId, PipelineCatalog catalog, HttpContext context) =>
        {
            var recipe = catalog.Get(pipelineId);
            return recipe is null
                ? Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"未找到工作流配方: {pipelineId}", context.TraceIdentifier))
                : Results.Ok(ApiEnvelope<object>.Ok(recipe, context.TraceIdentifier));
        });

        /* 编辑器写入：新建 / 更新 / 删除 / 导出 YAML / 预览 / 导入 */
        recipes.MapPost("/", (PipelineRecipe? draft, PipelineStore store, HttpContext context) =>
        {
            if (draft is null)
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, "缺少配方内容", context.TraceIdentifier));
            }
            var saved = store.Create(draft);
            return Results.Ok(ApiEnvelope<object>.Ok(saved, context.TraceIdentifier));
        });

        recipes.MapPut("/{pipelineId}", (string pipelineId, PipelineRecipe? draft, PipelineStore store, HttpContext context) =>
        {
            if (draft is null)
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, "缺少配方内容", context.TraceIdentifier));
            }
            var saved = store.Update(pipelineId, draft);
            return Results.Ok(ApiEnvelope<object>.Ok(saved, context.TraceIdentifier));
        });

        recipes.MapDelete("/{pipelineId}", (string pipelineId, PipelineStore store, HttpContext context) =>
        {
            store.Delete(pipelineId);
            return Results.Ok(ApiEnvelope<object>.Ok(new { pipelineId, deleted = true }, context.TraceIdentifier));
        });

        recipes.MapGet("/{pipelineId}/yaml", (string pipelineId, PipelineStore store, HttpContext context) =>
            Results.Ok(ApiEnvelope<object>.Ok(new { pipelineId, yaml = store.ExportYaml(pipelineId) }, context.TraceIdentifier)));

        recipes.MapPost("/preview", (PipelineRecipe? draft, PipelineStore store, HttpContext context) =>
        {
            if (draft is null)
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, "缺少配方内容", context.TraceIdentifier));
            }
            return Results.Ok(ApiEnvelope<object>.Ok(
                new { yaml = store.Preview(draft) }, context.TraceIdentifier));
        });

        recipes.MapPost("/import", (PipelineImportRequest? request, PipelineStore store, HttpContext context) =>
        {
            var saved = store.Import(request?.Yaml);
            return Results.Ok(ApiEnvelope<object>.Ok(saved, context.TraceIdentifier));
        });

        var project = app.MapGroup("/api/business/products/{projectNo}/pipeline").WithTags("Pipelines");

        project.MapGet("/", (string projectNo, PipelineOrchestrator orchestrator, HttpContext context) =>
            Results.Ok(ApiEnvelope<object>.Ok(orchestrator.GetState(projectNo), context.TraceIdentifier)));

        project.MapPost("/advance", async (
            string projectNo, PipelineOrchestrator orchestrator, IAuditTrail audit,
            HttpContext context, CancellationToken ct) =>
        {
            var state = await orchestrator.AdvanceAsync(projectNo, ct).ConfigureAwait(false);
            await AuditPipelineAsync(audit, "pipeline_advance", projectNo, state,
                new { projectNo }, ct).ConfigureAwait(false);
            return Results.Ok(ApiEnvelope<object>.Ok(state, context.TraceIdentifier));
        });

        project.MapPost("/approve", async (
            string projectNo, PipelineApproveRequest? request,
            PipelineOrchestrator orchestrator, IAuditTrail audit, HttpContext context, CancellationToken ct) =>
        {
            if (request is null)
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, "缺少审批入参", context.TraceIdentifier));
            }
            var state = await orchestrator
                .ApproveAsync(projectNo, request.Approved, request.Note, ct)
                .ConfigureAwait(false);
            await AuditPipelineAsync(audit, "pipeline_approve", projectNo, state,
                new { projectNo, request.Approved, request.Note }, ct).ConfigureAwait(false);
            return Results.Ok(ApiEnvelope<object>.Ok(state, context.TraceIdentifier));
        });

        project.MapPost("/cancel", async (
            string projectNo, PipelineNoteRequest? request,
            PipelineOrchestrator orchestrator, IAuditTrail audit, HttpContext context,
            CancellationToken ct) =>
        {
            var state = orchestrator.Cancel(projectNo, request?.Note);
            await AuditPipelineAsync(audit, "pipeline_cancel", projectNo, state,
                new { projectNo, Note = request?.Note }, ct).ConfigureAwait(false);
            return Results.Ok(ApiEnvelope<object>.Ok(state, context.TraceIdentifier));
        });

        project.MapPost("/complete", async (
            string projectNo, PipelineNoteRequest? request,
            PipelineOrchestrator orchestrator, IAuditTrail audit, HttpContext context, CancellationToken ct) =>
        {
            var state = await orchestrator
                .CompleteCurrentAsync(projectNo, request?.Note, ct)
                .ConfigureAwait(false);
            await AuditPipelineAsync(audit, "pipeline_complete", projectNo, state,
                new { projectNo, Note = request?.Note }, ct).ConfigureAwait(false);
            return Results.Ok(ApiEnvelope<object>.Ok(state, context.TraceIdentifier));
        });

        // 暂停：保留现场并取消当前运行；不删除任何数据。
        project.MapPost("/pause", async (
            string projectNo, PipelineNoteRequest? request,
            PipelineOrchestrator orchestrator, IAuditTrail audit, HttpContext context, CancellationToken ct) =>
        {
            var state = orchestrator.Pause(projectNo, request?.Note);
            await AuditPipelineAsync(audit, "pipeline_pause", projectNo, state,
                new { projectNo, Note = request?.Note }, ct).ConfigureAwait(false);
            return Results.Ok(ApiEnvelope<object>.Ok(state, context.TraceIdentifier));
        });

        // 恢复：回到 pending 后继续推进当前工序。
        project.MapPost("/resume", async (
            string projectNo, PipelineNoteRequest? request,
            PipelineOrchestrator orchestrator, IAuditTrail audit, HttpContext context, CancellationToken ct) =>
        {
            var state = await orchestrator.ResumeAsync(projectNo, request?.Note, ct).ConfigureAwait(false);
            await AuditPipelineAsync(audit, "pipeline_resume", projectNo, state,
                new { projectNo, Note = request?.Note }, ct).ConfigureAwait(false);
            return Results.Ok(ApiEnvelope<object>.Ok(state, context.TraceIdentifier));
        });

        // 归档：终态任务的逻辑软删除（只更新 status=archived，不删历史）。
        project.MapPost("/archive", async (
            string projectNo, ISqlSugarClient db,
            PipelineOrchestrator orchestrator, IAuditTrail audit,
            HttpContext context, CancellationToken ct) =>
        {
            var state = orchestrator.GetState(projectNo);
            var status = string.IsNullOrWhiteSpace(state.StageStatus)
                ? PipelineStageStatus.Pending
                : state.StageStatus.Trim().ToLowerInvariant();
            if (status is not (PipelineStageStatus.Completed or PipelineStageStatus.Cancelled))
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError,
                    "只有已完成或已终止的任务可以归档",
                    context.TraceIdentifier));
            }

            var affected = db.Updateable<SkuProject>()
                .SetColumns(p => p.Status == "archived")
                .SetColumns(p => p.UpdatedAt == DateTime.Now)
                .Where(p => p.ProjectNo == projectNo)
                .ExecuteCommand();
            if (affected == 0)
            {
                return Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"商品不存在: {projectNo}", context.TraceIdentifier));
            }

            await AuditPipelineAsync(audit, "pipeline_archive", projectNo, state,
                new { projectNo, Status = "archived" }, ct).ConfigureAwait(false);
            return Results.Ok(ApiEnvelope<object>.Ok(new { projectNo, archived = true }, context.TraceIdentifier));
        });

        // 彻底删除：仅允许已归档任务；清理项目自有明细，订单等真实业务记录存在时拒绝。
        project.MapDelete("/", async (
            string projectNo, ISqlSugarClient db,
            PipelineOrchestrator orchestrator, IAuditTrail audit,
            HttpContext context, CancellationToken ct) =>
        {
            var project = db.Queryable<SkuProject>().First(p => p.ProjectNo == projectNo);
            if (project is null)
            {
                return Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"商品不存在: {projectNo}", context.TraceIdentifier));
            }
            if (!string.Equals(project.Status, "archived", StringComparison.OrdinalIgnoreCase))
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, "只有已归档任务可以删除", context.TraceIdentifier));
            }

            var orderItems = db.Queryable<EcomOrderItem>().Where(i => i.ProjectId == project.Id).Count();
            if (orderItems > 0)
            {
                return Results.Json(
                    ApiEnvelope<object>.Fail(
                        ErrorCodes.PermissionDenied,
                        $"该任务存在 {orderItems} 条订单明细，不能删除；请保留归档用于审计",
                        context.TraceIdentifier),
                    statusCode: StatusCodes.Status409Conflict);
            }

            var state = orchestrator.GetState(projectNo);
            try
            {
                db.Ado.BeginTran();
                db.Deleteable<SkuVariant>().Where(v => v.ProjectId == project.Id).ExecuteCommand();
                db.Deleteable<SkuChannelListing>().Where(v => v.ProjectId == project.Id).ExecuteCommand();
                db.Deleteable<SkuMedia>().Where(v => v.ProjectId == project.Id).ExecuteCommand();
                db.Deleteable<SkuSourcing>().Where(v => v.ProjectId == project.Id).ExecuteCommand();
                db.Deleteable<SkuPipelineAudit>().Where(v => v.ProjectId == project.Id).ExecuteCommand();
                db.Deleteable<SkuProject>().Where(p => p.Id == project.Id).ExecuteCommand();
                db.Ado.CommitTran();
            }
            catch
            {
                db.Ado.RollbackTran();
                throw;
            }

            await AuditPipelineAsync(audit, "pipeline_delete", projectNo, state,
                new { projectNo, Status = "deleted" }, ct).ConfigureAwait(false);
            return Results.Ok(ApiEnvelope<object>.Ok(new { projectNo, deleted = true }, context.TraceIdentifier));
        });
    }

    private static Task AuditPipelineAsync(
        IAuditTrail audit, string action, string projectNo, PipelineStateView state,
        object arguments, CancellationToken cancellationToken) =>
        audit.RecordAsync(new AuditTrailEntry(
            "commander",
            null,
            projectNo,
            "pipeline",
            action,
            "write",
            JsonSerializer.Serialize(arguments),
            JsonSerializer.Serialize(state),
            "executed",
            null,
            null,
            0,
            null,
            state.PipelineId,
            projectNo), cancellationToken);
}

/// <summary>人工闸口审批入参。</summary>
public sealed record PipelineApproveRequest(bool Approved, string? Note);

/// <summary>人工完成工序入参。</summary>
public sealed record PipelineNoteRequest(string? Note);

/// <summary>导入 YAML 入参。</summary>
public sealed record PipelineImportRequest(string? Yaml);
