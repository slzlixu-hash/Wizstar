using System.Text.Json;
using Wizstar.Contracts;

namespace Wizstar.Api.Middleware;

/// <summary>
/// 异常统一信封中间件：任何未处理异常都转成 ApiEnvelope（错误码归一化），不向外抛裸堆栈。
/// </summary>
public sealed class ExceptionHandlingMiddleware(RequestDelegate next, ILogger<ExceptionHandlingMiddleware> logger)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await next(context).ConfigureAwait(false);
        }
        catch (ApiException ex)
        {
            var traceId = context.TraceIdentifier;
            logger.LogWarning("业务异常: code={Code} message={Message} traceId={TraceId}", ex.Code, ex.Message, traceId);
            await WriteErrorAsync(context, ex.Code, ex.Message, traceId).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
        {
            // 客户端断开（SSE 关闭等）：不写响应
        }
        catch (Exception ex)
        {
            var traceId = context.TraceIdentifier;
            logger.LogError(ex, "未处理异常: traceId={TraceId}", traceId);
            await WriteErrorAsync(context, ErrorCodes.InternalError, "服务内部异常，请稍后重试", traceId).ConfigureAwait(false);
        }
    }

    private static async Task WriteErrorAsync(HttpContext context, int code, string message, string traceId)
    {
        context.Response.StatusCode = MapStatus(code);
        context.Response.ContentType = "application/json; charset=utf-8";

        var envelope = new ApiEnvelope<object>(false, null, new ApiError(code, message, traceId), traceId);
        await context.Response.WriteAsync(JsonSerializer.Serialize(envelope, JsonOptions)).ConfigureAwait(false);
    }

    private static int MapStatus(int code) => code switch
    {
        ErrorCodes.ValidationError => StatusCodes.Status400BadRequest,
        ErrorCodes.AuthFailed => StatusCodes.Status401Unauthorized,
        ErrorCodes.PermissionDenied => StatusCodes.Status403Forbidden,
        ErrorCodes.IdempotencyConflict => StatusCodes.Status409Conflict,
        ErrorCodes.BusinessRejected => StatusCodes.Status422UnprocessableEntity,
        ErrorCodes.RateLimited => StatusCodes.Status429TooManyRequests,
        ErrorCodes.QuotaExhausted => StatusCodes.Status429TooManyRequests,
        ErrorCodes.NetworkError => StatusCodes.Status502BadGateway,
        _ => StatusCodes.Status500InternalServerError
    };
}
