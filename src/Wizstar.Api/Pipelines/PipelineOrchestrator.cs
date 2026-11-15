using SqlSugar;
using Wizstar.Contracts;
using Wizstar.Data.Entities.Business;

namespace Wizstar.Api.Pipelines;

/// <summary>商品在流水线上的持久化快照（只含状态机需要的字段）。</summary>
public sealed record PipelineProjectSnapshot(
    string ProjectNo,
    string? SelectionSource,
    string? PipelineId,
    string? CurrentStage,
    string? StageStatus,
    string? StageNote);

/// <summary>工序执行结果：成功带备注，失败带可展示原因。</summary>
public sealed record StageExecutionResult(bool Success, string? Note, string? Message)
{
    public static StageExecutionResult Ok(string? note = null) => new(true, note, null);

    public static StageExecutionResult Fail(string message) => new(false, null, message);
}

/// <summary>执行器上下文。</summary>
public sealed record PipelineStageContext(
    string ProjectNo,
    PipelineProjectSnapshot Project,
    PipelineRecipe Recipe,
    PipelineStage Stage);

/// <summary>
/// 工序执行器：按 <see cref="Code"/> 与 YAML 的 stage.code 对应注册。
/// 未注册执行器的自动工序会置 blocked（可人工完成），绝不伪造执行成功。
/// </summary>
public interface IPipelineStageExecutor
{
    string Code { get; }

    Task<StageExecutionResult> ExecuteAsync(PipelineStageContext context, CancellationToken cancellationToken);
}

/// <summary>流水线工程存储抽象（生产走 MySQL，测试可注入内存实现）。</summary>
public interface IPipelineProjectStore
{
    PipelineProjectSnapshot? Find(string projectNo);

    void Save(PipelineProjectSnapshot snapshot);
}

/// <summary>sku_project 的 SqlSugar 实现。</summary>
public sealed class SqlPipelineProjectStore(ISqlSugarClient db) : IPipelineProjectStore
{
    public PipelineProjectSnapshot? Find(string projectNo)
    {
        var row = db.Queryable<SkuProject>().First(p => p.ProjectNo == projectNo);
        return row is null
            ? null
            : new PipelineProjectSnapshot(
                row.ProjectNo, row.SelectionSource, row.PipelineId,
                row.CurrentStage, row.StageStatus, row.StageNote);
    }

    public void Save(PipelineProjectSnapshot snapshot)
    {
        db.Updateable<SkuProject>()
            .SetColumns(p => p.PipelineId == snapshot.PipelineId)
            .SetColumns(p => p.CurrentStage == snapshot.CurrentStage)
            .SetColumns(p => p.StageStatus == snapshot.StageStatus)
            .SetColumns(p => p.StageNote == snapshot.StageNote)
            .SetColumns(p => p.UpdatedAt == DateTime.Now)
            .Where(p => p.ProjectNo == snapshot.ProjectNo)
            .ExecuteCommand();
    }
}

/// <summary>前端渲染色板：工序视图。</summary>
public sealed record PipelineStageView(
    string Code,
    string? Name,
    string Type,
    string? Agent,
    string? Skill,
    string? Mode,
    string? Panel,
    string? AutoRule,
    string? Next,
    string Status);

/// <summary>前端渲染：整条流水线状态。</summary>
public sealed record PipelineStateView(
    string ProjectNo,
    string? PipelineId,
    string? PipelineName,
    string? TriggerSource,
    string? CurrentStage,
    string? CurrentStageName,
    string StageStatus,
    string? StageNote,
    string? StagePanel,
    int StageIndex,
    int StageTotal,
    bool Completed,
    bool CanAdvance,
    bool CanApprove,
    bool CanCompleteManually,
    string? Error,
    IReadOnlyList<PipelineStageView> Stages);

