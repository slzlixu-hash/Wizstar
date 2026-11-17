using Wizstar.Api.Pipelines;

namespace Wizstar.Tests;

/// <summary>内存版流水线工程存储。</summary>
public sealed class InMemoryPipelineStore : IPipelineProjectStore
{
    private readonly Dictionary<string, PipelineProjectSnapshot> _rows = new(StringComparer.Ordinal);

    public IReadOnlyDictionary<string, PipelineProjectSnapshot> Rows => _rows;

    public PipelineProjectSnapshot? Find(string projectNo) => _rows.GetValueOrDefault(projectNo);

    public void Save(PipelineProjectSnapshot snapshot) => _rows[snapshot.ProjectNo] = snapshot;
}

/// <summary>按 code 命中的假执行器（默认成功）。</summary>
public sealed class FakeStageExecutor(string code, bool success = true, string? failMessage = null) : IPipelineStageExecutor
{
    public string Code { get; } = code;

    public int Calls { get; private set; }

    public Task<StageExecutionResult> ExecuteAsync(PipelineStageContext context, CancellationToken cancellationToken)
    {
        Calls++;
        return Task.FromResult(success
            ? StageExecutionResult.Ok($"{code} 完成")
            : StageExecutionResult.Fail(failMessage ?? "执行失败"));
    }
}

/// <summary>临时配方目录：每个测试独立，结束自动清理。</summary>
public sealed class TempPipelineDir : IDisposable
{
    public string Path { get; }

    public TempPipelineDir()
    {
        Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "wizstar-pipeline-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path);
    }

    public string Write(string fileName, string yaml)
    {
        var file = System.IO.Path.Combine(Path, fileName);
        File.WriteAllText(file, yaml);
        File.SetLastWriteTimeUtc(file, DateTime.UtcNow.AddMilliseconds(10));
        return file;
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(Path, true);
        }
        catch (IOException)
        {
            // 临时目录清理失败不影响断言
        }
    }
}

public static class PipelineTestData
{
    public const string DouyinFlow = """
        pipeline_id: test_douyin
        name: 测试罗盘流
        trigger_source: douyin_compass
        stages:
          - code: scout_ingest
            name: 选品落库
            type: auto
            agent: selection
            skill: compass_fetch_skill
            next: sourcing_1688
          - code: sourcing_1688
            name: 1688 寻源
            type: auto
            agent: sourcing
            skill: sourcing_1688_skill
            next: qualification_gate
          - code: qualification_gate
            name: 资格审核
            type: hitl_gate
            panel: qualification
            auto_rule: "margin_rate >= 0.35"
            require_human: true
            next: publish_online
          - code: publish_online
            name: 正式上架
            type: auto
            agent: publisher
            skill: shop_publish_skill
            mode: direct_publish
            next: null
        """;

    public const string JushuitanFlow = """
        pipeline_id: test_jushuitan
        name: 测试聚水潭流
        trigger_source: jushuitan
        stages:
          - code: scout_ingest
            name: 货盘同步
            type: auto
            agent: selection
            skill: jushuitan_sync_skill
            next: qualification_gate
          - code: qualification_gate
            name: 库存审核
            type: hitl_gate
            panel: qualification
            auto_rule: "stock_quantity >= 50"
            require_human: true
            next: null
        """;
}

public class PipelineCatalogTests
{
    [Fact]
    public void LoadsRecipe_AndResolvesByTriggerSource()
    {
        using var dir = new TempPipelineDir();
        dir.Write("douyin.yaml", PipelineTestData.DouyinFlow);

        var catalog = new PipelineCatalog(dir.Path, LoggerFactoryHolder.Create<PipelineCatalog>());
        var recipe = catalog.Get("test_douyin");

        Assert.NotNull(recipe);
        Assert.Equal("test_douyin", recipe!.PipelineId);
        Assert.Equal(4, recipe.Stages.Count);
        Assert.Equal("sourcing_1688", recipe.FindStage("scout_ingest")!.Next);
        Assert.True(recipe.FindStage("qualification_gate")!.IsHumanGate);
        Assert.Equal("test_douyin", catalog.ResolveBySource("douyin_compass")?.PipelineId);
        Assert.Null(catalog.ResolveBySource("unknown_source"));
        Assert.Empty(catalog.Issues);
    }

