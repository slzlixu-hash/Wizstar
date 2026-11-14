using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using Wizstar.Agents.Governance;
using Wizstar.Agents.Ledger;
using Wizstar.Agents.Profiles;
using Wizstar.Agents.Runtime;
using Wizstar.Contracts;
using Wizstar.Mcp;

namespace Wizstar.Api.Endpoints;

/// <summary>
/// Agent 端点：名册查询 + 对话（SSE 流式 / JSON 兜底）。
/// </summary>
public static class AgentEndpoints
{
    /// <summary>SSE 事件序列化选项（缓存复用，避免每次序列化都新建实例）。</summary>
    private static readonly JsonSerializerOptions SseJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public static void MapAgentEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/agents").WithTags("Agents");

        group.MapGet("/", (AgentCatalog catalog) =>
        {
            var data = catalog.GetAll().Select(profile => new
            {
                key = profile.Key,
                name = profile.Name,
                displayName = profile.DisplayName,
                description = profile.Description,
                enabled = profile.Enabled,
                maxSteps = profile.MaxSteps,
                allowedTools = profile.AllowedTools,
                systemPromptPreview = profile.SystemPrompt.Length > 120
                    ? profile.SystemPrompt[..120] + "…"
                    : profile.SystemPrompt
            });
            return Results.Ok(ApiEnvelope<object>.Ok(data, string.Empty));
        });

        /* Agent 团队统计：名册在线数 + 操作账本近 7 日真实调用与成功率。
           不伪造「今日调用量」——账本只记副作用操作，读操作不计入，故口径写明「账本操作」。 */
        group.MapGet("/stats", async (AgentCatalog catalog, OperationLedger ledger, CancellationToken ct) =>
        {
            var profiles = catalog.GetAll().ToList();
            var enabled = profiles.Count(p => p.Enabled);

            IReadOnlyList<LedgerRecord> records;
            try
            {
                records = await ledger.ListSinceAsync(
                    new DateTimeOffset(DateTime.Today.AddDays(-6)), 1000, ct).ConfigureAwait(false);
            }
            catch (Exception)
            {
                records = [];
            }

            var succeeded = records.Count(r =>
                string.Equals(r.Status, "SUCCEEDED", StringComparison.OrdinalIgnoreCase));
            var rate = records.Count > 0
                ? (succeeded * 100.0 / records.Count).ToString("F1", System.Globalization.CultureInfo.InvariantCulture) + "%"
                : "—";

            var stats = new object[]
            {
                new
                {
                    label = "在线 Agent",
                    value = $"{enabled} / {profiles.Count}",
                    suffix = enabled == profiles.Count ? "全部就绪" : $"{profiles.Count - enabled} 位已停用",
                    dot = enabled > 0 ? "online" : "offline",
                },
                new
                {
                    label = "近 7 日账本操作",
                    value = records.Count.ToString("N0", System.Globalization.CultureInfo.InvariantCulture),
                    suffix = "次",
                },
                new
                {
                    label = "执行成功率",
                    value = rate,
                    suffix = records.Count > 0 ? "来自操作账本" : "暂无记录",
                },
            };

            return Results.Ok(ApiEnvelope<object>.Ok(new { stats, total = profiles.Count, enabled }, string.Empty));
        });

