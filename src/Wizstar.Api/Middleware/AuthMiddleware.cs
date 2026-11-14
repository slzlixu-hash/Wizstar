using System.Text.Json;
using Wizstar.Api.Services;
using Wizstar.Contracts;

namespace Wizstar.Api.Middleware;

/// <summary>
/// 登录态校验中间件：/api/* 默认需要 `Authorization: Bearer &lt;token&gt;`。
///
/// 放行清单（登录页与探活必需）：
///   - POST /api/auth/login  登录本身
///   - GET  /api/health      进程健康检查
///   - OPTIONS 预检
/// 关闭方式：配置 `Auth:Enabled=false`（仅本机联调，不推荐）。
/// 校验通过后把用户写入 <see cref="HttpContext.Items"/>，端点用 <see cref="CurrentUser"/> 读取。
/// </summary>
public sealed class AuthMiddleware(
    RequestDelegate next,
    AuthTokenService tokens,
    IConfiguration configuration,
    ILogger<AuthMiddleware> logger)
{
    /// <summary>HttpContext.Items 中登录用户的键。</summary>
    public const string UserItemKey = "wizstar.auth.user";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public async Task InvokeAsync(HttpContext context)
    {
        if (!configuration.GetValue("Auth:Enabled", true)
            || HttpMethods.IsOptions(context.Request.Method)
            || !context.Request.Path.StartsWithSegments("/api")
            || IsOpenPath(context.Request.Path))
        {
            await next(context).ConfigureAwait(false);
            return;
        }

        var token = ReadBearerToken(context);
        if (tokens.TryValidate(token, out var user) && user is not null)
        {
            context.Items[UserItemKey] = user;
            await next(context).ConfigureAwait(false);
            return;
        }

        logger.LogInformation("拒绝未登录请求: {Method} {Path} traceId={TraceId}",
            context.Request.Method, context.Request.Path, context.TraceIdentifier);

        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.Headers.WWWAuthenticate = "Bearer";
        var error = new ApiEnvelope<object>(
            false, null,
            new ApiError(ErrorCodes.AuthFailed, "未登录或登录已过期，请重新登录", context.TraceIdentifier),
            context.TraceIdentifier);
        await context.Response.WriteAsync(JsonSerializer.Serialize(error, JsonOptions)).ConfigureAwait(false);
    }

    private static bool IsOpenPath(PathString path) =>
        path.StartsWithSegments("/api/auth/login", StringComparison.OrdinalIgnoreCase)
        || path.StartsWithSegments("/api/health", StringComparison.OrdinalIgnoreCase);

    private static string? ReadBearerToken(HttpContext context)
    {
        var header = context.Request.Headers.Authorization.ToString();
        if (string.IsNullOrWhiteSpace(header))
        {
            return null;
        }
        const string prefix = "Bearer ";
        return header.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            ? header[prefix.Length..].Trim()
            : null;
    }
}

/// <summary>端点侧读取当前登录用户的小工具。</summary>
public static class CurrentUser
{
    public static AuthUser? From(HttpContext context) =>
        context.Items.TryGetValue(AuthMiddleware.UserItemKey, out var value) ? value as AuthUser : null;
}
