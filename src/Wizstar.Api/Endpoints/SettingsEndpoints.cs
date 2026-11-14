using Microsoft.AspNetCore.Mvc;
using Wizstar.Agents.Governance;
using Wizstar.Contracts;
using Wizstar.Data.Settings;

namespace Wizstar.Api.Endpoints;

/// <summary>
/// 系统设置端点：全局业务风控 + 环境与网络配置。
///
/// 与模型/API Key（<see cref="LlmEndpoints"/>）并列，共同承载「系统设置」三个 Tab。
/// 全部配置真实落库（`sys_risk_policy`）或读取真实运行时配置，不做演示兜底。
/// </summary>
public static class SettingsEndpoints
{
    /// <summary>风控等级元数据：与 <see cref="RiskLevels"/> 的三级一一对应，界面文案集中在服务端。</summary>
    private static readonly RiskMeta[] RiskCatalog =
    [
        new(RiskLevels.Read, "只读操作", "L1 · Read", "green",
            "查询、拉取、预览类工具，结果写入操作账本。关闭后连读取也要人工放行。", true, false),
        new(RiskLevels.Write, "写入操作", "L2 · Write", "cyan",
            "创建 / 修改业务对象，执行前校验幂等键。关闭后写操作同样进入人工审批队列。", true, false),
        new(RiskLevels.Irreversible, "不可逆操作", "L3 · Irreversible", "rose",
            "下架、退款、删除等操作强制挂起人工审批（HITL）。服务端从不自动批准，此项不可关闭。", false, true),
    ];

    /// <summary>环境与网络开关元数据；RealTime=false 表示修改后需重启进程才生效。</summary>
    private static readonly ToggleMeta[] ToggleCatalog =
    [
        new("auto-handshake", "启动自动握手 MCP 服务",
            "读取 mcp-services.json 后自动握手并缓存工具清单；关闭后仅登记不握手。", true, true),
        new("loopback-bypass", "本地回环直连（绕过系统代理）",
            "HTTP_PROXY 存在时，127.0.0.1 请求不经过代理。该项在进程启动时装配。", true, false),
    ];

    private sealed record RiskMeta(
        string Id, string Title, string Level, string Tone,
        string Description, bool DefaultAuto, bool Locked);

    private sealed record ToggleMeta(
        string Id, string Label, string Desc, bool DefaultChecked, bool RealTime);

    public static void MapSettingsEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/settings").WithTags("Settings");

        /* ------------------------------ 全局业务风控 ------------------------------ */
        group.MapGet("/risk", (RuntimeSettingsStore settings) =>
            Results.Ok(ApiEnvelope<object>.Ok(new { riskPolicy = BuildRisk(settings) }, string.Empty)));

