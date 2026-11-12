using System.Text.Json;
using Microsoft.Extensions.AI;
using Wizstar.Agents.Governance;
using Wizstar.Agents.Ledger;
using Wizstar.Agents.Profiles;
using Wizstar.Agents.Runtime;
using Wizstar.Agents.Tools;
using Wizstar.Contracts;

namespace Wizstar.Tests;

/// <summary>
/// 脚本化 ChatClient：按脚本逐轮返回 ChatResponse——
/// 离线验证 FunctionInvokingChatClient 工具回路全链路（不需要真实 LLM）。
/// </summary>
public sealed class ScriptedChatClient(IReadOnlyList<Func<ChatResponse>> script) : IChatClient
{
    private int _index;

    public Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
    {
        var step = Math.Min(Interlocked.Increment(ref _index) - 1, script.Count - 1);
        return Task.FromResult(script[step]());
    }

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages, ChatOptions? options = null,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var response = await GetResponseAsync(messages, options, cancellationToken).ConfigureAwait(false);
        foreach (var message in response.Messages)
        {
            yield return new ChatResponseUpdate(message.Role, message.Contents);
        }
    }

    public object? GetService(Type serviceType, object? serviceKey = null) =>
        serviceType.IsInstanceOfType(this) ? this : null;

    public void Dispose() { }
}