/// <summary>
/// 流水线推进引擎（指挥官）。
///
/// 红线：这里没有任何 `if (source == "douyin") ...` 的来源分支——
/// 来源只用于「按 YAML 的 trigger_source 找配方」，之后一律按配方 next 指针推进。
/// 新增选品渠道 = 新增一个 YAML +（可选）注册工序执行器，本文件不需要改。
/// </summary>
public sealed class PipelineOrchestrator(
    IPipelineProjectStore store,
    PipelineCatalog catalog,
    IEnumerable<IPipelineStageExecutor> executors,
    ILogger<PipelineOrchestrator> logger)
{
    private const string DoneNote = "流水线已完成";

    public PipelineStateView GetState(string projectNo)
    {
        var project = RequireProject(projectNo);
        var recipe = ResolveRecipe(project);
        if (recipe is null)
        {
            return Unconfigured(project);
        }

        var stage = recipe.FindStage(project.CurrentStage) ?? recipe.FirstStage;
        var status = Normalize(project.StageStatus);
        return BuildState(project, recipe, stage, status);
    }

    /// <summary>推进：自动节点找执行器跑，闸口挂起等待人工，完成后自动跳下一站直到停下。</summary>
    public async Task<PipelineStateView> AdvanceAsync(string projectNo, CancellationToken cancellationToken = default)
    {
        var project = RequireProject(projectNo);
        var recipe = ResolveRecipe(project)
            ?? throw ApiException.Validation($"选品来源「{project.SelectionSource}」未配置工作流配方（pipelines/*.yaml）");

        var stage = recipe.FindStage(project.CurrentStage) ?? recipe.FirstStage;
        if (stage is null)
        {
            throw ApiException.Validation($"配方 {recipe.PipelineId} 没有可执行工序");
        }

        var status = Normalize(project.StageStatus);
        if (status == PipelineStageStatus.Cancelled)
        {
            throw ApiException.Validation("任务已终止，无法继续推进；请新建任务后重试");
        }
        var projectNow = project with { PipelineId = recipe.PipelineId };

        // 已完成的上一站：先进入下一站
        if (status == PipelineStageStatus.Completed)
        {
            if (string.IsNullOrWhiteSpace(stage.Next))
            {
                return BuildState(projectNow, recipe, stage, PipelineStageStatus.Completed);
            }
            stage = recipe.FindStage(stage.Next)!;
            status = PipelineStageStatus.Pending;
            projectNow = Persist(projectNow, recipe, stage, status, null);
        }

        for (var guard = 0; guard <= recipe.Stages.Count + 1; guard++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (stage.IsHumanGate)
            {
                if (!stage.RequireHuman)
                {
                    // 闸口关闭「需人工确认」：自动放行，继续下一站
                    projectNow = Persist(projectNow, recipe, stage, PipelineStageStatus.Completed,
                        "闸口未开启人工确认，已自动放行");
                    if (string.IsNullOrWhiteSpace(stage.Next))
                    {
                        return BuildState(projectNow, recipe, stage, PipelineStageStatus.Completed);
                    }
                    stage = recipe.FindStage(stage.Next)!;
                    projectNow = Persist(projectNow, recipe, stage, PipelineStageStatus.Pending, null);
                    continue;
                }

                // 闸口开启人工确认：重置为待审提示并挂起（驳回后重新推进不残留旧意见）
                projectNow = Persist(projectNow, recipe, stage, PipelineStageStatus.WaitingHuman, "等待人工审核");
                return BuildState(projectNow, recipe, stage, PipelineStageStatus.WaitingHuman);
            }

            var executor = FindExecutor(stage.Code);
            if (executor is null)
            {
                var reason = $"工序 {stage.Code} 未接入执行器（agent={stage.Agent ?? "-"}, skill={stage.Skill ?? "-"}），需人工完成后继续";
                projectNow = Persist(projectNow, recipe, stage, PipelineStageStatus.Blocked, reason);
                logger.LogInformation("流水线阻塞: {Project} stage={Stage} 原因={Reason}", projectNo, stage.Code, reason);
                return BuildState(projectNow, recipe, stage, PipelineStageStatus.Blocked);
            }

            projectNow = Persist(projectNow, recipe, stage, PipelineStageStatus.Running, null);
            StageExecutionResult result;
            try
            {
                result = await executor.ExecuteAsync(
                    new PipelineStageContext(projectNo, projectNow, recipe, stage), cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "流水线工序执行异常: {Project} stage={Stage}", projectNo, stage.Code);
                projectNow = Persist(projectNow, recipe, stage, PipelineStageStatus.Failed, ex.Message);
                return BuildState(projectNow, recipe, stage, PipelineStageStatus.Failed);
            }

            if (!result.Success)
            {
                projectNow = Persist(projectNow, recipe, stage, PipelineStageStatus.Failed, result.Message ?? "执行失败");
                return BuildState(projectNow, recipe, stage, PipelineStageStatus.Failed);
            }

            projectNow = Persist(projectNow, recipe, stage, PipelineStageStatus.Completed, result.Note);

            if (string.IsNullOrWhiteSpace(stage.Next))
            {
                logger.LogInformation("流水线完成: {Project} pipeline={Pipeline}", projectNo, recipe.PipelineId);
                return BuildState(projectNow, recipe, stage, PipelineStageStatus.Completed);
            }

            stage = recipe.FindStage(stage.Next)!;
            projectNow = Persist(projectNow, recipe, stage, PipelineStageStatus.Pending, null);
        }

        throw ApiException.Internal($"流水线推进超过最大步数（{recipe.Stages.Count}），疑似配方存在环");
    }

    /// <summary>人工闸口审批：通过则标记完成并继续推进；驳回置 failed（可再次审批）。</summary>
    public async Task<PipelineStateView> ApproveAsync(
        string projectNo, bool approved, string? note, CancellationToken cancellationToken = default)
    {
        var project = RequireProject(projectNo);
        var recipe = ResolveRecipe(project)
            ?? throw ApiException.Validation($"选品来源「{project.SelectionSource}」未配置工作流配方（pipelines/*.yaml）");

        var stage = recipe.FindStage(project.CurrentStage) ?? recipe.FirstStage;
        if (stage is null)
        {
            throw ApiException.Validation($"配方 {recipe.PipelineId} 没有可执行工序");
        }
        if (Normalize(project.StageStatus) == PipelineStageStatus.Cancelled)
        {
            throw ApiException.Validation("任务已终止，无法审批；请新建任务后重试");
        }
        if (!stage.IsHumanGate)
        {
            throw ApiException.Validation("当前工序不是人工审核闸口，无需审批");
        }
        if (Normalize(project.StageStatus) != PipelineStageStatus.WaitingHuman)
        {
            throw ApiException.Validation("当前工序不在待审核状态");
        }

        var projectNow = project with { PipelineId = recipe.PipelineId };
        if (!approved)
        {
            var reason = string.IsNullOrWhiteSpace(note) ? "人工驳回" : note!.Trim();
            projectNow = Persist(projectNow, recipe, stage, PipelineStageStatus.Failed, reason);
            logger.LogInformation("人工驳回: {Project} stage={Stage} 原因={Reason}", projectNo, stage.Code, reason);
            return BuildState(projectNow, recipe, stage, PipelineStageStatus.Failed);
        }

        projectNow = Persist(projectNow, recipe, stage, PipelineStageStatus.Completed,
            string.IsNullOrWhiteSpace(note) ? "人工审核通过" : note!.Trim());

        // 闸口通过后自动进入下一站（下一站的自动/闸口语义由配方决定）
        return await AdvanceAsync(projectNo, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>人工完成当前自动工序（执行器未接线 / 线下已处理），完成后自动推进。</summary>
    public async Task<PipelineStateView> CompleteCurrentAsync(
        string projectNo, string? note, CancellationToken cancellationToken = default)
    {
        var project = RequireProject(projectNo);
        var recipe = ResolveRecipe(project)
            ?? throw ApiException.Validation($"选品来源「{project.SelectionSource}」未配置工作流配方（pipelines/*.yaml）");

        var stage = recipe.FindStage(project.CurrentStage) ?? recipe.FirstStage;
        if (stage is null)
        {
            throw ApiException.Validation($"配方 {recipe.PipelineId} 没有可执行工序");
        }
        if (Normalize(project.StageStatus) == PipelineStageStatus.Cancelled)
        {
            throw ApiException.Validation("任务已终止，无法标记完成；请新建任务后重试");
        }
        if (stage.IsHumanGate)
        {
            throw ApiException.Validation("人工闸口请使用审批接口（通过/驳回），不能直接标记完成");
        }

        var projectNow = project with { PipelineId = recipe.PipelineId };
        projectNow = Persist(projectNow, recipe, stage, PipelineStageStatus.Completed,
            string.IsNullOrWhiteSpace(note) ? "人工标记完成" : note!.Trim());

        return await AdvanceAsync(projectNo, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>人工终止任务：当前工序置 cancelled，后续推进/审批一律拒绝。</summary>
    public PipelineStateView Cancel(string projectNo, string? note)
    {
        var project = RequireProject(projectNo);
        var recipe = ResolveRecipe(project)
            ?? throw ApiException.Validation($"选品来源「{project.SelectionSource}」未配置工作流配方（pipelines/*.yaml）");

        var stage = recipe.FindStage(project.CurrentStage) ?? recipe.FirstStage;
        if (stage is null)
        {
            throw ApiException.Validation($"配方 {recipe.PipelineId} 没有可执行工序");
        }
        var status = Normalize(project.StageStatus);
        if (status == PipelineStageStatus.Completed)
        {
            throw ApiException.Validation("任务已完成，无需终止");
        }
        if (status == PipelineStageStatus.Cancelled)
        {
            throw ApiException.Validation("任务已终止");
        }

        var projectNow = Persist(project with { PipelineId = recipe.PipelineId }, recipe, stage,
            PipelineStageStatus.Cancelled, string.IsNullOrWhiteSpace(note) ? "人工终止" : note!.Trim());
        logger.LogInformation("任务已终止: {Project} stage={Stage} note={Note}", projectNo, stage.Code, projectNow.StageNote);
        return BuildState(projectNow, recipe, stage, PipelineStageStatus.Cancelled);
    }

    // ---------------------------------------------------------------- 内部

    private PipelineProjectSnapshot RequireProject(string projectNo)
    {
        if (string.IsNullOrWhiteSpace(projectNo))
        {
            throw ApiException.Validation("projectNo 不能为空");
        }
        return store.Find(projectNo.Trim())
            ?? throw ApiException.Validation($"商品不存在: {projectNo}");
    }

    /// <summary>先按已绑定配方，再按来源映射（都由 YAML 声明），不做来源硬编码。</summary>
    private PipelineRecipe? ResolveRecipe(PipelineProjectSnapshot project) =>
        catalog.Get(project.PipelineId) ?? catalog.ResolveBySource(project.SelectionSource);

    private IPipelineStageExecutor? FindExecutor(string code) =>
        executors.FirstOrDefault(e => string.Equals(e.Code, code, StringComparison.OrdinalIgnoreCase));

    /// <summary>写库并返回最新快照：状态视图必须用返回值，不能再用旧快照，否则 note/status 会滞后。</summary>
    private PipelineProjectSnapshot Persist(
        PipelineProjectSnapshot project, PipelineRecipe recipe, PipelineStage stage, string status, string? note)
    {
        var updated = project with
        {
            PipelineId = recipe.PipelineId,
            CurrentStage = stage.Code,
            StageStatus = status,
            StageNote = note,
        };
        store.Save(updated);
        return updated;
    }

    private static string Normalize(string? status) =>
        string.IsNullOrWhiteSpace(status) ? PipelineStageStatus.Pending : status!.Trim();

    private static PipelineStateView Unconfigured(PipelineProjectSnapshot project) => new(
        project.ProjectNo,
        project.PipelineId,
        null,
        project.SelectionSource,
        project.CurrentStage,
        null,
        Normalize(project.StageStatus),
        project.StageNote,
        null,
        0,
        0,
        false,
        false,
        false,
        false,
        $"选品来源「{project.SelectionSource ?? "未设置"}」未匹配到工作流配方：请在 pipelines/ 下新增 YAML 并声明 trigger_source",
        []);

    private static PipelineStateView BuildState(
        PipelineProjectSnapshot project, PipelineRecipe recipe, PipelineStage stage, string status)
    {
        var index = recipe.IndexOf(stage.Code);
        var completed = string.Equals(status, PipelineStageStatus.Completed)
                        && string.IsNullOrWhiteSpace(stage.Next);

        var stages = recipe.Stages
            .Select((s, i) => new PipelineStageView(
                s.Code, s.Name, s.Type, s.Agent, s.Skill, s.Mode, s.Panel, s.AutoRule, s.Next,
                i < index ? PipelineStageStatus.Completed
                    : i == index ? status
                    : PipelineStageStatus.Pending))
            .ToList();

        return new PipelineStateView(
            project.ProjectNo,
            recipe.PipelineId,
            recipe.Name,
            recipe.TriggerSource,
            stage.Code,
            stage.Name ?? stage.Code,
            status,
            project.StageNote,
            stage.Panel,
            index + 1,
            recipe.Stages.Count,
            completed,
            !completed && !string.Equals(status, PipelineStageStatus.Cancelled),
            stage.IsHumanGate && string.Equals(status, PipelineStageStatus.WaitingHuman),
            !stage.IsHumanGate
                && status is PipelineStageStatus.Pending or PipelineStageStatus.Blocked or PipelineStageStatus.Failed,
            null,
            stages);
    }
}
