using Wizstar.Api.Middleware;
using Wizstar.Api.Services;
using Wizstar.Contracts;

namespace Wizstar.Api.Endpoints;

/// <summary>
/// 登录端点：账号密码换令牌 + 当前用户查询。
/// 默认管理员由 <see cref="AuthService.EnsureSeed"/> 在启动时写入（admin / admin123）。
/// </summary>
public static class AuthEndpoints
{
    public static void MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/auth").WithTags("Auth");

        group.MapPost("/login", (LoginRequest? request, AuthService auth, HttpContext context) =>
        {
            if (request is null || string.IsNullOrWhiteSpace(request.Username) || string.IsNullOrEmpty(request.Password))
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, "请输入账号和密码", context.TraceIdentifier));
            }

            var result = auth.Login(request.Username, request.Password);
            if (!result.Ok)
            {
                return Results.Json(
                    ApiEnvelope<object>.Fail(ErrorCodes.AuthFailed, result.Error ?? "登录失败", context.TraceIdentifier),
                    statusCode: StatusCodes.Status401Unauthorized);
            }

            return Results.Ok(ApiEnvelope<object>.Ok(new
            {
                token = result.Token,
                expiresAt = result.ExpiresAt,
                user = new
                {
                    id = result.User!.Id,
                    username = result.User.Username,
                    displayName = result.User.DisplayName,
                    role = result.User.Role,
                },
            }, context.TraceIdentifier));
        });

        group.MapGet("/me", (HttpContext context) =>
        {
            var user = CurrentUser.From(context);
            return user is null
                ? Results.Json(
                    ApiEnvelope<object>.Fail(ErrorCodes.AuthFailed, "未登录", context.TraceIdentifier),
                    statusCode: StatusCodes.Status401Unauthorized)
                : Results.Ok(ApiEnvelope<object>.Ok(new
                {
                    id = user.Id,
                    username = user.Username,
                    displayName = user.DisplayName,
                    role = user.Role,
                }, context.TraceIdentifier));
        });

        // 令牌无状态：退出仅由客户端丢弃；保留端点便于前端统一调用与后续扩展吊销名单。
        group.MapPost("/logout", (HttpContext context) =>
            Results.Ok(ApiEnvelope<object>.Ok(new { loggedOut = true }, context.TraceIdentifier)));
    }
}

/// <summary>登录入参。</summary>
public sealed record LoginRequest(string? Username, string? Password);