    [Fact]
    public void ReportsDanglingNext_AndSkipsRecipe()
    {
        using var dir = new TempPipelineDir();
        dir.Write("broken.yaml", """
            pipeline_id: broken
            name: 悬空
            trigger_source: broken_source
            stages:
              - code: a
                type: auto
                next: not_exists
            """);

        var catalog = new PipelineCatalog(dir.Path, LoggerFactoryHolder.Create<PipelineCatalog>());

        Assert.Null(catalog.Get("broken"));
        Assert.Contains(catalog.Issues, i => i.Level == "error" && i.Message.Contains("next=not_exists"));
    }

    [Fact]
    public void DetectsCycle()
    {
        using var dir = new TempPipelineDir();
        dir.Write("cycle.yaml", """
            pipeline_id: cycle
            name: 环
            trigger_source: cycle_source
            stages:
              - code: a
                type: auto
                next: b
              - code: b
                type: auto
                next: a
            """);

        var catalog = new PipelineCatalog(dir.Path, LoggerFactoryHolder.Create<PipelineCatalog>());

        Assert.Null(catalog.Get("cycle"));
        Assert.Contains(catalog.Issues, i => i.Message.Contains("环形链路"));
    }

    [Fact]
    public void NewSourceNeedsOnlyYaml_NoCodeChange()
    {
        using var dir = new TempPipelineDir();
        dir.Write("douyin.yaml", PipelineTestData.DouyinFlow);
        var catalog = new PipelineCatalog(dir.Path, LoggerFactoryHolder.Create<PipelineCatalog>());
        Assert.Null(catalog.ResolveBySource("jushuitan"));

        // 运行期新增一个来源配方：目录热加载后即可解析，无需改 C#
        dir.Write("jushuitan.yaml", PipelineTestData.JushuitanFlow);

        Assert.Equal("test_jushuitan", catalog.ResolveBySource("jushuitan")?.PipelineId);
    }
}

public class PipelineOrchestratorTests
{
    private static (PipelineOrchestrator orchestrator, InMemoryPipelineStore store) Create(
        params IPipelineStageExecutor[] executors)
    {
        var dir = new TempPipelineDir();
        dir.Write("douyin.yaml", PipelineTestData.DouyinFlow);
        // 目录随测试进程存活：catalog 每次 ReloadIfChanged 会读文件，不能在构造后删除
        var catalog = new PipelineCatalog(dir.Path, LoggerFactoryHolder.Create<PipelineCatalog>());
        var store = new InMemoryPipelineStore();
        store.Save(new PipelineProjectSnapshot(
            "SP-001", "douyin_compass", null, null, null, null));
        return (new PipelineOrchestrator(
            store, catalog, executors, LoggerFactoryHolder.Create<PipelineOrchestrator>()), store);
    }

    [Fact]
    public async Task Advance_InitializesFromSourceAndRunsFirstStage()
    {
        var (orchestrator, store) = Create(new FakeStageExecutor("scout_ingest"));

        var state = await orchestrator.AdvanceAsync("SP-001");

        // 首个执行器成功 → 自动进入下一站；下一站无执行器 → blocked
        Assert.Equal("sourcing_1688", state.CurrentStage);
        Assert.Equal(PipelineStageStatus.Blocked, state.StageStatus);
        Assert.Equal("test_douyin", state.PipelineId);
        Assert.Equal("test_douyin", store.Find("SP-001")!.PipelineId);
        Assert.Equal(2, state.StageIndex);
        Assert.Equal(4, state.StageTotal);
        Assert.Equal(PipelineStageStatus.Completed, state.Stages[0].Status);
    }

    [Fact]
    public async Task Advance_StopsAtHumanGate()
    {
        var (orchestrator, store) = Create(
            new FakeStageExecutor("scout_ingest"),
            new FakeStageExecutor("sourcing_1688"),
            new FakeStageExecutor("publish_online"));

        var state = await orchestrator.AdvanceAsync("SP-001");

        Assert.Equal("qualification_gate", state.CurrentStage);
        Assert.Equal(PipelineStageStatus.WaitingHuman, state.StageStatus);
        Assert.True(state.CanApprove);
        Assert.False(state.Completed);
        Assert.Equal("qualification", state.StagePanel);
        Assert.Equal(PipelineStageStatus.Completed, state.Stages[0].Status);
        Assert.Equal(PipelineStageStatus.Completed, state.Stages[1].Status);
        Assert.Equal(PipelineStageStatus.WaitingHuman, state.Stages[2].Status);
        Assert.Equal("qualification_gate", store.Find("SP-001")!.CurrentStage);
    }

