using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.AI;
using Wizstar.Agents.Governance;
using Wizstar.Agents.Audit;
using Wizstar.Agents.Profiles;
using Wizstar.Agents.Skills;
using Wizstar.Agents.Tools;
using Wizstar.Contracts;

namespace Wizstar.Agents.Runtime;

/// <summary>挂载到一次对话的附件（文本类文件带内容摘要，二进制只带元信息）。</summary>
public sealed record AgentAttachment(string Name, string? Mime, long Size, string? Text);

public sealed record AgentRunOptions(
    string AgentKey,
    string ConversationId,
    string Message,
    IReadOnlyList<AgentAttachment>? Attachments = null,
    IReadOnlyList<string>? Tags = null,
    string? SkillKey = null);

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
    string Message,
    int ContextChars = 0,
    bool ContextTruncated = false,
    int ContextMemoryItems = 0,
    int ContextKnowledgeItems = 0,
    string? Model = null,
    string? Skill = null);

/// <summary>SSE 流式事件。</summary>
public abstract record AgentRunEvent
{
    /// <summary>meta：运行模式与装配信息（首个事件）。</summary>
    public sealed record Meta(
        string AgentKey, string ConversationId, string Mode, string? OfflineReason,
        int AssembledTools, string? Model = null, string? Skill = null) : AgentRunEvent;

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
    IConversationStore conversations,
    ILoggerFactory loggerFactory,
    ILogger<AgentRunner> logger,
    IAgentContextProvider? contextProvider = null,
    SkillCatalog? skillCatalog = null,
    IAuditTrail? auditTrail = null,
    AgentMcpPolicyStore? mcpPolicyStore = null)
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

    /// <summary>解析并校验本次运行指定的 Skill：必须存在、启用且绑定当前 Agent。</summary>
    private SkillDefinition? ResolveSkill(string agentKey, string? skillKey)
    {
        if (string.IsNullOrWhiteSpace(skillKey))
        {
            return null;
        }
        if (skillCatalog is null)
        {
            throw ApiException.Validation("Skill 目录未启用，无法按技能运行");
        }
        var skill = skillCatalog.Get(skillKey)
            ?? throw ApiException.Validation($"Skill 不存在: {skillKey}");
        if (!skill.Enabled)
        {
            throw ApiException.Validation($"Skill 已停用: {skillKey}");
        }
        if (!SkillRules.AllowsChat(skill.TriggerMode))
        {
            throw ApiException.Validation($"Skill {skillKey} 仅支持自动管线触发，不能通过 Chat 调用");
        }
        if (!string.Equals(skill.Agent, agentKey, StringComparison.OrdinalIgnoreCase))
        {
            throw ApiException.Validation($"Skill {skillKey} 绑定给 {skill.Agent}，不能由 {agentKey} 执行");
        }
        return skill;
    }

    private async Task ExecuteCoreAsync(
        AgentRunOptions options,
        List<AgentRunEvent> events,
        CancellationToken cancellationToken)
    {
        var profile = ResolveProfile(options.AgentKey);
        var conversationId = conversations.NormalizeConversationId(options.ConversationId);
        var input = ComposeInput(options.Message, options.Attachments);
        var handle = chatProvider.Get(profile.Key);
        var skill = ResolveSkill(profile.Key, options.SkillKey);

        // ① 长期记忆 / 知识库：按 Agent 独立加载（失败不阻断对话，只是不注入）
        var contextBlock = AgentContextBlock.Empty;
        if (contextProvider is not null)
        {
            try
            {
                contextBlock = await contextProvider
                    .BuildAsync(profile.Key, conversationId, options.Tags, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Agent 上下文加载失败，本次不注入: agent={AgentKey}", profile.Key);
            }
        }

        // ② 装配：按授权清单全量装配；若指定 Skill，再按 allowed_tools 精确切片
        var registered = registry.ResolveForAgent(profile);
        // 管理界面保存的「Agent × MCP 服务」精确切片：只覆盖该服务的工具，
        // 未配置切片的服务仍沿用 agents.yaml 的通配授权；内置工具不受影响。
        if (mcpPolicyStore is not null && mcpPolicyStore.HasAgentPolicy(profile.Key))
        {
            registered = registered
                .Where(t => mcpPolicyStore.Allows(profile.Key, t.Descriptor.ServerId, t.Descriptor.Name))
                .ToList();
        }
        if (skill is not null)
        {
            registered = registered
                .Where(t => ToolRegistry.IsAllowed(skill.AllowedTools, t.Descriptor))
                .ToList();
        }
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

        events.Add(new AgentRunEvent.Meta(
            profile.Key, conversationId, handle.Mode, handle.Reason,
            functions.Count, handle.Model, skill?.Code));

        // ② 工具循环
        var invoker = new FunctionInvokingChatClient(handle.Client, loggerFactory, null)
        {
            // 步数预算在 WizstarToolFunction 调用链内精确控制，这里多给 2 轮余量
            //（模型可能还有一次「不要工具直接答」的回合），防止无限往返
            MaximumIterationsPerRequest = profile.MaxSteps + 2,
            AllowConcurrentInvocation = false,
            IncludeDetailedErrors = true,
            MaximumConsecutiveErrorsPerRequest = skill is null ? 3 : Math.Clamp(skill.Retry, 1, 5),
            // 模型编了不存在的工具名时，把「函数不存在」作为 tool 结果回传，模型自行修正
            TerminateOnUnknownCalls = false
        };

        var history = conversations.GetHistory(conversationId, profile.Key);
        // System 恒在最前（不进历史存储）；Skill SOP 作为第二层 system，上下文紧随其后
        var systemPrompt = profile.SystemPrompt;
        if (skill is not null)
        {
            systemPrompt = systemPrompt
                + "\n\n【当前 Skill SOP · " + skill.Name + "（" + skill.Code + "）】\n"
                + skill.Prompt;
        }
        var messages = new List<ChatMessage> { new(ChatRole.System, systemPrompt) };
        var contextMessage = contextBlock.ToSystemMessage();
        if (contextMessage is not null)
        {
            messages.Add(new ChatMessage(ChatRole.System, contextMessage));
        }
        messages.AddRange(history);
        messages.Add(new ChatMessage(ChatRole.User, input));

        var chatOptions = new ChatOptions
        {
            Tools = functions.Cast<AITool>().ToList(),
            AllowMultipleToolCalls = true,
            MaxOutputTokens = skill?.MaxOutputTokens ?? 2048,
            Temperature = skill is null ? null : (float)skill.Temperature
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

            conversations.Append(conversationId, profile.Key, new ChatMessage(ChatRole.User, input));
            conversations.Append(conversationId, profile.Key, new ChatMessage(ChatRole.Assistant, output));

            if (contextProvider is not null)
            {
                try
                {
                    await contextProvider.RecordAsync(profile.Key, conversationId, contextBlock, CancellationToken.None)
                        .ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Agent 上下文快照写入失败: agent={AgentKey}", profile.Key);
                }
            }
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
            trace, pending, functions.Count, stopwatch.ElapsedMilliseconds, message,
            contextBlock.TotalChars, contextBlock.Truncated,
            contextBlock.MemoryIds.Count, contextBlock.KnowledgeIds.Count, handle.Model, skill?.Code)));
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
            await RecordAuditAsync(
                tool, arguments, agentKey, conversationId, traceId, risk,
                "budget_exceeded", null, "步数预算已用尽", stopwatch.ElapsedMilliseconds, null, null,
                CancellationToken.None).ConfigureAwait(false);
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
        int? errorCode = null;
        string? errorMessage = null;
        if (ToolEnvelope.FromJson(resultJson) is { } envelope)
        {
            replayed = envelope.Replayed;
            if (!envelope.Success && envelope.Error is not null)
            {
                toolStatus = $"error_{envelope.Error.Code}";
                errorCode = envelope.Error.Code;
                errorMessage = envelope.Error.Message;
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

        await RecordAuditAsync(
            tool, arguments, agentKey, conversationId, traceId, risk,
            replayed ? "replayed" : toolStatus, errorCode, errorMessage,
            stopwatch.ElapsedMilliseconds, approvalId, resultJson,
            CancellationToken.None).ConfigureAwait(false);

        logger.LogInformation(
            "工具调用: agent={AgentKey} tool={Tool} risk={Risk} status={Status} step={Step} {Elapsed}ms",
            agentKey, tool.ModelName, risk, toolStatus, step, stopwatch.ElapsedMilliseconds);

        return resultJson;
    }

    private async Task RecordAuditAsync(
        RegisteredTool tool,
        JsonElement arguments,
        string agentKey,
        string conversationId,
        string traceId,
        string risk,
        string status,
        int? errorCode,
        string? errorMessage,
        long elapsedMs,
        Guid? approvalId,
        string? resultJson,
        CancellationToken cancellationToken)
    {
        if (auditTrail is null)
        {
            return;
        }
        try
        {
            await auditTrail.RecordAsync(new AuditTrailEntry(
                agentKey,
                conversationId,
                traceId,
                tool.Descriptor.ServerId,
                tool.Descriptor.Name,
                risk,
                arguments.GetRawText(),
                resultJson,
                status,
                errorCode,
                errorMessage,
                elapsedMs,
                approvalId?.ToString("D"),
                null,
                null), cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "审计轨迹写入失败（不阻断工具调用）: agent={Agent} tool={Tool}", agentKey, tool.Descriptor.Name);
        }
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

    /// <summary>正文 + 附件块（附件文本按条 4000 字、总计 8000 字截断，避免吃满上下文）。</summary>
    private static string ComposeInput(string? message, IReadOnlyList<AgentAttachment>? attachments)
    {
        var input = ValidateInput(message);
        if (attachments is null || attachments.Count == 0)
        {
            return input;
        }

        var sb = new System.Text.StringBuilder(input);
        sb.AppendLine();
        sb.AppendLine();
        sb.AppendLine("【挂载附件】");
        var budget = 8000;
        foreach (var file in attachments)
        {
            sb.AppendLine($"- {file.Name}（{file.Size} bytes{(string.IsNullOrWhiteSpace(file.Mime) ? string.Empty : ", " + file.Mime)}）");
            if (string.IsNullOrWhiteSpace(file.Text) || budget <= 0)
            {
                continue;
            }
            var text = file.Text.Length <= 4000 ? file.Text : file.Text[..4000] + "…（截断）";
            if (text.Length > budget)
            {
                text = text[..budget] + "…（截断）";
            }
            budget -= text.Length;
            sb.AppendLine("  内容摘要：");
            sb.AppendLine(text);
        }
        return sb.ToString().TrimEnd();
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