        group.MapPut("/risk/{id}", (
            string id,
            [FromBody] FlagRequest request,
            RuntimeSettingsStore settings) =>
        {
            var meta = RiskCatalog.FirstOrDefault(r => string.Equals(r.Id, id, StringComparison.OrdinalIgnoreCase));
            if (meta is null)
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"未知风险等级: {id}", string.Empty));
            }

            if (meta.Locked)
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.PermissionDenied,
                    $"{meta.Level} 为平台强制人工审批等级，不允许关闭", string.Empty));
            }

            if (request.Auto is null)
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, "缺少字段 auto（true=自动执行 / false=需人工审批）", string.Empty));
            }

            var ok = settings.SetFlag(RuntimeSettingsStore.RiskKey(meta.Id), meta.Title, meta.Description, request.Auto.Value);
            if (!ok)
            {
                return Results.Json(
                    ApiEnvelope<object>.Fail(ErrorCodes.InternalError, "配置写入失败，请检查数据库连接", string.Empty),
                    statusCode: StatusCodes.Status500InternalServerError);
            }

            return Results.Ok(ApiEnvelope<object>.Ok(new { riskPolicy = BuildRisk(settings) }, string.Empty));
        });

        /* ------------------------------ 环境与网络配置 ------------------------------ */
        group.MapGet("/environment", (
            RuntimeSettingsStore settings,
            IConfiguration configuration) =>
            Results.Ok(ApiEnvelope<object>.Ok(new
            {
                environment = BuildEnvironment(configuration),
                toggles = BuildToggles(settings),
            }, string.Empty)));

        group.MapPut("/environment/{id}", (
            string id,
            [FromBody] FlagRequest request,
            RuntimeSettingsStore settings) =>
        {
            var meta = ToggleCatalog.FirstOrDefault(t => string.Equals(t.Id, id, StringComparison.OrdinalIgnoreCase));
            if (meta is null)
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"未知配置项: {id}", string.Empty));
            }

            if (request.Checked is null)
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, "缺少字段 checked（true=开启 / false=关闭）", string.Empty));
            }

            var ok = settings.SetFlag(RuntimeSettingsStore.ToggleKey(meta.Id), meta.Label, meta.Desc, request.Checked.Value);
            if (!ok)
            {
                return Results.Json(
                    ApiEnvelope<object>.Fail(ErrorCodes.InternalError, "配置写入失败，请检查数据库连接", string.Empty),
                    statusCode: StatusCodes.Status500InternalServerError);
            }

            return Results.Ok(ApiEnvelope<object>.Ok(new
            {
                toggles = BuildToggles(settings),
                effective = meta.RealTime ? "已实时生效" : "需重启进程生效",
            }, string.Empty));
        });
    }

    private static object[] BuildRisk(RuntimeSettingsStore settings)
    {
        var rows = settings.All();
        return RiskCatalog.Select(meta =>
        {
            var stored = rows.FirstOrDefault(r =>
                string.Equals(r.PolicyKey, RuntimeSettingsStore.RiskKey(meta.Id), StringComparison.Ordinal));
            var auto = stored is null ? meta.DefaultAuto : ParseFlag(stored.PolicyValue, meta.DefaultAuto);
            // 锁定项强制回落到「需人工审批」，即使库里被手工改成 auto 也不生效。
            if (meta.Locked)
            {
                auto = false;
            }

            return (object)new
            {
                id = meta.Id,
                title = meta.Title,
                level = meta.Level,
                tone = meta.Tone,
                desc = meta.Description,
                auto,
                locked = meta.Locked,
            };
        }).ToArray();
    }

    private static object[] BuildToggles(RuntimeSettingsStore settings)
    {
        var rows = settings.All();
        return ToggleCatalog.Select(meta =>
        {
            var stored = rows.FirstOrDefault(r =>
                string.Equals(r.PolicyKey, RuntimeSettingsStore.ToggleKey(meta.Id), StringComparison.Ordinal));
            var value = stored is null ? meta.DefaultChecked : ParseFlag(stored.PolicyValue, meta.DefaultChecked);
            return (object)new
            {
                id = meta.Id,
                label = meta.Label,
                desc = meta.Desc + (meta.RealTime ? string.Empty : "（重启生效）"),
                @checked = value,
                realTime = meta.RealTime,
            };
        }).ToArray();
    }

    private static object[] BuildEnvironment(IConfiguration configuration)
    {
        var endpoint = configuration["Ui:Endpoint"] ?? "127.0.0.1:5301";
        var heartbeat = configuration["Mcp:HealthIntervalSeconds"] ?? "15";
        var ledgerPath = configuration["Ledger:Path"] ?? "data/ledger.db";
        var db = MaskConnection(configuration["Database:MySql"] ?? string.Empty);

        return
        [
            new { label = "API 监听地址", value = NormalizeEndpoint(endpoint), note = "本机回环，不对外监听（launchSettings 已关闭自动打开浏览器）" },
            new { label = "MCP 心跳间隔", value = $"{heartbeat}s", note = "离线自动剔除工具，恢复自动补回" },
            new { label = "MCP 握手超时", value = "10s", note = "握手 + tools/list 的硬超时，超时置为异常状态" },
            new { label = "操作账本", value = $"SQLite WAL · {ledgerPath}", note = "幂等回放 / 防篡改校验" },
            new { label = "业务数据库", value = db, note = "MySQL · CodeFirst 建表（只增不改）" },
        ];
    }

    private static string NormalizeEndpoint(string endpoint) =>
        endpoint.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
        endpoint.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
            ? endpoint
            : "http://" + endpoint;

    /// <summary>连接串脱敏：只保留 server/port/database/user，密码一律掩码。</summary>
    private static string MaskConnection(string connectionString)
    {
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            return "未配置";
        }

        var parts = connectionString
            .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(p =>
            {
                var idx = p.IndexOf('=', StringComparison.Ordinal);
                if (idx <= 0)
                {
                    return p;
                }

                var key = p[..idx].Trim();
                var value = p[(idx + 1)..].Trim();
                return key.ToLowerInvariant() is "password" or "pwd"
                    ? $"{key}=****"
                    : $"{key}={value}";
            });

        return string.Join("; ", parts);
    }

    private static bool ParseFlag(string? raw, bool fallback) =>
        (raw ?? string.Empty).Trim().ToLowerInvariant() switch
        {
            "auto" or "on" or "true" or "1" or "yes" => true,
            "manual" or "off" or "false" or "0" or "no" => false,
            _ => fallback,
        };
}

/// <summary>
/// 风控 / 开关的统一写入请求体：两个字段可空，端点按自身语义取用。
/// 用可空类型而非 bool，是为了区分「未提交」与「显式关闭」——否则漏传字段会被静默当成 false。
/// </summary>
public sealed record FlagRequest(bool? Auto, bool? Checked);
