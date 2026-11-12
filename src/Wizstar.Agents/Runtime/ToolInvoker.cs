using System.Text;
using System.Text.Json;
using Wizstar.Agents.Governance;
using Wizstar.Agents.Ledger;
using Wizstar.Agents.Tools;
using Wizstar.Contracts;

namespace Wizstar.Agents.Runtime;

/// <summary>单次工具调用的执行轨迹（供 SSE tool 事件与运行结果使用）。</summary>
public sealed record ToolTraceItem(
    int Step,
    string ServerId,
    string ToolName,
    string Risk,
    string Status,
    Guid? ApprovalId,
    string? OperationId,
    bool Replayed,
    long DurationMs,
    string Excerpt);

/// <summary>
/// 工具执行器（治理核心）：所有 tool_call 的唯一落点。
///
/// 执行顺序固定，任何一层都不允许绕过：
///   ① 风险分级（RiskClassifier：x-risk &gt; 动词兜底 &gt; 未知默认 write）；
///   ② 副作用操作强制走幂等账本（operationId 平台侧注入；命中回放 / 篡改报 43009）；
///   ③ irreversible 强制 HITL：创建审批单后返回 pending，服务端从不自动批准；
///      批准后的下一次同 operationId 调用才真正执行；
///   ④ read 直接放行；write 按配置执行或 dry-run。
/// </summary>
public sealed class ToolInvoker(
    IApprovalStore approvals,
    OperationLedger ledger,
    IConfiguration configuration,
    ILogger<ToolInvoker> logger)
{
    /// <summary>write 风险执行模式：execute（默认）或 dryrun。</summary>
    public const string WriteModeExecute = "execute";
    public const string WriteModeDryRun = "dryrun";

    public async Task<string> InvokeAsync(
        RegisteredTool tool,
        JsonElement arguments,
        ToolContext context,
        int step,
        CancellationToken cancellationToken)
    {
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        var risk = RiskClassifier.Classify(tool.Descriptor);
        var mutating = RiskClassifier.IsMutating(risk);

        // ① operationId 平台侧注入（模型不参与生成，防止编造）：
        //    调用方显式传了就保留；否则按「服务 + 工具 + 规范入参 + 当日日期」确定性生成。
        var argsForLedger = arguments;
        var explicitOperationId = GetString(arguments, "operationId");
        string operationId;
        if (mutating)
        {
            if (string.IsNullOrWhiteSpace(explicitOperationId))
            {
                var canonical = StripOperationId(arguments);
                operationId = OperationId.Generate(tool.Descriptor.ServerId, tool.Descriptor.Name, canonical);
                argsForLedger = InjectOperationId(arguments, operationId);
            }
            else
            {
                operationId = explicitOperationId;
                argsForLedger = arguments;
            }
        }
        else
        {
            operationId = explicitOperationId ?? string.Empty;
        }

        var scope = context.Scope(tool.Descriptor);
        var argsJson = argsForLedger.GetRawText();
        var argsDigest = OperationId.ArgsDigest(argsJson);

        try
        {
            // ② 幂等账本：回放 / 防篡改（仅副作用操作）
            if (mutating)
            {
                var probe = await ledger.ProbeAsync(scope, operationId, argsDigest, cancellationToken).ConfigureAwait(false);
                if (probe.Kind == LedgerProbeKind.Tampered)
                {
                    logger.LogWarning("幂等冲突: scope={Scope} operationId={OperationId}", scope, operationId);
                    return EnvelopeJson.Fail(ErrorCodes.IdempotencyConflict, "相同 operationId 但请求参数被篡改，拒绝执行", traceId: context.TraceId);
                }

                if (probe.Kind == LedgerProbeKind.Replayed)
                {
                    logger.LogInformation("幂等回放: scope={Scope} operationId={OperationId}", scope, operationId);
                    return Replay(probe.ResultJson, context);
                }
            }

            // ③ irreversible：强制 HITL（先查审批单，再决定挂起或执行）
            if (RiskClassifier.RequiresApproval(risk))
            {
                var existing = approvals.FindPendingOrDecided(tool.Descriptor.ServerId, tool.Descriptor.Name, operationId, argsDigest);
                if (existing is null)
                {
                    existing = approvals.Create(new ApprovalRequest(
                        Guid.NewGuid(),
                        context.AgentKey,
                        tool.Descriptor.ServerId,
                        tool.Descriptor.Name,
                        risk,
                        operationId,
                        argsDigest,
                        argsJson,
                        ApprovalStatus.Pending,
                        null,
                        DateTimeOffset.Now,
                        null));
                    logger.LogInformation("已创建 HITL 审批单: id={ApprovalId} tool={Tool} operationId={OperationId}",
                        existing.Id, tool.Descriptor.Name, operationId);
                }

                if (string.Equals(existing.Status, ApprovalStatus.Approved, StringComparison.Ordinal))
                {
                    return (await ExecuteWithLedgerAsync(
                        tool, argsForLedger, context, risk, scope, operationId, argsDigest,
                        ApprovalStatus.Approved, stopwatch, cancellationToken).ConfigureAwait(false)).ToJson();
                }

                if (string.Equals(existing.Status, ApprovalStatus.Rejected, StringComparison.Ordinal))
                {
                    return EnvelopeJson.Fail(
                        ErrorCodes.BusinessRejected, $"审批单 {existing.Id} 已被人工拒绝，不执行", traceId: context.TraceId);
                }

                return PendingEnvelope(existing.Id, risk, operationId, context);
            }

            // ④ read 直接放行；write 走 dry-run 或直接执行
            var dryRun = string.Equals(risk, RiskLevels.Write, StringComparison.Ordinal)
                         && string.Equals(WriteModeDryRun, configuration["Governance:WriteMode"], StringComparison.OrdinalIgnoreCase);
            var effectiveContext = dryRun ? context with { DryRun = true } : context;

            var envelope = mutating
                ? await ExecuteWithLedgerAsync(tool, argsForLedger, effectiveContext, risk, scope, operationId, argsDigest, null, stopwatch, cancellationToken).ConfigureAwait(false)
                : await ExecuteProviderAsync(tool, argsForLedger, effectiveContext, cancellationToken).ConfigureAwait(false);

            return envelope.ToJson();
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            await ledger.CompleteAsync(scope, operationId, false, null, CancellationToken.None).ConfigureAwait(false);
            return EnvelopeJson.Fail(ErrorCodes.NetworkError, "工具调用超时或连接中断", retryable: true, traceId: context.TraceId);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "工具执行失败: tool={ServerId}.{Tool}", tool.Descriptor.ServerId, tool.Descriptor.Name);
            await ledger.CompleteAsync(scope, operationId, false, null, CancellationToken.None).ConfigureAwait(false);
            return EnvelopeJson.Fail(ErrorCodes.InternalError, ex.Message, traceId: context.TraceId);
        }
    }

    private async Task<ToolEnvelope> ExecuteWithLedgerAsync(
        RegisteredTool tool, JsonElement arguments, ToolContext context,
        string risk, string scope, string operationId, string argsDigest,
        string? approvalStatus, System.Diagnostics.Stopwatch stopwatch, CancellationToken ct)
    {
        await ledger.MarkExecutingAsync(scope, operationId, argsDigest, ct).ConfigureAwait(false);
        var envelope = await ExecuteProviderAsync(tool, arguments, context, ct).ConfigureAwait(false);
        await ledger.CompleteAsync(scope, operationId, envelope.Success, envelope.ToJson(), ct).ConfigureAwait(false);

        if (approvalStatus is not null)
        {
            logger.LogInformation("审批通过后执行: tool={Tool} operationId={OperationId} status={Approval}",
                tool.Descriptor.Name, operationId, approvalStatus);
        }

        return envelope;
    }

    private async Task<ToolEnvelope> ExecuteProviderAsync(RegisteredTool tool, JsonElement arguments, ToolContext context, CancellationToken ct)
    {
        var envelope = await tool.Provider.InvokeAsync(tool.Descriptor, arguments, context, ct).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(envelope.TraceId))
        {
            envelope = envelope with { TraceId = context.TraceId };
        }

        return envelope;
    }

    private static string Replay(string? storedJson, ToolContext context)
    {
        var stored = storedJson is null ? null : ToolEnvelope.FromJson(storedJson);
        if (stored is null)
        {
            return EnvelopeJson.Fail(ErrorCodes.InternalError, "账本历史结果损坏，无法回放", traceId: context.TraceId);
        }

        return (stored with { Replayed = true, TraceId = context.TraceId }).ToJson();
    }

    private static string PendingEnvelope(Guid approvalId, string risk, string operationId, ToolContext context)
    {
        var data = JsonSerializer.SerializeToElement(new
        {
            approvalRequired = true,
            approvalId,
            risk,
            operationId,
            message = "该操作为不可逆操作，已提交人工审批，尚未执行。请如实告知用户等待审批，不要重复提交同一调用。"
        });
        var envelope = new ToolEnvelope(
            true, data, new ToolUsageInfo("call", 1), null,
            new ToolServerInfo("governance", "1.0.0", "1.0", 0),
            context.TraceId, false);
        return envelope.ToJson();
    }

    // ---------------------------------------------------------------- 参数处理

    private static string? GetString(JsonElement arguments, string name)
    {
        if (arguments.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        return arguments.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static string StripOperationId(JsonElement arguments)
    {
        if (arguments.ValueKind != JsonValueKind.Object)
        {
            return "{}";
        }

        var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            foreach (var property in arguments.EnumerateObject())
            {
                if (!string.Equals(property.Name, "operationId", StringComparison.Ordinal))
                {
                    property.WriteTo(writer);
                }
            }
            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    private static JsonElement InjectOperationId(JsonElement arguments, string operationId)
    {
        if (arguments.ValueKind != JsonValueKind.Object)
        {
            return JsonSerializer.SerializeToElement(new { operationId });
        }

        var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            foreach (var property in arguments.EnumerateObject())
            {
                if (!string.Equals(property.Name, "operationId", StringComparison.Ordinal))
                {
                    property.WriteTo(writer);
                }
            }
            writer.WriteString("operationId", operationId);
            writer.WriteEndObject();
        }

        using var document = JsonDocument.Parse(buffer.ToArray());
        return document.RootElement.Clone();
    }
}
