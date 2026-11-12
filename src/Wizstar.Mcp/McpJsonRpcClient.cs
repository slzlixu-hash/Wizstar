using System.Text;
using System.Text.Json;
using Wizstar.Contracts;

namespace Wizstar.Mcp;

/// <summary>JSON-RPC 层协议错误（服务端返回 error 对象）。</summary>
public sealed class McpProtocolException(int code, string message) : Exception($"MCP 协议错误 {code}: {message}")
{
    public int Code { get; } = code;
}

/// <summary>JSON-RPC 2.0 over Streamable HTTP 的 MCP 客户端（规范 §2）。
///
/// 生命周期：Connect = initialize（捕获 Mcp-Session-Id）→ notifications/initialized；
/// 之后 tools/list / tools/call 携带 MCP-Session-Id 与 MCP-Protocol-Version 头。
/// 支持 text/event-stream 响应兼容（Streamable HTTP 允许服务端以 SSE 返回）。
/// </summary>
public sealed class McpJsonRpcClient(
    string serverId,
    McpServiceConfig config,
    HttpClient httpClient,
    ILogger logger)
{
    public const string ProtocolVersion = "2025-06-18";

    private readonly object _lock = new();
    private long _nextId = 1;
    private string? _sessionId;
    private bool _initialized;

    public string ServerId { get; } = serverId;

    public bool IsInitialized
    {
        get { lock (_lock) { return _initialized; } }
    }

    // ---------------------------------------------------------------- 握手与元数据

    /// <summary>initialize + notifications/initialized。幂等：已初始化直接返回。</summary>
    public async Task<(string ServerName, string ServerVersion, string ProtocolVersion)> ConnectAsync(CancellationToken ct = default)
    {
        if (IsInitialized)
        {
            return (_serverName, _serverVersion, _negotiatedVersion);
        }

        EnsureHttpConfig();
        var response = await SendRequestAsync(
            "initialize",
            new
            {
                protocolVersion = ProtocolVersion,
                capabilities = new { tools = new { } },
                clientInfo = new { name = "Wizstar", version = "0.1.0" }
            },
            ct).ConfigureAwait(false);

        var result = response.RootElement.TryGetProperty("result", out var resultNode)
            ? resultNode
            : response.RootElement;
        var serverInfo = result.TryGetProperty("serverInfo", out var info) ? info : default;
        _serverName = serverInfo.ValueKind == JsonValueKind.Object && serverInfo.TryGetProperty("name", out var n)
            ? n.GetString() ?? ServerId
            : ServerId;
        _serverVersion = serverInfo.ValueKind == JsonValueKind.Object && serverInfo.TryGetProperty("version", out var v)
            ? v.GetString() ?? "unknown"
            : "unknown";
        _negotiatedVersion = result.TryGetProperty("protocolVersion", out var pv)
            ? pv.GetString() ?? ProtocolVersion
            : ProtocolVersion;

        lock (_lock)
        {
            _initialized = true;
        }

        // notifications/initialized：通知，无 id，服务端通常回 202
        try
        {
            await SendNotificationAsync("notifications/initialized", ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "initialized 通知发送失败（不影响握手）: server={ServerId}", ServerId);
        }

        logger.LogInformation("MCP 握手完成: server={ServerId} name={Name} version={Version} protocol={Protocol}",
            ServerId, _serverName, _serverVersion, _negotiatedVersion);
        return (_serverName, _serverVersion, _negotiatedVersion);
    }

    private string _serverName = string.Empty;
    private string _serverVersion = string.Empty;
    private string _negotiatedVersion = ProtocolVersion;

    /// <summary>tools/list：抓取工具清单（含 x-risk 声明）。未握手时自动先握手。</summary>
    public async Task<IReadOnlyList<McpToolInfo>> ListToolsAsync(CancellationToken ct = default)
    {
        await ConnectAsync(ct).ConfigureAwait(false);

        var response = await SendRequestAsync("tools/list", new { }, ct).ConfigureAwait(false);
        var tools = new List<McpToolInfo>();

        var resultNode = response.RootElement.ValueKind == JsonValueKind.Object
            && response.RootElement.TryGetProperty("result", out var result)
            ? result
            : response.RootElement;

        if (resultNode.ValueKind == JsonValueKind.Object
            && resultNode.TryGetProperty("tools", out var array)
            && array.ValueKind == JsonValueKind.Array)
        {
            foreach (var tool in array.EnumerateArray())
            {
                var name = tool.TryGetProperty("name", out var nameNode) ? nameNode.GetString() : null;
                if (string.IsNullOrWhiteSpace(name))
                {
                    continue;
                }

                var description = tool.TryGetProperty("description", out var descNode) ? descNode.GetString() : string.Empty;

                string? schemaJson = null;
                if (tool.TryGetProperty("inputSchema", out var schema) && schema.ValueKind == JsonValueKind.Object)
                {
                    schemaJson = schema.GetRawText();
                }

                // x-risk：优先工具对象顶层，其次 inputSchema 内（规范 §3.2）
                var risk = ExtractRisk(tool) ?? (schema.ValueKind == JsonValueKind.Object ? ExtractRisk(schema) : null);

                tools.Add(new McpToolInfo(name, description ?? string.Empty, schemaJson, risk));
            }
        }

        logger.LogInformation("MCP 工具清单: server={ServerId} count={Count}", ServerId, tools.Count);
        return tools;
    }

    /// <summary>tools/call：执行工具，返回结果文本（服务端按规范返回统一信封 JSON）。</summary>
    public async Task<string> CallToolAsync(string toolName, string argumentsJson, CancellationToken ct = default)
    {
        await ConnectAsync(ct).ConfigureAwait(false);

        var arguments = ParseArguments(argumentsJson);
        var response = await SendRequestAsync(
            "tools/call",
            new { name = toolName, arguments = arguments.ValueKind == JsonValueKind.Object ? (JsonElement?)arguments : null },
            ct).ConfigureAwait(false);

        var result = response.RootElement.TryGetProperty("result", out var resultNode)
            ? resultNode
            : response.RootElement;
        if (result.ValueKind == JsonValueKind.Object
            && result.TryGetProperty("isError", out var isError)
            && isError.ValueKind == JsonValueKind.True)
        {
            var errorText = ExtractContentText(result);
            throw new McpProtocolException(ErrorCodes.InternalError,
                string.IsNullOrWhiteSpace(errorText) ? "工具返回 isError" : errorText);
        }

        var text = ExtractContentText(result);
        return string.IsNullOrWhiteSpace(text) ? "{}" : text;
    }

    /// <summary>GET /healthz 探活（规范 §2.1：2 秒超时，不带副作用）。</summary>
    public async Task<bool> HealthProbeAsync(CancellationToken ct = default)
    {
        EnsureHttpConfig();
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(2));

            using var request = new HttpRequestMessage(HttpMethod.Get, BuildUrl("/healthz"));
            ApplyAuthHeaders(request, string.Empty, request.RequestUri?.AbsolutePath ?? "/healthz");
            using var response = await httpClient.SendAsync(request, timeout.Token).ConfigureAwait(false);
            return response.IsSuccessStatusCode;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return false;
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "健康探测失败: server={ServerId}", ServerId);
            return false;
        }
    }

    // ---------------------------------------------------------------- JSON-RPC 传输

    private async Task<JsonDocument> SendRequestAsync(string method, object? @params, CancellationToken ct)
    {
        EnsureHttpConfig();

        long id;
        lock (_lock)
        {
            id = _nextId++;
        }

        var payload = new
        {
            jsonrpc = "2.0",
            id,
            method,
            @params
        };
        var body = JsonSerializer.Serialize(payload);

        using var request = new HttpRequestMessage(HttpMethod.Post, BuildUrl("/mcp"))
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json")
        };
        request.Headers.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("text/event-stream"));
        ApplyAuthHeaders(request, body, request.RequestUri?.AbsolutePath ?? "/mcp");
        ApplySessionHeaders(request);

        using var response = await httpClient.SendAsync(request, ct).ConfigureAwait(false);

        // Streamable HTTP：握手响应可能携带 Mcp-Session-Id，后续请求必须回传
        if (response.Headers.TryGetValues("Mcp-Session-Id", out var sessionValues))
        {
            var sessionId = sessionValues.FirstOrDefault();
            if (!string.IsNullOrWhiteSpace(sessionId))
            {
                lock (_lock)
                {
                    _sessionId = sessionId;
                }
            }
        }

        if (!response.IsSuccessStatusCode)
        {
            var bodyText = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            throw new McpProtocolException(ErrorCodes.NetworkError,
                $"服务返回 {(int)response.StatusCode}：{Truncate(bodyText, 200)}");
        }

        var contentType = response.Content.Headers.ContentType?.MediaType ?? string.Empty;
        var raw = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        return contentType.Contains("text/event-stream", StringComparison.OrdinalIgnoreCase)
            ? ParseSseResponse(raw, id)
            : ParseJsonResponse(raw, id);
    }

    private async Task SendNotificationAsync(string method, CancellationToken ct)
    {
        EnsureHttpConfig();
        var payload = JsonSerializer.Serialize(new { jsonrpc = "2.0", method, @params = new { } });

        using var request = new HttpRequestMessage(HttpMethod.Post, BuildUrl("/mcp"))
        {
            Content = new StringContent(payload, Encoding.UTF8, "application/json")
        };
        request.Headers.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("application/json"));
        ApplyAuthHeaders(request, payload, request.RequestUri?.AbsolutePath ?? "/mcp");
        ApplySessionHeaders(request);

        using var response = await httpClient.SendAsync(request, ct).ConfigureAwait(false);
        // 通知无响应体要求；非 2xx 也不致命（有些实现直接 202）
    }

    private void ApplySessionHeaders(HttpRequestMessage request)
    {
        string? sessionId;
        lock (_lock)
        {
            sessionId = _sessionId;
        }

        if (!string.IsNullOrWhiteSpace(sessionId))
        {
            request.Headers.Add("Mcp-Session-Id", sessionId);
            request.Headers.Add("MCP-Protocol-Version", _negotiatedVersion);
        }
    }

    private void ApplyAuthHeaders(HttpRequestMessage request, string body, string signPath)
    {
        var authorization = McpHmacSigner.BuildAuthorizationHeader(config, HttpMethod.Post, signPath, body);
        if (authorization is not null)
        {
            request.Headers.TryAddWithoutValidation("Authorization", authorization);
        }

        // 店铺凭证：仅走 HTTP 头透传，严禁进 JSON-RPC 消息体 / 日志 / Prompt（规范 §2.3 安全红线）
        if (!string.IsNullOrWhiteSpace(config.ShopCredential))
        {
            request.Headers.TryAddWithoutValidation("X-Shop-Credential", config.ShopCredential);
        }
    }

    private static JsonDocument ParseJsonResponse(string raw, long expectedId)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(raw);
        }
        catch (JsonException)
        {
            throw new McpProtocolException(ErrorCodes.InternalError, $"响应不是合法 JSON：{Truncate(raw, 200)}");
        }

        ValidateResponse(document, expectedId);
        return document;
    }

    private static JsonDocument ParseSseResponse(string raw, long expectedId)
    {
        foreach (var line in raw.Split('\n'))
        {
            var trimmed = line.Trim();
            if (!trimmed.StartsWith("data:", StringComparison.Ordinal))
            {
                continue;
            }

            var payload = trimmed["data:".Length..].Trim();
            if (payload.Length == 0)
            {
                continue;
            }

            try
            {
                var document = JsonDocument.Parse(payload);
                if (document.RootElement.ValueKind == JsonValueKind.Object
                    && (!document.RootElement.TryGetProperty("id", out var idNode) || idNode.GetInt64() == expectedId))
                {
                    ValidateResponse(document, expectedId);
                    return document;
                }

                document.Dispose();
            }
            catch (JsonException)
            {
                // 跳过无法解析的事件帧
            }
        }

        throw new McpProtocolException(ErrorCodes.InternalError, "SSE 响应中没有匹配的 JSON-RPC 结果");
    }

    private static void ValidateResponse(JsonDocument document, long expectedId)
    {
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            throw new McpProtocolException(ErrorCodes.InternalError, "响应根不是对象");
        }

        if (root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object)
        {
            var code = error.TryGetProperty("code", out var codeNode) && codeNode.TryGetInt32(out var c) ? c : 0;
            var message = error.TryGetProperty("message", out var messageNode) ? messageNode.GetString() : null;
            throw new McpProtocolException(code, message ?? "未知协议错误");
        }

        if (!root.TryGetProperty("result", out _))
        {
            throw new McpProtocolException(ErrorCodes.InternalError, "响应缺少 result");
        }

        if (root.TryGetProperty("id", out var idNode) && idNode.GetInt64() != expectedId)
        {
            throw new McpProtocolException(ErrorCodes.InternalError, $"响应 id 不匹配（期望 {expectedId}）");
        }
    }

    private static string ExtractContentText(JsonElement root)
    {
        var parts = new List<string>();

        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("content", out var content)
            && content.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in content.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.Object
                    && item.TryGetProperty("type", out var type)
                    && type.GetString() == "text"
                    && item.TryGetProperty("text", out var textNode)
                    && textNode.ValueKind == JsonValueKind.String)
                {
                    parts.Add(textNode.GetString() ?? string.Empty);
                }
            }
        }

        return string.Join("\n", parts.Where(p => p.Length > 0));
    }

    private static string? ExtractRisk(JsonElement tool)
    {
        if (tool.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (tool.TryGetProperty("x-risk", out var risk) && risk.ValueKind == JsonValueKind.String)
        {
            return risk.GetString();
        }

        return null;
    }

    private static JsonElement ParseArguments(string argumentsJson)
    {
        if (string.IsNullOrWhiteSpace(argumentsJson))
        {
            return JsonSerializer.SerializeToElement(new { });
        }

        try
        {
            using var document = JsonDocument.Parse(argumentsJson);
            return document.RootElement.ValueKind == JsonValueKind.Object
                ? document.RootElement.Clone()
                : JsonSerializer.SerializeToElement(new { });
        }
        catch (JsonException)
        {
            return JsonSerializer.SerializeToElement(new { });
        }
    }

    private string BuildUrl(string path)
    {
        var baseUrl = (config.Url ?? throw ApiException.Internal($"服务 {ServerId} 未配置 URL")).TrimEnd('/');
        return baseUrl + path;
    }

    private void EnsureHttpConfig()
    {
        if (!string.Equals(config.Transport, "http", StringComparison.OrdinalIgnoreCase))
        {
            throw ApiException.Internal($"服务 {ServerId} 的 transport={config.Transport}，stdio 托管启动本期未实现，仅支持 http");
        }

        if (string.IsNullOrWhiteSpace(config.Url))
        {
            throw ApiException.Internal($"服务 {ServerId} 未配置 url");
        }
    }

    private static string Truncate(string value, int max) =>
        string.IsNullOrEmpty(value) ? string.Empty : (value.Length <= max ? value : value[..max] + "…");
}
