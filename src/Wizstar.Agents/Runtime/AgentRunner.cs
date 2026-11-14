using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.AI;
using Wizstar.Agents.Governance;
using Wizstar.Agents.Profiles;
using Wizstar.Agents.Tools;
using Wizstar.Contracts;

namespace Wizstar.Agents.Runtime;

public sealed record AgentRunOptions(string AgentKey, string ConversationId, string Message);

/// <summary>一次 Agent 运行的完整结果（SSE done 事件与 JSON 响应共用）。</summary>
public sealed record AgentRunResult(
    string AgentKey,
    string ConversationId,
    string Mode,
    string Status,
    string Output,
    IReadOnlyList<ToolTraceItem> Trace,
    IReadOnlyList<Guid> PendingApprovalIds,
    int AssembledTools,
    long ElapsedMs,
    string Message);

/// <summary>SSE 流式事件。</summary>
public abstract record AgentRunEvent
{
    /// <summary>meta：运行模式与装配信息（首个事件）。</summary>
    public sealed record Meta(string AgentKey, string ConversationId, string Mode, string? OfflineReason, int AssembledTools) : AgentRunEvent;

    /// <summary>tool：一次工具调用轨迹（执行完即推送）。</summary>
    public sealed record ToolEvent(ToolTraceItem Trace) : AgentRunEvent;

    /// <summary>delta：模型文本增量。</summary>
    public sealed record Delta(string Text) : AgentRunEvent;

    /// <summary>done：最终结果（收尾事件）。</summary>
    public sealed record Done(AgentRunResult Result) : AgentRunEvent;
}