    [Fact]
    public async Task ApproveGate_ContinuesToCompletion()
    {
        var publish = new FakeStageExecutor("publish_online");
        var (orchestrator, _) = Create(
            new FakeStageExecutor("scout_ingest"),
            new FakeStageExecutor("sourcing_1688"),
            publish);

        await orchestrator.AdvanceAsync("SP-001");
        var state = await orchestrator.ApproveAsync("SP-001", true, "毛利达标");

        Assert.True(state.Completed);
        Assert.Equal(PipelineStageStatus.Completed, state.StageStatus);
        Assert.All(state.Stages, s => Assert.Equal(PipelineStageStatus.Completed, s.Status));
        Assert.Equal(1, publish.Calls);
    }

    [Fact]
    public async Task RejectGate_MarksFailed()
    {
        var (orchestrator, _) = Create(
            new FakeStageExecutor("scout_ingest"),
            new FakeStageExecutor("sourcing_1688"));

        await orchestrator.AdvanceAsync("SP-001");
        var state = await orchestrator.ApproveAsync("SP-001", false, "毛利不足");

        Assert.Equal(PipelineStageStatus.Failed, state.StageStatus);
        Assert.Equal("毛利不足", state.StageNote);
        Assert.False(state.Completed);
    }

    [Fact]
    public async Task CompleteManually_UnblocksAndAdvancesToGate()
    {
        var (orchestrator, _) = Create(new FakeStageExecutor("scout_ingest"));

        var blocked = await orchestrator.AdvanceAsync("SP-001");
        Assert.Equal(PipelineStageStatus.Blocked, blocked.StageStatus);

        var state = await orchestrator.CompleteCurrentAsync("SP-001", "线下已寻源");

        // sourcing_1688 人工完成后进入闸口
        Assert.Equal("qualification_gate", state.CurrentStage);
        Assert.Equal(PipelineStageStatus.WaitingHuman, state.StageStatus);
    }

    [Fact]
    public async Task ExecutorFailure_MarksFailedWithoutAdvancing()
    {
        var (orchestrator, _) = Create(new FakeStageExecutor("scout_ingest", success: false, failMessage: "上游 500"));

        var state = await orchestrator.AdvanceAsync("SP-001");

        Assert.Equal("scout_ingest", state.CurrentStage);
        Assert.Equal(PipelineStageStatus.Failed, state.StageStatus);
        Assert.Equal("上游 500", state.StageNote);
    }

    [Fact]
    public void UnconfiguredSource_ReturnsActionableError()
    {
        var (orchestrator, store) = Create();
        store.Save(new PipelineProjectSnapshot("SP-404", "unknown_source", null, null, null, null));

        var state = orchestrator.GetState("SP-404");

        Assert.NotNull(state.Error);
        Assert.Contains("未匹配到工作流配方", state.Error);
        Assert.Empty(state.Stages);
    }

    [Fact]
    public async Task Approve_OnAutoStage_IsRejected()
    {
        var (orchestrator, _) = Create(new FakeStageExecutor("scout_ingest"));

        // 初始在 scout_ingest（自动节点），不能走审批
        var ex = await Assert.ThrowsAsync<Wizstar.Contracts.ApiException>(
            () => orchestrator.ApproveAsync("SP-001", true, null));
        Assert.Contains("不是人工审核闸口", ex.Message);
    }
}

public class PipelineCancelTests
{
    private static (PipelineOrchestrator orchestrator, InMemoryPipelineStore store) Create()
    {
        var dir = new TempPipelineDir();
        dir.Write("douyin.yaml", PipelineTestData.DouyinFlow);
        var catalog = new PipelineCatalog(dir.Path, LoggerFactoryHolder.Create<PipelineCatalog>());
        var store = new InMemoryPipelineStore();
        store.Save(new PipelineProjectSnapshot("SP-C1", "douyin_compass", null, null, null, null));
        return (new PipelineOrchestrator(
            store, catalog, [new FakeStageExecutor("scout_ingest")],
            LoggerFactoryHolder.Create<PipelineOrchestrator>()), store);
    }

    [Fact]
    public void Cancel_MarksCancelledAndStopsAdvance()
    {
        var (orchestrator, store) = Create();

        var state = orchestrator.Cancel("SP-C1", "业务调整，终止");

        Assert.Equal(PipelineStageStatus.Cancelled, state.StageStatus);
        Assert.Equal("业务调整，终止", state.StageNote);
        Assert.False(state.CanAdvance);
        Assert.Equal(PipelineStageStatus.Cancelled, store.Find("SP-C1")!.StageStatus);

        var ex = Assert.ThrowsAsync<Wizstar.Contracts.ApiException>(() => orchestrator.AdvanceAsync("SP-C1")).GetAwaiter().GetResult();
        Assert.Contains("任务已终止", ex.Message);

        var approve = Assert.ThrowsAsync<Wizstar.Contracts.ApiException>(
            () => orchestrator.ApproveAsync("SP-C1", true, null)).GetAwaiter().GetResult();
        Assert.Contains("任务已终止", approve.Message);
    }