        /* 单个 Agent 完整配置（含完整 systemPrompt，供「查看配置」使用）。 */
        group.MapGet("/{key}", (string key, AgentCatalog catalog) =>
        {
            var profile = catalog.Find(key);
            if (profile is null)
            {
                return Results.NotFound(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, $"名册中不存在 Agent: {key}", string.Empty));
            }

            return Results.Ok(ApiEnvelope<object>.Ok(new
            {
                key = profile.Key,
                name = profile.Name,
                displayName = profile.DisplayName,
                description = profile.Description,
                enabled = profile.Enabled,
                maxSteps = profile.MaxSteps,
                allowedTools = profile.AllowedTools,
                systemPrompt = profile.SystemPrompt,
            }, string.Empty));
        });

        group.MapPost("/{key}/chat", async (
            string key,
            ChatRequest request,
            HttpContext http,
            AgentRunner runner,
            ConversationStore conversations,
            CancellationToken ct) =>
        {
            var options = new AgentRunOptions(
                key,
                conversations.NormalizeConversationId(request.ConversationId),
                request.Message ?? string.Empty);

            // JSON 直连（非流式）：测试与脚本优先
            var accept = http.Request.Headers.Accept.ToString();
            if (!accept.Contains("text/event-stream", StringComparison.OrdinalIgnoreCase))
            {
                var result = await runner.RunAsync(options, ct).ConfigureAwait(false);
                return Results.Ok(ApiEnvelope<AgentRunResult>.Ok(result, http.TraceIdentifier));
            }

            // SSE 流式：meta → tool → delta* → done
            http.Response.StatusCode = StatusCodes.Status200OK;
            http.Response.ContentType = "text/event-stream; charset=utf-8";
            http.Response.Headers.CacheControl = "no-cache";

            await foreach (var e in runner.StreamAsync(options, ct).ConfigureAwait(false))
            {
                var (name, payload) = e switch
                {
                    AgentRunEvent.Meta m => ("meta", JsonSerializer.Serialize(new
                    {
                        agentKey = m.AgentKey,
                        conversationId = m.ConversationId,
                        mode = m.Mode,
                        offlineReason = m.OfflineReason,
                        assembledTools = m.AssembledTools
                    })),
                    AgentRunEvent.ToolEvent t => ("tool", JsonSerializer.Serialize(t.Trace, SseJsonOptions)),
                    AgentRunEvent.Delta d => ("delta", JsonSerializer.Serialize(new { text = d.Text })),
                    AgentRunEvent.Done done => ("done", JsonSerializer.Serialize(done.Result, SseJsonOptions)),
                    _ => ("event", "{}")
                };

                await http.Response.WriteAsync($"event: {name}\ndata: {payload}\n\n", Encoding.UTF8, ct).ConfigureAwait(false);
                await http.Response.Body.FlushAsync(ct).ConfigureAwait(false);
            }

            return Results.Empty;
        });
    }
}

public sealed record ChatRequest(string? Message, string? ConversationId);

/// <summary>
/// 审批端点（HITL）：列出 / 批准 / 拒绝。
/// 口径：服务端从不自动批准；批准后不自动执行——下一次携带相同 operationId 的调用才真正执行。
/// </summary>
public static class ApprovalEndpoints
{
    public static void MapApprovalEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/approvals").WithTags("Approvals");

        group.MapGet("/", (IApprovalStore store, string? status, int? limit) =>
        {
            var data = store.List(status, Math.Clamp(limit ?? 100, 1, 500));
            return Results.Ok(ApiEnvelope<object>.Ok(data, string.Empty));
        });

        group.MapGet("/{id:guid}", (IApprovalStore store, Guid id) =>
        {
            var approval = store.GetById(id);
            return approval is null
                ? Results.NotFound(ApiEnvelope<object>.Fail(ErrorCodes.ValidationError, $"审批单不存在: {id}", string.Empty))
                : Results.Ok(ApiEnvelope<object>.Ok(approval, string.Empty));
        });

        group.MapPost("/{id:guid}/{decision:regex(^(approve|reject)$)}", (
            IApprovalStore store, Guid id, string decision, [FromBody] DecisionRequest? request) =>
        {
            var status = decision == "approve" ? ApprovalStatus.Approved : ApprovalStatus.Rejected;
            var decided = store.Decide(id, status, request?.Note);
            return decided is null
                ? Results.Conflict(ApiEnvelope<object>.Fail(
                    ErrorCodes.BusinessRejected, $"审批单不存在或已决策: {id}", string.Empty))
                : Results.Ok(ApiEnvelope<object>.Ok(decided, string.Empty));
        });
    }
}