/// <summary>
/// Agent 执行器：把「人设 + 授权工具 + 会话历史 + 用户输入」交给模型，由模型自主决定工具循环。
///
/// 工具循环交给 FunctionInvokingChatClient（微软维护，已处理 tool_calls 拦截 / 结果回传 /
/// 未知工具报错回传 / 循环上限 / 连续错误熔断），我们只负责：
///  ① 装配：按 AgentProfile 通配授权从 ToolRegistry 取函数（授权范围即工具可见面）；
///  ② 治理：每次调用经 WizstarToolFunction → ToolInvoker（风险分级 / 幂等 / HITL）；
///  ③ 收敛：步数用尽或模型没给出结论时如实返回 max_steps / failed，不假装成功。
/// 并发口径：同一轮多个 tool_calls 串行（AllowConcurrentInvocation=false），审批与审计顺序可追溯。
/// </summary>
public sealed class AgentRunner(
    AgentCatalog catalog,
    ToolRegistry registry,
    ToolInvoker invoker,
    ChatClientProvider chatProvider,
    ConversationStore conversations,
    ILoggerFactory loggerFactory,
    ILogger<AgentRunner> logger)
{
    public async Task<AgentRunResult> RunAsync(AgentRunOptions options, CancellationToken cancellationToken = default)
    {
        var events = new List<AgentRunEvent>();
        await ExecuteCoreAsync(options, events, cancellationToken).ConfigureAwait(false);

        var done = events.OfType<AgentRunEvent.Done>().FirstOrDefault()
            ?? throw ApiException.Internal("Agent 运行未产生结果");
        return done.Result;
    }

    /// <summary>流式执行：依次产出 Meta / ToolEvent / Delta / Done。</summary>
    public async IAsyncEnumerable<AgentRunEvent> StreamAsync(
        AgentRunOptions options,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var events = new List<AgentRunEvent>();
        await ExecuteCoreAsync(options, events, cancellationToken).ConfigureAwait(false);

        foreach (var e in events)
        {
            yield return e;
        }
    }

    // ---------------------------------------------------------------- 执行核心

    private async Task ExecuteCoreAsync(
        AgentRunOptions options,
        List<AgentRunEvent> events,
        CancellationToken cancellationToken)
    {
        var profile = ResolveProfile(options.AgentKey);
        var conversationId = conversations.NormalizeConversationId(options.ConversationId);
        var input = ValidateInput(options.Message);
        var handle = chatProvider.Get();

        // ① 装配：按授权清单全量装配（ToolRegistry 内部去重，不设数量上限）
        var registered = registry.ResolveForAgent(profile);
        var functions = new List<AIFunction>();
        var step = 0;
        var trace = new List<ToolTraceItem>();

        foreach (var tool in registered)
        {
            functions.Add(new WizstarToolFunction(
                tool.ModelName,
                tool.Descriptor.Description,
                tool.Descriptor.InputSchemaJson,
                (arguments, ct) => InvokeAndTraceAsync(
                    tool, arguments, profile.Key, conversationId, ++step, profile.MaxSteps, trace, ct)));
        }

        events.Add(new AgentRunEvent.Meta(profile.Key, conversationId, handle.Mode, handle.Reason, functions.Count));

        // ② 工具循环
        var invoker = new FunctionInvokingChatClient(handle.Client, loggerFactory, null)
        {
            // 步数预算在 WizstarToolFunction 调用链内精确控制，这里多给 2 轮余量
            //（模型可能还有一次「不要工具直接答」的回合），防止无限往返
            MaximumIterationsPerRequest = profile.MaxSteps + 2,
            AllowConcurrentInvocation = false,
            IncludeDetailedErrors = true,
            MaximumConsecutiveErrorsPerRequest = 3,
            // 模型编了不存在的工具名时，把「函数不存在」作为 tool 结果回传，模型自行修正
            TerminateOnUnknownCalls = false
        };

        var history = conversations.GetHistory(conversationId);
        // System 恒在最前（不进历史存储）；history 为会话内 user/assistant 往返
        var messages = new List<ChatMessage> { new(ChatRole.System, profile.SystemPrompt) };
        messages.AddRange(history);
        messages.Add(new ChatMessage(ChatRole.User, input));

        var chatOptions = new ChatOptions
        {
            Tools = functions.Cast<AITool>().ToList(),
            AllowMultipleToolCalls = true,
            MaxOutputTokens = 2048
        };

        var stopwatch = Stopwatch.StartNew();
        var outputBuilder = new System.Text.StringBuilder();
        string status;
        string message;

        try
        {
            await foreach (var update in invoker
                .GetStreamingResponseAsync(messages, chatOptions, cancellationToken)
                .ConfigureAwait(false))
            {
                var deltaText = update.Text;
                if (!string.IsNullOrEmpty(deltaText))
                {
                    outputBuilder.Append(deltaText);
                    events.Add(new AgentRunEvent.Delta(deltaText));
                }
            }

            var output = outputBuilder.ToString().Trim();
            var budgetExhausted = trace.Any(t => string.Equals(t.Status, "budget_exceeded", StringComparison.Ordinal));
            status = output.Length > 0 ? "completed" : budgetExhausted ? "max_steps" : "failed";
            message = output.Length == 0
                ? budgetExhausted
                    ? $"达到步数上限 {profile.MaxSteps}，模型未收敛；已执行的 {trace.Count} 次调用均已落审计"
                    : "模型未返回任何文本结论"
                : $"运行完成：{trace.Count} 次工具调用，模式 {handle.Mode}";

            conversations.Append(conversationId, new ChatMessage(ChatRole.User, input));
            conversations.Append(conversationId, new ChatMessage(ChatRole.Assistant, output));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            status = "failed";
            message = "模型调用超时，已中断";
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (InvalidOperationException ex) when (IsIterationLimit(ex))
        {
            status = "max_steps";
            message = $"达到步数上限 {profile.MaxSteps}，模型未收敛；已执行的 {trace.Count} 次调用均已落审计";
        }
        catch (Exception ex) when (ex is InvalidOperationException or HttpRequestException or JsonException)
        {
            status = "failed";
            message = "运行失败：" + ex.Message;
            logger.LogWarning(ex, "Agent 运行失败: agent={AgentKey}", profile.Key);
        }

        stopwatch.Stop();

        if (status != "completed")
        {
            logger.LogInformation("Agent 运行未完成: agent={AgentKey} status={Status} steps={Steps}",
                profile.Key, status, trace.Count);
        }

        var pending = trace
            .Where(t => string.Equals(t.Status, "pending_approval", StringComparison.Ordinal) && t.ApprovalId is not null)
            .Select(t => t.ApprovalId!.Value)
            .Distinct()
            .ToList();

        events.Add(new AgentRunEvent.Done(new AgentRunResult(
            profile.Key, conversationId, handle.Mode, status, outputBuilder.ToString().Trim(),
            trace, pending, functions.Count, stopwatch.ElapsedMilliseconds, message)));
    }

    private async Task<string> InvokeAndTraceAsync(
        RegisteredTool tool, JsonElement arguments,
        string agentKey, string conversationId, int step, int maxSteps,
        List<ToolTraceItem> trace, CancellationToken ct)
    {
        var stopwatch = Stopwatch.StartNew();
        var traceId = conversationId; // Phase 0 用 conversationId 兼作 traceId
        var risk = RiskClassifier.Classify(tool.Descriptor);
        var context = new ToolContext(agentKey, traceId, conversationId, DryRun: false);

        // 步数预算硬闸：超预算不再执行，回给模型一段结构化说明促其收敛（不静默截断）
        if (step > maxSteps)
        {
            var budgetData = JsonSerializer.SerializeToElement(new
            {
                stepBudgetExceeded = true,
                maxSteps,
                message = "步数预算已用尽，请基于已获取的信息直接给出结论，不要继续调用工具。"
            });
            trace.Add(new ToolTraceItem(
                step, tool.Descriptor.ServerId, tool.Descriptor.Name, risk, "budget_exceeded",
                null, null, false, stopwatch.ElapsedMilliseconds, "步数预算已用尽"));
            return new ToolEnvelope(
                true, budgetData, new ToolUsageInfo("call", 1), null,
                new ToolServerInfo("governance", "1.0.0", "1.0", stopwatch.ElapsedMilliseconds),
                traceId, false).ToJson();
        }

        var resultJson = await invoker.InvokeAsync(tool, arguments, context, step, ct).ConfigureAwait(false);
        stopwatch.Stop();

        // 解析信封提取状态（解析失败不影响主流程）
        Guid? approvalId = null;
        string toolStatus = "executed";
        bool replayed = false;
        if (ToolEnvelope.FromJson(resultJson) is { } envelope)
        {
            replayed = envelope.Replayed;
            if (!envelope.Success && envelope.Error is not null)
            {
                toolStatus = $"error_{envelope.Error.Code}";
            }

            if (envelope.Data is { } data
                && data.ValueKind == JsonValueKind.Object
                && data.TryGetProperty("approvalRequired", out var flag)
                && flag.ValueKind == JsonValueKind.True)
            {
                toolStatus = "pending_approval";
                if (data.TryGetProperty("approvalId", out var idNode)
                    && idNode.TryGetGuid(out var approvalGuid))
                {
                    approvalId = approvalGuid;
                }
            }
        }

        var item = new ToolTraceItem(
            step, tool.Descriptor.ServerId, tool.Descriptor.Name, risk, toolStatus,
            approvalId, null, replayed, stopwatch.ElapsedMilliseconds, Excerpt(resultJson));
        trace.Add(item);

        logger.LogInformation(
            "工具调用: agent={AgentKey} tool={Tool} risk={Risk} status={Status} step={Step} {Elapsed}ms",
            agentKey, tool.ModelName, risk, toolStatus, step, stopwatch.ElapsedMilliseconds);

        return resultJson;
    }

    private AgentProfile ResolveProfile(string agentKey)
    {
        var profile = catalog.Find(agentKey)
            ?? throw ApiException.Validation($"未注册的 Agent: {agentKey}");
        if (!profile.Enabled)
        {
            throw ApiException.Validation($"Agent 已停用: {agentKey}");
        }

        return profile;
    }

    private static string ValidateInput(string? message)
    {
        var input = (message ?? string.Empty).Trim();
        if (input.Length == 0)
        {
            throw ApiException.Validation("输入不能为空");
        }

        return input.Length <= 8000 ? input : throw ApiException.Validation("输入过长（上限 8000 字）");
    }

    private static bool IsIterationLimit(InvalidOperationException ex) =>
        ex.Message.Contains("maximum", StringComparison.OrdinalIgnoreCase)
        || ex.Message.Contains("iteration", StringComparison.OrdinalIgnoreCase)
        || ex.Message.Contains("tool call", StringComparison.OrdinalIgnoreCase);

    private static string Excerpt(string? value)
    {
        var text = (value ?? string.Empty).Replace('\r', ' ').Replace('\n', ' ').Trim();
        return text.Length <= 200 ? text : text[..200] + "…";
    }
}