    [Fact]
    public void Cancel_CompletedTask_IsRejected()
    {
        var (orchestrator, _) = Create();
        // 手动完成所有阶段到终点需要执行器；这里直接构造一个已完成快照更贴近边界
        var store = new InMemoryPipelineStore();
        var dir = new TempPipelineDir();
        dir.Write("douyin.yaml", PipelineTestData.DouyinFlow);
        var catalog = new PipelineCatalog(dir.Path, LoggerFactoryHolder.Create<PipelineCatalog>());
        store.Save(new PipelineProjectSnapshot(
            "SP-C2", "douyin_compass", "test_douyin", "publish_online", PipelineStageStatus.Completed, "已上架"));
        var orch = new PipelineOrchestrator(
            store, catalog, [], LoggerFactoryHolder.Create<PipelineOrchestrator>());

        var ex = Assert.ThrowsAsync<Wizstar.Contracts.ApiException>(() => Task.FromResult(orch.Cancel("SP-C2", null)))
            .GetAwaiter().GetResult();
        Assert.Contains("已完成", ex.Message);
    }
}

public class PipelinePauseTests
{
    private static (PipelineOrchestrator orchestrator, InMemoryPipelineStore store) Create()
    {
        var dir = new TempPipelineDir();
        dir.Write("douyin.yaml", PipelineTestData.DouyinFlow);
        var catalog = new PipelineCatalog(dir.Path, LoggerFactoryHolder.Create<PipelineCatalog>());
        var store = new InMemoryPipelineStore();
        store.Save(new PipelineProjectSnapshot("SP-P1", "douyin_compass", null, null, null, null));
        return (new PipelineOrchestrator(
            store, catalog, [new FakeStageExecutor("scout_ingest")],
            LoggerFactoryHolder.Create<PipelineOrchestrator>()), store);
    }

    [Fact]
    public async Task Pause_ThenResume_ContinuesFromCurrentStage()
    {
        var (orchestrator, store) = Create();

        var paused = orchestrator.Pause("SP-P1", "午休暂停");
        Assert.Equal(PipelineStageStatus.Paused, paused.StageStatus);
        Assert.False(paused.CanAdvance);
        Assert.Equal(PipelineStageStatus.Paused, store.Find("SP-P1")!.StageStatus);

        var ex = await Assert.ThrowsAsync<Wizstar.Contracts.ApiException>(
            () => orchestrator.AdvanceAsync("SP-P1"));
        Assert.Contains("已暂停", ex.Message);

        var resumed = await orchestrator.ResumeAsync("SP-P1", "继续跑");
        // 首工序成功推进到下一站；下一站无执行器 → blocked
        Assert.Equal("sourcing_1688", resumed.CurrentStage);
        Assert.Equal(PipelineStageStatus.Blocked, resumed.StageStatus);
    }

    [Fact]
    public void Pause_CompletedTask_IsRejected()
    {
        var dir = new TempPipelineDir();
        dir.Write("douyin.yaml", PipelineTestData.DouyinFlow);
        var catalog = new PipelineCatalog(dir.Path, LoggerFactoryHolder.Create<PipelineCatalog>());
        var store = new InMemoryPipelineStore();
        store.Save(new PipelineProjectSnapshot(
            "SP-P2", "douyin_compass", "test_douyin", "publish_online", PipelineStageStatus.Completed, "已上架"));
        var orchestrator = new PipelineOrchestrator(
            store, catalog, [], LoggerFactoryHolder.Create<PipelineOrchestrator>());

        var ex = Assert.Throws<Wizstar.Contracts.ApiException>(() => orchestrator.Pause("SP-P2", null));
        Assert.Contains("已完成", ex.Message);
    }
}

public class PipelineAutoGateTests
{
    private const string AutoGateFlow = """
        pipeline_id: auto_gate
        name: 闸口自动放行
        trigger_source: douyin_compass
        stages:
          - code: scout_ingest
            type: auto
            agent: scout
            next: qualification_gate
          - code: qualification_gate
            type: hitl_gate
            auto_rule: "margin_rate >= 0.35"
            require_human: false
            next: publish_online
          - code: publish_online
            type: auto
            agent: publisher
            next: null
        """;