public sealed record DecisionRequest(string? Note);

/// <summary>
/// MCP 即插即用端点：服务快照 / 对账 / 单服务握手 / 工具清单。
/// </summary>
public static class McpEndpoints
{
    public static void MapMcpEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/mcp").WithTags("Mcp");

        group.MapGet("/servers", (McpCatalog catalog) =>
            Results.Ok(ApiEnvelope<object>.Ok(catalog.ListSnapshots(), string.Empty)));

        group.MapGet("/tools", (McpToolProvider provider) =>
            Results.Ok(ApiEnvelope<object>.Ok(provider.ListTools(), string.Empty)));

        group.MapPost("/reconcile", async (McpReconciler reconciler, CancellationToken ct) =>
        {
            var summary = await reconciler.ReconcileAsync(ct).ConfigureAwait(false);
            return Results.Ok(ApiEnvelope<McpReconcileSummary>.Ok(summary, string.Empty));
        });

        group.MapPost("/servers/{id}/handshake", async (string id, McpCatalog catalog, McpReconciler reconciler, CancellationToken ct) =>
        {
            if (catalog.GetConfig(id) is null)
            {
                return Results.NotFound(ApiEnvelope<object>.Fail(ErrorCodes.ValidationError, $"清单中未声明服务: {id}", string.Empty));
            }

            var ok = await reconciler.HandshakeAsync(id, ct).ConfigureAwait(false);
            var snapshot = catalog.ListSnapshots().FirstOrDefault(s => s.Id == id);
            // 握手成功但读不到快照说明状态槽异常，如实报错而不是返回 null 冒充成功
            return ok && snapshot is not null
                ? Results.Ok(ApiEnvelope<object>.Ok(snapshot, string.Empty))
                : Results.Json(
                    ApiEnvelope<object>.Fail(
                        ErrorCodes.NetworkError,
                        ok ? "握手完成但未能读取服务快照" : catalog.GetState(id)?.LastError ?? "握手失败",
                        string.Empty),
                    statusCode: StatusCodes.Status502BadGateway);
        });

        // ── 管理界面写入：声明式清单 CRUD + 运行时停用 + 只读调试直调 ──────────
        group.MapPost("/servers", (McpServerUpsertRequest request, McpCatalog catalog, McpReconciler reconciler, CancellationToken ct) =>
            CreateServerAsync(request, catalog, reconciler, ct));
        group.MapPut("/servers/{id}", (string id, McpServerUpsertRequest request, McpCatalog catalog, McpReconciler reconciler, CancellationToken ct) =>
            UpdateServerAsync(id, request, catalog, reconciler, ct));
        group.MapDelete("/servers/{id}", (string id, McpCatalog catalog) => DeleteServer(id, catalog));
        group.MapPost("/servers/{id}/disconnect", (string id, McpCatalog catalog) => DisconnectServer(id, catalog));
        group.MapPost("/tools/call", (McpToolCallRequest request, McpCatalog catalog, McpToolProvider provider, CancellationToken ct) =>
            CallToolAsync(request, catalog, provider, ct));

