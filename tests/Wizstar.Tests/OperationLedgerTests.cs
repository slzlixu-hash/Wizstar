using Wizstar.Agents.Ledger;
using Wizstar.Contracts;

namespace Wizstar.Tests;

public class OperationLedgerTests : IDisposable
{
    private readonly string _dbPath;

    public OperationLedgerTests()
    {
        _dbPath = Path.Combine(Path.GetTempPath(), $"wizstar-ledger-{Guid.NewGuid():N}.db");
    }

    public void Dispose()
    {
        try { File.Delete(_dbPath); } catch { /* 临时文件清理失败不阻塞 */ }
    }

    [Fact]
    public async Task MissingOperation_ProbesAsMissing()
    {
        var ledger = CreateLedger();
        var probe = await ledger.ProbeAsync("scope", "op-1", "digest-1");
        Assert.Equal(LedgerProbeKind.Missing, probe.Kind);
    }

    [Fact]
    public async Task SameOperationId_SameArgs_ReplaysStoredResult()
    {
        var ledger = CreateLedger();
        await ledger.MarkExecutingAsync("scope", "op-1", "digest-1");
        await ledger.CompleteAsync("scope", "op-1", true, """{"success":true,"data":{"saved":true}}""");

        var probe = await ledger.ProbeAsync("scope", "op-1", "digest-1");
        Assert.Equal(LedgerProbeKind.Replayed, probe.Kind);
        Assert.Contains("\"saved\":true", probe.ResultJson);

        // 状态已收敛为 SUCCEEDED
        var record = await ledger.GetAsync("scope", "op-1");
        Assert.Equal("SUCCEEDED", record!.Status);
    }

    [Fact]
    public async Task SameOperationId_TamperedArgs_ReturnsTampered()
    {
        var ledger = CreateLedger();
        await ledger.MarkExecutingAsync("scope", "op-1", "digest-1");
        await ledger.CompleteAsync("scope", "op-1", true, "{}");

        var probe = await ledger.ProbeAsync("scope", "op-1", "digest-CHANGED");
        Assert.Equal(LedgerProbeKind.Tampered, probe.Kind);
    }

    [Fact]
    public async Task ScopeIsolation_SameOperationIdAcrossScopes()
    {
        // 账本主键 (scope, operationId)：跨服务操作互不串扰（规范 §4.1）
        var ledger = CreateLedger();
        await ledger.MarkExecutingAsync("serverA", "op-1", "digest-A");
        var probeB = await ledger.ProbeAsync("serverB", "op-1", "digest-B");
        Assert.Equal(LedgerProbeKind.Missing, probeB.Kind);
    }

    [Fact]
    public async Task ListSince_FindsRecentRecords()
    {
        var ledger = CreateLedger();
        await ledger.MarkExecutingAsync("s", "op-1", "d");
        var records = await ledger.ListSinceAsync(DateTimeOffset.UtcNow.AddMinutes(-5));
        Assert.Single(records);
    }

    private OperationLedger CreateLedger() =>
        new(_dbPath, LoggerFactoryHolder.Create<OperationLedger>());
}

public class OperationIdTests
{
    [Fact]
    public void Generate_FollowsSpecFormat()
    {
        var id = OperationId.Generate("mcp-demo", "save_scratch_note", """{"content":"a"}""");
        // op-{yyyyMMdd}-{hash16}
        Assert.Matches(@"^op-\d{8}-[0-9a-f]{16}$", id);
    }

    [Fact]
    public void Generate_IsDeterministicForSameInput()
    {
        var a = OperationId.Generate("mcp-demo", "save_scratch_note", """{"content":"a"}""");
        var b = OperationId.Generate("mcp-demo", "save_scratch_note", """{"content":"a"}""");
        Assert.Equal(a, b);
    }

    [Fact]
    public void Generate_DiffersForDifferentArgs()
    {
        var a = OperationId.Generate("mcp-demo", "save_scratch_note", """{"content":"a"}""");
        var b = OperationId.Generate("mcp-demo", "save_scratch_note", """{"content":"b"}""");
        Assert.NotEqual(a, b);
    }
}
