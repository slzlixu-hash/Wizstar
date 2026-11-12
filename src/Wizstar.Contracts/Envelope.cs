using System.Text.Encodings.Web;
using System.Text.Json;

namespace Wizstar.Contracts;

/// <summary>
/// 统一错误码（规范 §5.2）：下游平台的成百上千个私有错误码，
/// 在 MCP 服务 / 工具层归一化成这组契约码后再暴露给 Agent。
/// </summary>
public static class ErrorCodes
{
    /// <summary>入参校验失败或字段缺失。Agent 应根据提示修正参数。</summary>
    public const int ValidationError = 40001;

    /// <summary>HMAC 签名错误 / Token 过期无法刷新。告警，人工重配凭证，不可重试。</summary>
    public const int AuthFailed = 41001;

    /// <summary>触发上游 API 限频。指数退避重试（可重试）。</summary>
    public const int RateLimited = 42001;

    /// <summary>平台日调用额度用完。挂起任务并告警。</summary>
    public const int QuotaExhausted = 42002;

    /// <summary>缺少类目权限 / 未开通功能。明确提示，不可重试。</summary>
    public const int PermissionDenied = 43002;

    /// <summary>相同 operationId 但请求参数被篡改。严重异常，直接终止。</summary>
    public const int IdempotencyConflict = 43009;

    /// <summary>上游业务拒绝（资质不符、重名等）。透传原因供 Agent 决策。</summary>
    public const int BusinessRejected = 43010;

    /// <summary>上游网络超时或连接失败。平台自动重试 3 次（可重试）。</summary>
    public const int NetworkError = 50001;

    /// <summary>服务内部未分类异常。</summary>
    public const int InternalError = 50000;

    /// <summary>契约码是否允许自动重试（42001 / 50001）。</summary>
    public static bool IsRetryable(int code) => code is RateLimited or NetworkError;
}

/// <summary>统一信封里的错误对象（规范 §5.1）。</summary>
public sealed record ToolErrorInfo(int Code, string Message, bool Retryable);

/// <summary>统一信封里的用量信息（规范 §5.1）。</summary>
public sealed record ToolUsageInfo(string Unit, int Quantity, long CostCents = 0);

/// <summary>统一信封里的服务自述（规范 §5.1）。</summary>
public sealed record ToolServerInfo(string Name, string Version, string ToolVersion, long ElapsedMs);

/// <summary>
/// 统一出参信封（规范 §5.1）：所有工具返回（成功或失败）都包装在这个结构里。
/// Data 用 <see cref="JsonElement"/>（可为 null）承载任意业务负载。
/// </summary>
public sealed record ToolEnvelope(
    bool Success,
    JsonElement? Data,
    ToolUsageInfo? Usage,
    ToolErrorInfo? Error,
    ToolServerInfo? Server,
    string TraceId,
    bool Replayed)
{
    /// <summary>信封序列化口径：camelCase + 中文不转义（与 HTTP 层一致）。</summary>
    public static readonly JsonSerializerOptions WireOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public string ToJson() => JsonSerializer.Serialize(this, WireOptions);

    /// <summary>从 JSON 还原信封（幂等回放时改写 replayed 用）。</summary>
    public static ToolEnvelope? FromJson(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<ToolEnvelope>(json, WireOptions);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

/// <summary>HTTP API 统一错误对象。</summary>
public sealed record ApiError(int Code, string Message, string TraceId);

/// <summary>HTTP API 统一信封：所有端点（成功或失败）都返回这个结构。</summary>
public sealed record ApiEnvelope<T>(bool Success, T? Data, ApiError? Error, string TraceId)
{
    public static ApiEnvelope<T> Ok(T data, string traceId) => new(true, data, null, traceId);

    public static ApiEnvelope<T> Fail(int code, string message, string traceId) =>
        new(false, default, new ApiError(code, message, traceId), traceId);
}

/// <summary>
/// 平台层业务异常：携带契约错误码，由异常中间件统一转成 ApiEnvelope。
/// </summary>
public sealed class ApiException(int code, string message) : Exception(message)
{
    public int Code { get; } = code;

    public bool Retryable => ErrorCodes.IsRetryable(Code);

    public static ApiException Validation(string message) => new(ErrorCodes.ValidationError, message);

    public static ApiException Auth(string message) => new(ErrorCodes.AuthFailed, message);

    public static ApiException Conflict(string message) => new(ErrorCodes.IdempotencyConflict, message);

    public static ApiException Business(string message) => new(ErrorCodes.BusinessRejected, message);

    public static ApiException Network(string message) => new(ErrorCodes.NetworkError, message);

    public static ApiException Internal(string message) => new(ErrorCodes.InternalError, message);
}