public class AgentRunnerTests : IDisposable
{
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"wizstar-runner-{Guid.NewGuid():N}.db");
    private readonly List<string> _tempFiles = [];

    public void Dispose()
    {
        foreach (var file in _tempFiles)
        {
            try { File.Delete(file); } catch { }
        }
        try { File.Delete(_dbPath); } catch { }
    }

    private static AgentProfile Profile(string key = "agent", int maxSteps = 8) =>
        new(key, key, "测试 Agent", "测试", "你是测试 Agent。", ["*"], maxSteps, true);

    private static string BuildYaml(AgentProfile profile) => $"""
        agents:
          - key: {profile.Key}
            name: {profile.Name}
            displayName: {profile.DisplayName}
            description: 测试
            systemPrompt: |
              {profile.SystemPrompt}
            allowedTools:
              - "*"
            maxSteps: {profile.MaxSteps}
        """;

    private (AgentRunner Runner, InMemoryApprovalStore Approvals) BuildRunner(
        IChatClient chatClient, AgentProfile profile)
    {
        var loggerFactory = LoggerFactoryHolder.CreateFactory();

        var yamlPath = Path.Combine(Path.GetTempPath(), $"wizstar-run-agents-{Guid.NewGuid():N}.yaml");
        File.WriteAllText(yamlPath, BuildYaml(profile));
        _tempFiles.Add(yamlPath);
        var catalog = new AgentCatalog(yamlPath, loggerFactory.CreateLogger<AgentCatalog>());

        var approvals = new InMemoryApprovalStore();
        var ledger = new OperationLedger(_dbPath, loggerFactory.CreateLogger<OperationLedger>());
        var registry = new ToolRegistry([new BuiltinToolsProvider()], loggerFactory.CreateLogger<ToolRegistry>());
        var invoker = new ToolInvoker(
            approvals, ledger, ConfigHolder.Build("execute"), loggerFactory.CreateLogger<ToolInvoker>());
        var chatProvider = new ChatClientProvider(
            new HttpClientFactoryHolder(), ConfigHolder.Build("execute"),
            loggerFactory.CreateLogger<ChatClientProvider>(), chatClient);
        var runner = new AgentRunner(
            catalog, registry, invoker, chatProvider, new ConversationStore(),
            loggerFactory, loggerFactory.CreateLogger<AgentRunner>());
        return (runner, approvals);
    }

    [Fact]
    public async Task OfflineRun_WithoutToolCalls_ReturnsCompleted()
    {
        var chat = new ScriptedChatClient([
            () => new ChatResponse(new ChatMessage(ChatRole.Assistant, "直接回答，不调用工具。"))
        ]);
        var (runner, _) = BuildRunner(chat, Profile());

        var result = await runner.RunAsync(new AgentRunOptions("agent", "conv-1", "你好"));

        Assert.Equal("completed", result.Status);
        Assert.Contains("直接回答", result.Output);
        Assert.Empty(result.Trace);
    }

    [Fact]
    public async Task ReadTool_ExecutesDirectly_WithoutApproval()
    {
        var chat = new ScriptedChatClient([
            () => MakeToolCall("builtin__get_workspace_status"),
            () => new ChatResponse(new ChatMessage(ChatRole.Assistant, "状态查询完成。"))
        ]);
        var (runner, approvals) = BuildRunner(chat, Profile());

        var result = await runner.RunAsync(new AgentRunOptions("agent", "conv-1", "看下状态"));

        Assert.Equal("completed", result.Status);
        var trace = Assert.Single(result.Trace);
        Assert.Equal("read", trace.Risk);
        Assert.Equal("executed", trace.Status);
        Assert.Null(trace.ApprovalId);
        Assert.False(trace.Replayed);
        Assert.Empty(approvals.List());
    }

    [Fact]
    public async Task IrreversibleTool_SuspendsForApproval_AndExecutesAfterApproval()
    {
        var chat = new ScriptedChatClient([
            () => MakeToolCall("builtin__publish_announcement", """{"title":"测试公告","body":"正文"}"""),
            () => new ChatResponse(new ChatMessage(ChatRole.Assistant, "第一次：返回待审批。")),
            () => MakeToolCall("builtin__publish_announcement", """{"title":"测试公告","body":"正文"}"""),
            () => new ChatResponse(new ChatMessage(ChatRole.Assistant, "第二次：审批已通过并执行。"))
        ]);
        var (runner, approvals) = BuildRunner(chat, Profile());

        // 第一次调用：挂起审批，不执行
        var first = await runner.RunAsync(new AgentRunOptions("agent", "conv-hitl", "发布公告"));
        var firstTrace = Assert.Single(first.Trace);
        Assert.Equal("pending_approval", firstTrace.Status);
        Assert.NotNull(firstTrace.ApprovalId);
        Assert.Single(first.PendingApprovalIds);

        // 服务端从不自动批准；人工批准
        var decided = approvals.Decide(firstTrace.ApprovalId!.Value, ApprovalStatus.Approved, "批准");
        Assert.NotNull(decided);
        Assert.Equal(ApprovalStatus.Approved, decided!.Status);

        // 第二次相同入参调用：审批已通过 → 真正执行
        var second = await runner.RunAsync(new AgentRunOptions("agent", "conv-hitl", "发布公告（已批）"));
        var secondTrace = Assert.Single(second.Trace);
        Assert.Equal("executed", secondTrace.Status);
        Assert.False(secondTrace.Replayed);
    }

    [Fact]
    public async Task RejectedApproval_ReturnsBusinessRejected()
    {
        var chat = new ScriptedChatClient([
            () => MakeToolCall("builtin__publish_announcement", """{"title":"x","body":"y"}"""),
            () => new ChatResponse(new ChatMessage(ChatRole.Assistant, "等待审批。")),
            () => MakeToolCall("builtin__publish_announcement", """{"title":"x","body":"y"}"""),
            () => new ChatResponse(new ChatMessage(ChatRole.Assistant, "审批被拒。"))
        ]);
        var (runner, approvals) = BuildRunner(chat, Profile());

        var first = await runner.RunAsync(new AgentRunOptions("agent", "conv-reject", "发布公告"));
        var approvalId = first.Trace[0].ApprovalId!.Value;
        approvals.Decide(approvalId, ApprovalStatus.Rejected, "拒绝");

        var second = await runner.RunAsync(new AgentRunOptions("agent", "conv-reject", "再试一次"));
        Assert.Equal($"error_{ErrorCodes.BusinessRejected}", second.Trace[0].Status);
    }

    [Fact]
    public async Task SameArgsTwice_SecondCallReplays_FromLedger()
    {
        // 写操作 + 相同入参：第二次必须回放（replayed: true），不二次执行
        var chat = new ScriptedChatClient([
            () => MakeToolCall("builtin__save_scratch_note", """{"content":"同一句话"}"""),
            () => new ChatResponse(new ChatMessage(ChatRole.Assistant, "第一次已保存。")),
            () => MakeToolCall("builtin__save_scratch_note", """{"content":"同一句话"}"""),
            () => new ChatResponse(new ChatMessage(ChatRole.Assistant, "第二次是回放。"))
        ]);
        var (runner, _) = BuildRunner(chat, Profile());

        var first = await runner.RunAsync(new AgentRunOptions("agent", "conv-idem", "存便签"));
        Assert.Equal("executed", first.Trace[0].Status);

        var second = await runner.RunAsync(new AgentRunOptions("agent", "conv-idem", "再存一次"));
        Assert.True(second.Trace[0].Replayed);
    }

    [Fact]
    public async Task UnknownAgent_ThrowsValidation()
    {
        var chat = new ScriptedChatClient([() => new ChatResponse(new ChatMessage(ChatRole.Assistant, "ok"))]);
        var (runner, _) = BuildRunner(chat, Profile("someone-else"));

        await Assert.ThrowsAsync<ApiException>(() =>
            runner.RunAsync(new AgentRunOptions("agent", "conv", "你好")));
    }

    [Fact]
    public async Task ToolLimit_ReachMaxSteps_ReportsMaxSteps()
    {
        // 步数预算 2：脚本让模型持续调工具 → 收敛为 max_steps
        var profile = Profile(maxSteps: 2);
        var script = new List<Func<ChatResponse>>();
        for (var i = 0; i < 8; i++)
        {
            script.Add(() => MakeToolCall("builtin__get_workspace_status"));
        }
        var chat = new ScriptedChatClient(script);
        var (runner, _) = BuildRunner(chat, profile);

        var result = await runner.RunAsync(new AgentRunOptions("agent", "conv-max", "刷步数"));

        Assert.Equal("max_steps", result.Status);
        Assert.True(result.Trace.Count <= profile.MaxSteps + 2);
    }

    // ---------------------------------------------------------------- 辅助

    private static ChatResponse MakeToolCall(string functionName, string argsJson = "{}")
    {
        using var document = JsonDocument.Parse(argsJson);
        var arguments = new Dictionary<string, object?>();
        foreach (var property in document.RootElement.EnumerateObject())
        {
            arguments[property.Name] = property.Value.Clone();
        }

        return new ChatResponse(new ChatMessage(ChatRole.Assistant,
            [new FunctionCallContent($"call-{Guid.NewGuid():N}", functionName, arguments)]));
    }

    private sealed class ConfigHolder
    {
        public static IConfiguration Build(string writeMode) => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Governance:WriteMode"] = writeMode
            })
            .Build();
    }

    /// <summary>测试用 IHttpClientFactory 桩（脚本模式不发起 HTTP）。</summary>
    private sealed class HttpClientFactoryHolder : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }
}
