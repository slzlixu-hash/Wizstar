using System.Text.Json;
using Microsoft.Extensions.AI;
using Wizstar.Contracts;

namespace Wizstar.Agents.Tools;

/// <summary>
/// 把一个 ToolDescriptor 包装成 MAF 的 <see cref="AIFunction"/>。
///
/// 这一层是工具执行的唯一入口：模型的每次 tool_call 都经由
/// <see cref="Runtime.ToolInvoker"/>（风险分级 → 幂等账本 → HITL 审批 → Provider 执行），
/// 因此治理机制天然生效，不存在「自动循环绕过审批」的旁路。
///
/// 口径：
///  - 参数：模型给的 arguments 原样转 JSON 交给工具层，不做二次校验（工具自己按 inputSchema 报错）；
///  - 结果：返回统一信封 JSON 文本；超长截断并显式标注，避免单条结果撑爆上下文；
///  - 失败：一律作为合法 tool 结果回给模型（而不是抛断整个循环），模型可换参重试或换路。
/// </summary>
public sealed class WizstarToolFunction : AIFunction
{
    private const int MaxResultChars = 8000;

    private readonly Func<JsonElement, CancellationToken, Task<string>> _invoke;

    public WizstarToolFunction(
        string name,
        string description,
        string? inputSchemaJson,
        Func<JsonElement, CancellationToken, Task<string>> invoke)
    {
        Name = name;
        Description = string.IsNullOrWhiteSpace(description) ? name : description;
        _invoke = invoke;
        Schema = Governance.ToolSchemaUtil.ParseSchema(inputSchemaJson);
    }

    /// <summary>模型看到的函数名（已按 OpenAI 约束清洗，见 ToolRegistry.ModelFunctionName）。</summary>
    public override string Name { get; }

    public override string Description { get; }

    public override JsonElement JsonSchema => Schema;

    private JsonElement Schema { get; }

    protected override async ValueTask<object?> InvokeCoreAsync(
        AIFunctionArguments arguments, CancellationToken cancellationToken)
    {
        JsonElement payload;
        try
        {
            var json = JsonSerializer.Serialize(
                arguments.ToDictionary(pair => pair.Key, pair => pair.Value));
            using var document = JsonDocument.Parse(json);
            payload = document.RootElement.Clone();
        }
        catch (Exception ex)
        {
            return EnvelopeJson.Fail(ErrorCodes.ValidationError, $"参数无法序列化：{ex.Message}");
        }

        try
        {
            var result = await _invoke(payload, cancellationToken).ConfigureAwait(false);
            return result.Length <= MaxResultChars
                ? result
                : result[..MaxResultChars] + $"\n…（结果已截断，原长 {result.Length} 字符）";
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // HttpClient / 工具层超时会抛 OperationCanceledException——
            // 这不是用户主动取消，必须转成合法 tool 结果，否则会打断整条对话
            return EnvelopeJson.Fail(ErrorCodes.NetworkError, "调用超时或连接中断", retryable: true);
        }
        catch (OperationCanceledException)
        {
            throw; // 真实的用户/宿主取消，按原语义中断
        }
        catch (Exception ex)
        {
            return EnvelopeJson.Fail(ErrorCodes.InternalError, ex.Message);
        }
    }
}

/// <summary>信封 JSON 快捷构造（工具结果统一从这里出去）。</summary>
public static class EnvelopeJson
{
    public static string Ok(JsonElement? data, string traceId, bool replayed = false, string serverName = "builtin", long elapsedMs = 0)
    {
        var envelope = new ToolEnvelope(
            true, data, new ToolUsageInfo("call", 1), null,
            new ToolServerInfo(serverName, "1.0.0", "1.0", elapsedMs),
            traceId, replayed);
        return envelope.ToJson();
    }

    public static string Fail(int code, string message, bool retryable = false, string traceId = "", long elapsedMs = 0)
    {
        var envelope = new ToolEnvelope(
            false, null, new ToolUsageInfo("call", 1),
            new ToolErrorInfo(code, message, retryable),
            new ToolServerInfo("builtin", "1.0.0", "1.0", elapsedMs),
            traceId, false);
        return envelope.ToJson();
    }
}
