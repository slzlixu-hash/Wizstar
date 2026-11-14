using System.Text.Json;
using Wizstar.Agents.Governance;
using Wizstar.Agents.Ledger;
using Wizstar.Agents.Runtime;
using Wizstar.Agents.Tools;
using Wizstar.Contracts;

namespace Wizstar.Tests;

/// <summary>
/// 风险执行策略（IRiskPolicyProvider）与 ToolInvoker 的接线验证。
///
/// 覆盖三件事：
///   ① 默认策略口径：read / write 自动执行，irreversible 强制审批；
///   ② 策略可加严：write 配成「需人工审批」后，调用确实挂起审批单；
///   ③ 治理红线：即使策略层声称 irreversible 可自动执行，ToolInvoker 仍强制审批。
/// </summary>
public class RiskPolicyProviderTests : IDisposable
{
    private readonly string _dbPath =
        Path.Combine(Path.GetTempPath(), "wizstar-risk-" + Guid.NewGuid().ToString("N") + ".db");

    private readonly ILoggerFactory _loggerFactory = LoggerFactory.Create(_ => { });
    private readonly InMemoryApprovalStore _approvals = new();

    public void Dispose()
    {
        _loggerFactory.Dispose();
        foreach (var path in new[] { _dbPath, _dbPath + "-wal", _dbPath + "-shm" })
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (IOException)
            {
                // 临时文件清理失败不影响测试结论
            }
        }
    }

    private static IConfiguration Config() => new ConfigurationBuilder()
        .AddInMemoryCollection(new Dictionary<string, string?> { ["Governance:WriteMode"] = "execute" })
        .Build();

    private static ToolContext Context() => new("commander", "trace-risk-test", "conv-risk-test", false);

    private ToolInvoker CreateInvoker(IRiskPolicyProvider policy)
    {
        var ledger = new OperationLedger(_dbPath, _loggerFactory.CreateLogger<OperationLedger>());
        return new ToolInvoker(_approvals, ledger, Config(), _loggerFactory.CreateLogger<ToolInvoker>(), policy);
    }

    private static RegisteredTool Tool(string name, string? declared = null)
    {
        var provider = new StubProvider();
        var descriptor = new ToolDescriptor("builtin", name, "测试工具", "{}", declared);
        return new RegisteredTool(descriptor, provider, name);
    }

    [Fact]
    public void DefaultProvider_ReadWriteAuto_IrreversibleManual()
    {
        var policy = new DefaultRiskPolicyProvider();
        Assert.True(policy.IsAutoExecute(RiskLevels.Read));
        Assert.True(policy.IsAutoExecute(RiskLevels.Write));
        Assert.False(policy.IsAutoExecute(RiskLevels.Irreversible));
    }

    [Fact]
    public async Task ReadTool_ExecutesDirectly_WhenPolicyAllows()
    {
        var invoker = CreateInvoker(new StubPolicy(read: true, write: true));

        var json = await invoker.InvokeAsync(
            Tool("get_status"), JsonElement.Parse("{}"), Context(), 1, CancellationToken.None);

        Assert.DoesNotContain("approvalRequired", json, StringComparison.Ordinal);
        Assert.Empty(_approvals.List(ApprovalStatus.Pending));
    }

    [Fact]
    public async Task WriteTool_PendsApproval_WhenPolicySaysManual()
    {
        // L2 write 配成「需人工审批」：写操作也必须走 HITL
        var invoker = CreateInvoker(new StubPolicy(read: true, write: false));

        var json = await invoker.InvokeAsync(
            Tool("save_scratch_note"), JsonElement.Parse("""{"note":"x"}"""), Context(), 1, CancellationToken.None);

        Assert.Contains("approvalRequired", json, StringComparison.Ordinal);
        Assert.Single(_approvals.List(ApprovalStatus.Pending));
    }

    [Fact]
    public async Task IrreversibleTool_AlwaysPends_EvenWhenPolicyAllows()
    {
        // 治理红线：策略层即便声称 irreversible 可自动执行，也不能绕过人工审批
        var invoker = CreateInvoker(new StubPolicy(read: true, write: true, irreversible: true));

        var json = await invoker.InvokeAsync(
            Tool("delete_everything"), JsonElement.Parse("{}"), Context(), 1, CancellationToken.None);

        Assert.Contains("approvalRequired", json, StringComparison.Ordinal);
        Assert.Single(_approvals.List(ApprovalStatus.Pending));
    }

    /// <summary>可编排的策略桩：按风险等级返回是否自动执行。</summary>
    private sealed class StubPolicy(bool read, bool write, bool irreversible = false) : IRiskPolicyProvider
    {
        public bool IsAutoExecute(string risk) => risk switch
        {
            RiskLevels.Read => read,
            RiskLevels.Write => write,
            RiskLevels.Irreversible => irreversible,
            _ => false,
        };
    }

    /// <summary>最小工具供给器：永远返回成功信封，用于观察治理层是否落审批。</summary>
    private sealed class StubProvider : IToolProvider
    {
        public IReadOnlyList<ToolDescriptor> ListTools() => [];

        public Task<ToolEnvelope> InvokeAsync(
            ToolDescriptor tool, JsonElement arguments, ToolContext context, CancellationToken cancellationToken)
        {
            var envelope = new ToolEnvelope(
                true,
                JsonSerializer.SerializeToElement(new { executed = true, tool = tool.Name }),
                new ToolUsageInfo("call", 1),
                null,
                new ToolServerInfo("stub", "1.0.0", "1.0", 1),
                context.TraceId,
                false);
            return Task.FromResult(envelope);
        }
    }
}