        // ── 调试辅助：后端生成可直接粘贴的 cURL（密钥不回显前端；HMAC 即签即用，5 分钟有效）──
        group.MapGet("/servers/{id}/debug-curl", (string id, string? tool, McpCatalog catalog) =>
            BuildDebugCurl(id, tool, catalog));
    }

    private static IResult BuildDebugCurl(string id, string? tool, McpCatalog catalog)
    {
        var config = catalog.GetConfig(id);
        if (config is null)
        {
            return Fail(ErrorCodes.ValidationError, $"清单中未声明服务: {id}", StatusCodes.Status404NotFound);
        }
        if (string.IsNullOrWhiteSpace(config.Url))
        {
            return Fail(ErrorCodes.ValidationError, $"服务 {id} 未配置 URL", StatusCodes.Status400BadRequest);
        }

        var url = config.Url.TrimEnd('/') + "/mcp";
        var path = new Uri(url).AbsolutePath;
        // HMAC 签名与请求体字节绑定：cURL 里的 --data 必须与签名时的 body 一字不差
        var body = string.IsNullOrWhiteSpace(tool)
            ? "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}"
            : "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":"
                + JsonSerializer.Serialize(tool.Trim()) + ",\"arguments\":{}}}";

        var headerLines = new List<string>();
        var note = "免鉴权模式：无需任何凭证头。";
        switch (config.EffectiveAuthType)
        {
            case McpAuthTypes.Bearer:
                headerLines.Add($"-H {ShellQuote("Authorization: Bearer " + config.AuthSecret)}");
                note = "Bearer 模式：命令中包含 API Key 明文，注意不要粘贴到公开场合。";
                break;
            case McpAuthTypes.Header:
                var name = string.IsNullOrWhiteSpace(config.AuthHeaderName) ? "X-Api-Key" : config.AuthHeaderName!.Trim();
                headerLines.Add($"-H {ShellQuote($"{name}: {config.AuthSecret}")}");
                note = $"自定义 Header 模式（{name}）：命令中包含 Key 明文，注意保密。";
                break;
            case McpAuthTypes.Hmac:
                var authorization = McpHmacSigner.BuildAuthorizationHeader(config.AuthKeyId!, config.AuthSecret!, "POST", path, body);
                headerLines.Add($"-H {ShellQuote("Authorization: " + authorization)}");
                note = "MCP-HMAC 模式：签名与该请求体绑定，±300 秒时间窗内有效，过期请重新生成。";
                break;
        }

        var headers = string.Join(" ", headerLines.Prepend("-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream'"));
        var curl = $"curl -sS -X POST {ShellQuote(url)} {headers} --data {ShellQuote(body)}";
        return Results.Ok(ApiEnvelope<object>.Ok(new
        {
            id,
            authType = config.EffectiveAuthType,
            curl,
            note
        }, string.Empty));
    }

    /// <summary>POSIX shell 单引号包裹（内部单引号转义为 '\''），保证命令可整段粘贴执行。</summary>
    private static string ShellQuote(string value) =>
        "'" + (value ?? string.Empty).Replace("'", "'\\''") + "'";

    private static IResult Fail(int code, string message, int status) =>
        Results.Json(ApiEnvelope<object>.Fail(code, message, string.Empty), statusCode: status);

    private static string? ValidateUpsert(McpServerUpsertRequest request, McpServiceConfig? existing)
    {
        var id = McpCatalog.NormalizeId(request.Id);
        if (!Regex.IsMatch(id, "^[a-z0-9][a-z0-9._-]{0,63}$"))
        {
            return "服务 ID 只允许小写字母 / 数字 / ._-，且以字母或数字开头（最长 64 位）";
        }
        if (string.IsNullOrWhiteSpace(request.Name)) return "服务名称不能为空";

        var transport = string.IsNullOrWhiteSpace(request.Transport) ? "http" : request.Transport.Trim().ToLowerInvariant();
        if (!string.Equals(transport, "http", StringComparison.Ordinal))
        {
            return "本期仅支持 http 传输（stdio 托管启动未实现）";
        }
        if (string.IsNullOrWhiteSpace(request.Url)) return "传输地址 URL 不能为空";
        if (!Uri.TryCreate(request.Url.Trim(), UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            return "传输地址必须是合法的 http(s) URL";
        }

        // 鉴权模式校验：显式提交优先，未提交沿用清单旧值（编辑时留空凭证 = 沿用）
        var rawAuthType = request.AuthType ?? existing?.AuthType;
        if (!string.IsNullOrWhiteSpace(request.AuthType)
            && !Regex.IsMatch(request.AuthType.Trim(), "^(none|bearer|header|hmac)$", RegexOptions.IgnoreCase))
        {
            return "鉴权模式只支持 none / bearer / header / hmac";
        }

        var hasKeyId = !string.IsNullOrWhiteSpace(request.AuthKeyId) || !string.IsNullOrWhiteSpace(existing?.AuthKeyId);
        var hasSecret = !string.IsNullOrWhiteSpace(request.AuthSecret) || !string.IsNullOrWhiteSpace(existing?.AuthSecret);
        var authType = McpAuthTypes.Normalize(rawAuthType, hasKeyId && hasSecret);

        if (authType == McpAuthTypes.Hmac && !hasKeyId)
        {
            return "MCP-HMAC 模式需要填写 Key ID";
        }
        if (authType != McpAuthTypes.None && !hasSecret)
        {
            return authType == McpAuthTypes.Hmac ? "MCP-HMAC 模式需要填写 Secret" : "该鉴权模式需要填写 API Key（Secret）";
        }
        if (authType == McpAuthTypes.Header
            && !string.IsNullOrWhiteSpace(request.AuthHeaderName)
            && !Regex.IsMatch(request.AuthHeaderName.Trim(), "^[A-Za-z][A-Za-z0-9-]{0,63}$"))
        {
            return "自定义 Header 名必须是合法的 HTTP 头名（字母开头，仅字母/数字/连字符）";
        }

        return null;
    }

    private static McpServiceConfig BuildConfig(string id, McpServerUpsertRequest request) => new()
    {
        Id = id,
        Name = request.Name!.Trim(),
        Transport = string.IsNullOrWhiteSpace(request.Transport) ? "http" : request.Transport.Trim().ToLowerInvariant(),
        Url = request.Url!.Trim(),
        AutoStart = request.AutoStart ?? false,
        Builtin = request.Builtin ?? false,
        AuthType = request.AuthType,
        AuthHeaderName = request.AuthHeaderName,
        AuthKeyId = request.AuthKeyId,
        AuthSecret = request.AuthSecret,
        ShopCredential = request.ShopCredential
    };

    private static IResult? TryUpsert(McpCatalog catalog, McpServiceConfig config)
    {
        try
        {
            catalog.UpsertConfig(config);
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException)
        {
            return Fail(ErrorCodes.InternalError, "写入 MCP 清单失败：" + ex.Message, StatusCodes.Status500InternalServerError);
        }
    }

    private static async Task<IResult> CreateServerAsync(
        McpServerUpsertRequest request, McpCatalog catalog, McpReconciler reconciler, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Id)) return Fail(ErrorCodes.ValidationError, "服务 ID 不能为空", 400);
        var id = McpCatalog.NormalizeId(request.Id);
        var invalid = ValidateUpsert(request, existing: null);
        if (invalid is not null) return Fail(ErrorCodes.ValidationError, invalid, 400);
        if (catalog.GetConfig(id) is not null)
        {
            return Fail(ErrorCodes.ValidationError, $"服务 {id} 已存在，请改用编辑", StatusCodes.Status409Conflict);
        }

        var writeError = TryUpsert(catalog, BuildConfig(id, request));
        if (writeError is not null) return writeError;

        // 保存即握手；握手失败保留配置（服务仍可后续重新探测），状态如实回传。
        var connected = await reconciler.HandshakeAsync(id, ct).ConfigureAwait(false);
        return Results.Ok(ApiEnvelope<object>.Ok(new
        {
            id,
            connected,
            snapshot = catalog.ListSnapshots().FirstOrDefault(s => s.Id == id)
        }, string.Empty));
    }

    private static async Task<IResult> UpdateServerAsync(
        string id, McpServerUpsertRequest request, McpCatalog catalog, McpReconciler reconciler, CancellationToken ct)
    {
        var key = McpCatalog.NormalizeId(id);
        if (catalog.GetConfig(key) is null)
        {
            return Fail(ErrorCodes.ValidationError, $"清单中未声明服务: {key}", StatusCodes.Status404NotFound);
        }

        // ID 以路由为准，忽略 body.id，避免改错条目。
        var normalized = request with { Id = key };
        var invalid = ValidateUpsert(normalized, catalog.GetConfig(key));
        if (invalid is not null) return Fail(ErrorCodes.ValidationError, invalid, 400);

        var writeError = TryUpsert(catalog, BuildConfig(key, normalized));
        if (writeError is not null) return writeError;

        var connected = await reconciler.HandshakeAsync(key, ct).ConfigureAwait(false);
        return Results.Ok(ApiEnvelope<object>.Ok(new
        {
            id = key,
            connected,
            snapshot = catalog.ListSnapshots().FirstOrDefault(s => s.Id == key)
        }, string.Empty));
    }

    private static IResult DeleteServer(string id, McpCatalog catalog)
    {
        var key = McpCatalog.NormalizeId(id);
        var config = catalog.GetConfig(key);
        if (config is null)
        {
            return Fail(ErrorCodes.ValidationError, $"清单中未声明服务: {key}", StatusCodes.Status404NotFound);
        }

        // 内置服务随产品发布（罗盘 / 1688 等）：只可改配置、可停用，不可删除。
        if (config.Builtin)
        {
            return Fail(ErrorCodes.PermissionDenied,
                $"内置服务 {key} 不可删除：可编辑配置或停用（断开连接），删除仅限外部服务",
                StatusCodes.Status403Forbidden);
        }

        try
        {
            if (!catalog.RemoveConfig(key))
            {
                return Fail(ErrorCodes.ValidationError, $"清单中未声明服务: {key}", StatusCodes.Status404NotFound);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            return Fail(ErrorCodes.InternalError, "写入 MCP 清单失败：" + ex.Message, StatusCodes.Status500InternalServerError);
        }

        // 只停用不删数据：运行时状态槽保留，状态为 disabled。
        return Results.Ok(ApiEnvelope<object>.Ok(new
        {
            id = key,
            disabled = true,
            note = "已从声明清单移除并停用，运行时数据保留"
        }, string.Empty));
    }

    private static IResult DisconnectServer(string id, McpCatalog catalog)
    {
        var key = McpCatalog.NormalizeId(id);
        if (catalog.GetConfig(key) is null)
        {
            return Fail(ErrorCodes.ValidationError, $"清单中未声明服务: {key}", StatusCodes.Status404NotFound);
        }

        catalog.SetDisabled(key, "由管理界面停用（清单保留，重新握手即可恢复）");
        return Results.Ok(ApiEnvelope<object>.Ok(new
        {
            id = key,
            disabled = true,
            snapshot = catalog.ListSnapshots().FirstOrDefault(s => s.Id == key)
        }, string.Empty));
    }

    /// <summary>
    /// 调试直调：只允许 read 工具。write / irreversible 必须由 Agent 运行时走
    /// 幂等账本 + HITL 审批，不能从管理界面绕过治理链路。
    /// </summary>
    private static async Task<IResult> CallToolAsync(
        McpToolCallRequest request, McpCatalog catalog, McpToolProvider provider, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.ServerId) || string.IsNullOrWhiteSpace(request.Name))
        {
            return Fail(ErrorCodes.ValidationError, "serverId 与 name 不能为空", 400);
        }

        var tool = provider.ListTools().FirstOrDefault(t =>
            string.Equals(t.ServerId, request.ServerId, StringComparison.Ordinal)
            && string.Equals(t.Name, request.Name, StringComparison.Ordinal));
        if (tool is null)
        {
            return Fail(ErrorCodes.ValidationError,
                $"工具未登记或服务未连接: {request.ServerId}/{request.Name}", StatusCodes.Status404NotFound);
        }

        var risk = RiskClassifier.Classify(tool);
        if (!string.Equals(risk, RiskLevels.Read, StringComparison.Ordinal))
        {
            return Fail(ErrorCodes.PermissionDenied,
                $"风险等级「{RiskClassifier.Describe(risk)}」，调试端点禁止直调；请通过 Agent 对话执行（写操作需审批）",
                StatusCodes.Status403Forbidden);
        }

        var argumentsJson = request.Arguments.HasValue ? request.Arguments.Value.GetRawText() : "{}";
        var stopwatch = Stopwatch.StartNew();
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            var raw = await catalog.CreateClient(request.ServerId!)
                .CallToolAsync(request.Name!, argumentsJson, timeout.Token).ConfigureAwait(false);
            stopwatch.Stop();

            return Results.Ok(ApiEnvelope<object>.Ok(new
            {
                serverId = request.ServerId,
                name = request.Name,
                risk,
                elapsedMs = stopwatch.ElapsedMilliseconds,
                result = ParseCallResult(raw)
            }, string.Empty));
        }
        catch (McpProtocolException ex)
        {
            return Fail(ex.Code > 0 ? ex.Code : ErrorCodes.InternalError, ex.Message, StatusCodes.Status502BadGateway);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return Fail(ErrorCodes.NetworkError, "工具调用超时（15 秒）", StatusCodes.Status504GatewayTimeout);
        }
        catch (Exception ex)
        {
            return Fail(ErrorCodes.NetworkError, "服务暂不可达：" + ex.Message, StatusCodes.Status502BadGateway);
        }
    }

    private static JsonElement ParseCallResult(string raw)
    {
        try
        {
            using var document = JsonDocument.Parse(raw);
            return document.RootElement.Clone();
        }
        catch (JsonException)
        {
            return JsonSerializer.SerializeToElement(new { text = raw });
        }
    }
}

