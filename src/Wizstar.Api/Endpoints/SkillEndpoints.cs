using Wizstar.Agents.Skills;
using Wizstar.Agents.Tools;
using Wizstar.Api.Skills;
using Wizstar.Contracts;

namespace Wizstar.Api.Endpoints;

/// <summary>
/// Skill 管理端点：技能目录（YAML 热加载）+ 双模编辑器保存 / 启停 / 删除 / YAML 双向转换。
/// </summary>
public static class SkillEndpoints
{
    public static void MapSkillEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/skills").WithTags("Skills");

        group.MapGet("/", (string? agent, SkillCatalog catalog, HttpContext context) =>
        {
            var skills = catalog.All();
            if (!string.IsNullOrWhiteSpace(agent))
            {
                skills = skills
                    .Where(s => string.Equals(s.Agent, agent.Trim(), StringComparison.OrdinalIgnoreCase))
                    .ToList();
            }
            return Results.Ok(ApiEnvelope<object>.Ok(new
            {
                skills,
                issues = catalog.Issues,
                directory = catalog.Directory,
            }, context.TraceIdentifier));
        });

        /* 工具切片目录：内置 + 全部 MCP 工具，供可视化勾选。 */
        group.MapGet("/tools", (IEnumerable<IToolProvider> providers, HttpContext context) =>
        {
            var tools = providers
                .SelectMany(p => p.ListTools())
                .Select(t => new
                {
                    serverId = t.ServerId,
                    name = t.Name,
                    canonical = t.ServerId + "." + t.Name,
                    description = t.Description,
                    declaredRisk = t.DeclaredRisk,
                })
                .OrderBy(t => t.serverId)
                .ThenBy(t => t.name)
                .ToList();
            return Results.Ok(ApiEnvelope<object>.Ok(tools, context.TraceIdentifier));
        });

        group.MapGet("/{code}", (string code, SkillCatalog catalog, HttpContext context) =>
        {
            var skill = catalog.Get(code);
            return skill is null
                ? Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"Skill 不存在: {code}", context.TraceIdentifier))
                : Results.Ok(ApiEnvelope<object>.Ok(skill, context.TraceIdentifier));
        });

        group.MapGet("/{code}/yaml", (string code, SkillCatalog catalog, SkillStore store, HttpContext context) =>
        {
            var skill = catalog.Get(code);
            return skill is null
                ? Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"Skill 不存在: {code}", context.TraceIdentifier))
                : Results.Ok(ApiEnvelope<object>.Ok(new { yaml = store.PreviewYaml(skill) }, context.TraceIdentifier));
        });

        group.MapPost("/", (SkillDefinition? draft, SkillStore store, HttpContext context) =>
        {
            if (draft is null)
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, "缺少 Skill 配置", context.TraceIdentifier));
            }
            var saved = store.Create(draft);
            return Results.Ok(ApiEnvelope<object>.Ok(saved, context.TraceIdentifier));
        });

        group.MapPut("/{code}", (string code, SkillDefinition? draft, SkillStore store, HttpContext context) =>
        {
            if (draft is null)
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, "缺少 Skill 配置", context.TraceIdentifier));
            }
            var saved = store.Update(code, draft);
            return Results.Ok(ApiEnvelope<object>.Ok(saved, context.TraceIdentifier));
        });

        group.MapDelete("/{code}", (string code, SkillStore store, HttpContext context) =>
        {
            var removed = store.Delete(code);
            return removed
                ? Results.Ok(ApiEnvelope<object>.Ok(new { code, removed = true }, context.TraceIdentifier))
                : Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"Skill 不存在: {code}", context.TraceIdentifier));
        });

        group.MapPost("/{code}/toggle", (string code, SkillToggleRequest? request, SkillStore store, HttpContext context) =>
        {
            var skill = store.SetEnabled(code, request?.Enabled ?? true);
            return Results.Ok(ApiEnvelope<object>.Ok(skill, context.TraceIdentifier));
        });

        group.MapPost("/preview", (SkillDefinition? draft, SkillStore store, HttpContext context) =>
        {
            if (draft is null)
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, "缺少 Skill 配置", context.TraceIdentifier));
            }
            return Results.Ok(ApiEnvelope<object>.Ok(
                new { yaml = store.PreviewYaml(draft) }, context.TraceIdentifier));
        });

        group.MapPost("/parse", (SkillParseRequest? request, SkillCatalog catalog, HttpContext context) =>
        {
            var parsed = catalog.Parse(request?.Yaml ?? string.Empty, out var error);
            return parsed is null
                ? Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, error ?? "YAML 解析失败", context.TraceIdentifier))
                : Results.Ok(ApiEnvelope<object>.Ok(SkillRules.Normalize(parsed), context.TraceIdentifier));
        });

        group.MapPost("/import", (SkillParseRequest? request, SkillStore store, HttpContext context) =>
        {
            var saved = store.Import(request?.Yaml);
            return Results.Ok(ApiEnvelope<object>.Ok(saved, context.TraceIdentifier));
        });
    }
}

public sealed record SkillToggleRequest(bool? Enabled);

public sealed record SkillParseRequest(string? Yaml);