    [Fact]
    public async Task GateWithoutRequireHuman_AutoPassesToCompletion()
    {
        using var dir = new TempPipelineDir();
        dir.Write("auto.yaml", AutoGateFlow);
        var catalog = new PipelineCatalog(dir.Path, LoggerFactoryHolder.Create<PipelineCatalog>());
        var store = new InMemoryPipelineStore();
        store.Save(new PipelineProjectSnapshot("SP-AUTO", "douyin_compass", null, null, null, null));
        var orchestrator = new PipelineOrchestrator(
            store, catalog,
            [new FakeStageExecutor("scout_ingest"), new FakeStageExecutor("publish_online")],
            LoggerFactoryHolder.Create<PipelineOrchestrator>());

        var state = await orchestrator.AdvanceAsync("SP-AUTO");

        Assert.True(state.Completed);
        Assert.All(state.Stages, s => Assert.Equal(PipelineStageStatus.Completed, s.Status));
        Assert.Equal("auto_gate", state.PipelineId);
    }
}

public class PipelineStoreTests
{
    private static (PipelineStore store, PipelineCatalog catalog, TempPipelineDir dir) Create()
    {
        var dir = new TempPipelineDir();
        dir.Write("seed.yaml", PipelineTestData.DouyinFlow);
        var catalog = new PipelineCatalog(dir.Path, LoggerFactoryHolder.Create<PipelineCatalog>());
        var store = new PipelineStore(catalog, null!, LoggerFactoryHolder.Create<PipelineStore>());
        return (store, catalog, dir);
    }

    [Fact]
    public void Create_WritesYaml_AndRecomputesNextChain()
    {
        var (store, catalog, dir) = Create();
        try
        {
            var saved = store.Create(new PipelineRecipe
            {
                PipelineId = "new_flow",
                Name = "新流",
                TriggerSource = "xiaohongshu",
                Enabled = true,
                Stages =
                [
                    new PipelineStage { Code = "scout_ingest", Name = "选品", Type = "auto", Agent = "scout" },
                    new PipelineStage { Code = "creative_media", Name = "内容", Type = "auto", Agent = "creative" },
                ],
            });

            Assert.Equal("scout_ingest", saved.Stages[0].Code);
            Assert.Equal("creative_media", saved.Stages[0].Next);
            Assert.Null(saved.Stages[1].Next);
            Assert.True(File.Exists(Path.Combine(dir.Path, "new_flow.yaml")));

            var reloaded = catalog.Get("new_flow");
            Assert.NotNull(reloaded);
            Assert.Equal("xiaohongshu", reloaded!.TriggerSource);
            Assert.Equal("xiaohongshu", catalog.ResolveBySource("xiaohongshu")?.TriggerSource);
        }
        finally
        {
            dir.Dispose();
        }
    }

    [Fact]
    public void Create_DuplicateId_IsRejected()
    {
        var (store, _, dir) = Create();
        try
        {
            var ex = Assert.Throws<Wizstar.Contracts.ApiException>(() => store.Create(new PipelineRecipe
            {
                PipelineId = "test_douyin",
                Name = "重复",
                TriggerSource = "other",
                Stages = [new PipelineStage { Code = "a", Type = "auto" }],
            }));
            Assert.Contains("已存在", ex.Message);
        }
        finally
        {
            dir.Dispose();
        }
    }

    [Fact]
    public void Preview_ReturnsSerializedYaml_WithoutWriting()
    {
        var (store, _, dir) = Create();
        try
        {
            var yaml = store.Preview(new PipelineRecipe
            {
                PipelineId = "preview_flow",
                Name = "预览流",
                TriggerSource = "ai_autonomous",
                Stages = [new PipelineStage { Code = "scout_ingest", Name = "选品", Type = "auto" }],
            });

            Assert.Contains("pipeline_id: preview_flow", yaml);
            Assert.Contains("trigger_source: ai_autonomous", yaml);
            Assert.False(File.Exists(Path.Combine(dir.Path, "preview_flow.yaml")));
        }
        finally
        {
            dir.Dispose();
        }
    }

    [Fact]
    public void DisabledRecipe_IsNotResolvedBySource()
    {
        using var dir = new TempPipelineDir();
        dir.Write("off.yaml", """
            pipeline_id: off_flow
            name: 停用流
            trigger_source: xhs
            enabled: false
            stages:
              - code: a
                type: auto
                next: null
            """);
        var catalog = new PipelineCatalog(dir.Path, LoggerFactoryHolder.Create<PipelineCatalog>());

        Assert.NotNull(catalog.Get("off_flow"));
        Assert.Null(catalog.ResolveBySource("xhs"));
    }
}
