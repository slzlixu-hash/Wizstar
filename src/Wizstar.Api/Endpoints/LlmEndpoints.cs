using System.Diagnostics;
using System.Net.Http.Headers;
using Wizstar.Agents.Profiles;
using Wizstar.Agents.Runtime;
using Wizstar.Contracts;
using Wizstar.Data.Llm;

namespace Wizstar.Api.Endpoints;

// ── 请求体 DTO（全部字段可空，由端点逐项校验后抛契约错误码 40001）──────────────
public sealed record SaveProviderRequest(
    string? Code, string? Name, string? BaseUrl, string? ApiKey, string[]? Models);

public sealed record UpdateProviderRequest(string? Name, string? BaseUrl, bool? Enabled);

public sealed record ApiKeyRequest(string? ApiKey);

public sealed record AddModelRequest(string? ModelId, string? DisplayName);

public sealed record DefaultModelRequest(string? ProviderCode, string? ModelId);

public sealed record BindingsRequest(Dictionary<string, string>? Bindings);

/// <summary>
/// 系统设置 → 模型与 API Key：配置 CRUD + 运行时热切换。
///
/// 口径：
///  - 全部走统一信封；参数错误 40001，内置禁删同样 40001；存储异常由中间件归一化 50000；
///  - 任何写操作成功后都回一份完整快照，前端无需自行拼接局部状态；
///  - chatMode = live 只表示「已按配置装配真实 OpenAI 兼容客户端」，不表示已通过外网验证；
///    真实连通性由 POST /api/llm/test 的 /models 探测给出，失败显式标注，不伪造在线；
///  - API Key 明文只由 GET /api/llm/providers/{code}/api-key 主动取回，永远不进快照、不进日志；
///    列表与设置页只回显「头部 4 字符 + 掩码 + 尾部 4 字符」的 ApiKeyHint。
/// </summary>
public static class LlmEndpoints
{
    public static void MapLlmEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/llm").WithTags("Llm");

        // ── 只读聚合：设置页首屏 / 每次写操作后的回刷 ──────────────────────────
        group.MapGet("/settings", (
            LlmConfigStore store, AgentCatalog catalog, ChatClientProvider chat, HttpContext http) =>
            Results.Ok(ApiEnvelope<object>.Ok(
                BuildSnapshot(store, catalog, chat), http.TraceIdentifier)));

        // ── 供应商 ────────────────────────────────────────────────────────────
        group.MapPost("/providers", (
            SaveProviderRequest request, LlmConfigStore store, AgentCatalog catalog,
            ChatClientProvider chat, HttpContext http) =>
        {
            var name = Require(request.Name, "供应商名称不能为空");
            var baseUrl = Require(request.BaseUrl, "Base URL 不能为空");
            if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri)
                || uri.Scheme is not ("http" or "https"))
            {
                throw ApiException.Validation("Base URL 必须是 http/https 绝对地址（OpenAI 兼容端点）");
            }

            var code = NormalizeCode(request.Code);
            if (store.FindProvider(code) is not null)
            {
                throw ApiException.Validation($"供应商标识已存在: {code}");
            }