/// <summary>MCP 服务新增 / 编辑入参；凭证留空表示沿用清单原值，明文不回显。
/// AuthType 四档：none（默认，免鉴权）/ bearer（标准 API Key）/ header（自定义头，配 AuthHeaderName）/ hmac（高危签名）。
/// Builtin 由清单标记（内置可改不可删），界面新增的服务默认为外部。</summary>
public sealed record McpServerUpsertRequest(
    string? Id,
    string? Name,
    string? Transport,
    string? Url,
    bool? AutoStart,
    string? AuthType,
    string? AuthHeaderName,
    string? AuthKeyId,
    string? AuthSecret,
    string? ShopCredential,
    bool? Builtin);

/// <summary>调试直调入参；Arguments 为 JSON 对象，缺省 {}。</summary>
public sealed record McpToolCallRequest(string? ServerId, string? Name, JsonElement? Arguments);

/// <summary>
/// 幂等账本对账端点：按 operationId 反查 / 时间窗口扫描（规范 §6 孤儿对账）。
/// </summary>
public static class OperationsEndpoints
{
    public static void MapOperationsEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/operations").WithTags("Operations");

        group.MapGet("/{operationId}", async (string operationId, string? scope, OperationLedger ledger, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(scope))
            {
                return Results.BadRequest(ApiEnvelope<object>.Fail(
                    ErrorCodes.ValidationError, "缺少 scope 参数（账本主键为 (scope, operationId)）", string.Empty));
            }

            var record = await ledger.GetAsync(scope, operationId, ct).ConfigureAwait(false);
            return record is null
                ? Results.NotFound(ApiEnvelope<object>.Fail(ErrorCodes.ValidationError, "账本中无此记录", string.Empty))
                : Results.Ok(ApiEnvelope<object>.Ok(record, string.Empty));
        });

        group.MapGet("/", async (OperationLedger ledger, int? sinceHours, int? limit, CancellationToken ct) =>
        {
            var since = DateTimeOffset.UtcNow.AddHours(-Math.Clamp(sinceHours ?? 24, 1, 24 * 30));
            var records = await ledger.ListSinceAsync(since, Math.Clamp(limit ?? 200, 1, 1000), ct).ConfigureAwait(false);
            return Results.Ok(ApiEnvelope<object>.Ok(records, string.Empty));
        });
    }
}