            store.CreateProvider(code, name, baseUrl, request.ApiKey, request.Models);
            return Snapshot(store, catalog, chat, http);
        });

        group.MapPut("/providers/{code}", (
            string code, UpdateProviderRequest request, LlmConfigStore store,
            AgentCatalog catalog, ChatClientProvider chat, HttpContext http) =>
        {
            RequireProvider(store, code);
            if (request.Name is null && request.BaseUrl is null && request.Enabled is null)
            {
                throw ApiException.Validation("没有需要更新的字段");
            }
            if (!string.IsNullOrWhiteSpace(request.BaseUrl)
                && (!Uri.TryCreate(request.BaseUrl, UriKind.Absolute, out var uri)
                    || uri.Scheme is not ("http" or "https")))
            {
                throw ApiException.Validation("Base URL 必须是 http/https 绝对地址");
            }

            store.UpdateProvider(code, request.Name, request.BaseUrl, request.Enabled);
            return Snapshot(store, catalog, chat, http);
        });

        group.MapDelete("/providers/{code}", (
            string code, LlmConfigStore store, AgentCatalog catalog,
            ChatClientProvider chat, HttpContext http) =>
        {
            // 内置供应商（DeepSeek）禁删；先删模型定义避免外键 RESTRICT。
            if (!store.DeleteProvider(code))
            {
                throw ApiException.Validation("供应商不存在，或为内置供应商不可删除");
            }
            return Snapshot(store, catalog, chat, http);
        });

        // ── API Key：写入只落密文，明文需主动取回 ───────────────────────────────
        group.MapPut("/providers/{code}/api-key", (
            string code, ApiKeyRequest request, LlmConfigStore store,
            AgentCatalog catalog, ChatClientProvider chat, HttpContext http) =>
        {
            RequireProvider(store, code);
            store.SetApiKey(code, request.ApiKey);
            return Snapshot(store, catalog, chat, http);
        });

        group.MapGet("/providers/{code}/api-key", (
            string code, LlmConfigStore store, HttpContext http) =>
        {
            RequireProvider(store, code);
            var data = new { apiKey = store.GetApiKey(code) };
            return Results.Ok(ApiEnvelope<object>.Ok(data, http.TraceIdentifier));
        });

        // ── 支持模型 ──────────────────────────────────────────────────────────
        group.MapPost("/providers/{code}/models", (
            string code, AddModelRequest request, LlmConfigStore store,
            AgentCatalog catalog, ChatClientProvider chat, HttpContext http) =>
        {
            RequireProvider(store, code);
            var modelId = Require(request.ModelId, "模型 ID 不能为空");
            store.AddModel(code, modelId, request.DisplayName);
            return Snapshot(store, catalog, chat, http);
        });

        group.MapDelete("/providers/{code}/models", (
            string code, string? modelId, LlmConfigStore store,
            AgentCatalog catalog, ChatClientProvider chat, HttpContext http) =>
        {
            RequireProvider(store, code);
            var id = Require(modelId, "缺少 modelId 查询参数");
            if (!store.DeleteModel(code, id))
            {
                throw ApiException.Validation($"模型不存在: {id}");
            }
            return Snapshot(store, catalog, chat, http);
        });

        // ── 默认模型 / Agent 分派 ──────────────────────────────────────────────
        group.MapPut("/default-model", (
            DefaultModelRequest request, LlmConfigStore store,
            AgentCatalog catalog, ChatClientProvider chat, HttpContext http) =>
        {
            var modelId = Require(request.ModelId, "请选择默认模型");
            var exists = store.ListModels().Any(m => m.ModelId == modelId
                && (string.IsNullOrWhiteSpace(request.ProviderCode)
                    || m.ProviderCode == request.ProviderCode));
            if (!exists) throw ApiException.Validation($"默认模型不存在: {modelId}");

            store.SetDefaultModel(request.ProviderCode, modelId);
            return Snapshot(store, catalog, chat, http);
        });

        group.MapPut("/bindings", (
            BindingsRequest request, LlmConfigStore store,
            AgentCatalog catalog, ChatClientProvider chat, HttpContext http) =>
        {
            if (request.Bindings is null || request.Bindings.Count == 0)
            {
                throw ApiException.Validation("缺少 Agent 模型分派映射");
            }
            store.SaveBindings(request.Bindings);
            return Snapshot(store, catalog, chat, http);
        });

        // ── 连通性：GET {baseUrl}/models（只探连通与鉴权，不发起计费推理）────────
        group.MapPost("/test", async (
            IHttpClientFactory factory, LlmConfigStore store, CancellationToken ct) =>
        {
            var settings = store.GetCurrent();
            if (settings is null)
            {
                return Results.Ok(ApiEnvelope<object>.Ok(new
                {
                    reachable = false,
                    reason = "配置不完整：请设置默认模型并配置供应商 API Key",
                    endpoint = (string?)null,
                    model = (string?)null
                }, "llm/test"));
            }

            var client = factory.CreateClient("llm");
            client.Timeout = TimeSpan.FromSeconds(8);
            using var request = new HttpRequestMessage(
                HttpMethod.Get, settings.BaseUrl.TrimEnd('/') + "/models");
            if (!string.IsNullOrWhiteSpace(settings.ApiKey))
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", settings.ApiKey);
            }

            var stopwatch = Stopwatch.StartNew();
            try
            {
                using var response = await client.SendAsync(request, ct).ConfigureAwait(false);
                stopwatch.Stop();
                return Results.Ok(ApiEnvelope<object>.Ok(new
                {
                    reachable = response.IsSuccessStatusCode,
                    status = (int)response.StatusCode,
                    elapsedMs = stopwatch.ElapsedMilliseconds,
                    endpoint = settings.BaseUrl,
                    model = settings.Model,
                    reason = response.IsSuccessStatusCode
                        ? "握手成功（/models 可用）"
                        : $"服务返回 HTTP {(int)response.StatusCode}"
                }, "llm/test"));
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException)
            {
                stopwatch.Stop();
                return Results.Ok(ApiEnvelope<object>.Ok(new
                {
                    reachable = false,
                    status = 0,
                    elapsedMs = stopwatch.ElapsedMilliseconds,
                    endpoint = settings.BaseUrl,
                    model = settings.Model,
                    reason = $"连接失败: {ex.Message}"
                }, "llm/test"));
            }
        });
    }

    // ─────────────────────────────────────────────────────────────────────────

    private static IResult Snapshot(
        LlmConfigStore store, AgentCatalog catalog, ChatClientProvider chat, HttpContext http) =>
        Results.Ok(ApiEnvelope<object>.Ok(BuildSnapshot(store, catalog, chat), http.TraceIdentifier));

    private static object BuildSnapshot(LlmConfigStore store, AgentCatalog catalog, ChatClientProvider chat)
    {
        var providers = store.ListProviders();
        var models = store.ListModels();
        var bindings = store.ListBindings()
            .GroupBy(b => b.AgentKey, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.First().ModelId, StringComparer.OrdinalIgnoreCase);
        var defaultModel = models.FirstOrDefault(m => m.IsDefaultGlobal && m.Enabled)?.ModelId;

        var providerViews = providers.Select(p => new
        {
            code = p.ProviderCode,
            name = p.DisplayName,
            baseUrl = p.BaseUrl,
            apiKeyHint = p.ApiKeyHint,
            hasKey = p.ApiKeyCipher is { Length: > 0 },
            isSeed = p.IsSeed,
            enabled = p.Enabled,
            models = models.Where(m => m.ProviderCode == p.ProviderCode)
                .Select(m => new { id = m.ModelId, name = m.DisplayName }).ToArray()
        }).ToArray();

        var modelViews = models.Select(m => new
        {
            id = m.Id,
            providerCode = m.ProviderCode,
            modelId = m.ModelId,
            name = m.DisplayName,
            isDefault = m.IsDefaultGlobal,
            enabled = m.Enabled
        }).ToArray();

        var agentViews = catalog.GetAll().Select(p => new
        {
            agentId = p.Key,
            label = p.DisplayName,
            model = bindings.TryGetValue(p.Key, out var bound) ? bound : defaultModel
        }).ToArray();

        return new
        {
            providers = providerViews,
            models = modelViews,
            modelOptions = models.Where(m => m.Enabled).Select(m => m.ModelId).Distinct().ToArray(),
            defaultModel,
            bindings = agentViews,
            chatMode = chat.Mode,
            chatOfflineReason = chat.OfflineReason,
            providerCount = providers.Count
        };
    }

    private static string Require(string? value, string message)
    {
        if (string.IsNullOrWhiteSpace(value)) throw ApiException.Validation(message);
        return value.Trim();
    }

    private static void RequireProvider(LlmConfigStore store, string code)
    {
        if (string.IsNullOrWhiteSpace(code) || store.FindProvider(code) is null)
        {
            throw ApiException.Validation($"供应商不存在: {code}");
        }
    }

    /// <summary>未指定 code 时生成稳定唯一的 custom-xxxxxxxx；显式指定时做 ASCII 规范化。</summary>
    private static string NormalizeCode(string? code)
    {
        if (string.IsNullOrWhiteSpace(code))
        {
            return "custom-" + Guid.NewGuid().ToString("N")[..8];
        }

        var normalized = new string(code.Trim().ToLowerInvariant()
            .Select(ch => char.IsAsciiLetterOrDigit(ch) ? ch : '-').ToArray());
        var cleaned = string.Join('-', normalized.Split('-', StringSplitOptions.RemoveEmptyEntries));
        if (string.IsNullOrEmpty(cleaned)) cleaned = "custom";
        return cleaned.Length > 32 ? cleaned[..32] : cleaned;
    }
}
