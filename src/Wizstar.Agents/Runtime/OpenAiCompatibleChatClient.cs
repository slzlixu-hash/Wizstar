using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.AI;

namespace Wizstar.Agents.Runtime;

/// <summary>
/// OpenAI 兼容 /chat/completions 的 <see cref="IChatClient"/> 实现。
///
/// 为什么不直接用 OpenAI SDK：本地 / 私有化部署的 OpenAI 兼容端点五花八门，
/// 自研协议翻译层只做「报文对齐」——把 ChatMessage 翻成 OpenAI 报文、
/// 把 tool_calls 翻成 FunctionCallContent，循环与错误回传交给 FunctionInvokingChatClient。
///
/// 口径：
///  - 非流式请求-响应；流式接口在传输层一次性取完再切成单 update；
///  - 明文 API Key 只进请求头，不进日志、不进异常消息；
///  - 上游非 2xx 抛 InvalidOperationException，消息只保留状态码与截断正文。
/// </summary>
public sealed class OpenAiCompatibleChatClient : IChatClient
{
    private static readonly JsonSerializerOptions WireJson = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    private readonly HttpClient _httpClient;
    private readonly string _baseUrl;
    private readonly string _modelName;
    private readonly string? _apiKey;
    private readonly double _temperature;
    private readonly int _maxTokens;
    private readonly ILogger? _logger;

    public OpenAiCompatibleChatClient(
        HttpClient httpClient,
        string baseUrl,
        string modelName,
        string? apiKey,
        double temperature,
        int maxTokens,
        ILogger? logger = null)
    {
        _httpClient = httpClient;
        _baseUrl = baseUrl.TrimEnd('/');
        _modelName = modelName;
        _apiKey = apiKey;
        _temperature = temperature;
        _maxTokens = maxTokens;
        _logger = logger;
    }

    public async Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(messages);

        var payload = BuildPayload(messages, options);
        using var request = new HttpRequestMessage(HttpMethod.Post, _baseUrl + "/chat/completions")
        {
            Content = new StringContent(payload.ToJsonString(WireJson), System.Text.Encoding.UTF8, "application/json")
        };
        request.Headers.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("application/json"));
        if (!string.IsNullOrEmpty(_apiKey))
        {
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", _apiKey);
        }

        using var response = await _httpClient.SendAsync(request, cancellationToken).ConfigureAwait(false);
        var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            _logger?.LogWarning("模型请求被拒: status={Status}", (int)response.StatusCode);
            throw new InvalidOperationException(
                $"模型服务返回 {(int)response.StatusCode}：{Truncate(body, 300)}");
        }

        return ParseResponse(body);
    }

    /// <summary>本期不做真流式：一次性取完再切成单个 update（FI 客户端流式路径可用）。</summary>
    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var response = await GetResponseAsync(messages, options, cancellationToken).ConfigureAwait(false);
        foreach (var message in response.Messages)
        {
            yield return new ChatResponseUpdate(message.Role, message.Contents);
        }
    }

    public object? GetService(Type serviceType, object? serviceKey = null)
    {
        ArgumentNullException.ThrowIfNull(serviceType);
        if (serviceKey is not null)
        {
            return null;
        }

        return serviceType.IsInstanceOfType(this) ? this : null;
    }

    public void Dispose()
    {
        // HttpClient 由 IHttpClientFactory 管理，此处不释放
    }

    // ---------------------------------------------------------------- 报文组装

    private JsonObject BuildPayload(IEnumerable<ChatMessage> messages, ChatOptions? options)
    {
        var array = new JsonArray();
        foreach (var message in messages)
        {
            // 一条 ChatMessage 可能展开成多条报文（典型：多工具结果聚合进一个 tool 消息）
            foreach (var node in ToWireMessages(message))
            {
                array.Add(node);
            }
        }

        var payload = new JsonObject
        {
            ["model"] = _modelName,
            ["messages"] = array,
            ["temperature"] = _temperature,
            ["max_tokens"] = options?.MaxOutputTokens is > 0 ? options.MaxOutputTokens.Value : _maxTokens,
            ["stream"] = false
        };

        var tools = BuildTools(options);
        if (tools.Count > 0)
        {
            payload["tools"] = tools;
            payload["tool_choice"] = options?.ToolMode switch
            {
                { } mode when mode == ChatToolMode.None => "none",
                { } mode when mode == ChatToolMode.RequireAny => "required",
                _ => "auto"
            };
        }

        return payload;
    }

    private static JsonArray BuildTools(ChatOptions? options)
    {
        var tools = new JsonArray();
        if (options?.Tools is null)
        {
            return tools;
        }

        foreach (var tool in options.Tools.OfType<AIFunction>())
        {
            var function = new JsonObject
            {
                ["name"] = tool.Name,
                ["description"] = tool.Description ?? string.Empty
            };

            var schema = tool.JsonSchema;
            function["parameters"] = schema.ValueKind == JsonValueKind.Object
                ? JsonNode.Parse(schema.GetRawText())
                : new JsonObject { ["type"] = "object", ["properties"] = new JsonObject() };

            tools.Add(new JsonObject
            {
                ["type"] = "function",
                ["function"] = function
            });
        }

        return tools;
    }

    /// <summary>
    /// ChatMessage → OpenAI 报文（0..N 条）。并行工具调用的 N 个结果会聚合进同一条 tool 消息，
    /// 上游要求每个 tool_call_id 各一条 tool 消息，这里按结果逐条展开。
    /// </summary>
    private static IEnumerable<JsonObject> ToWireMessages(ChatMessage message)
    {
        if (message.Role == ChatRole.Tool)
        {
            foreach (var result in message.Contents.OfType<FunctionResultContent>())
            {
                yield return new JsonObject
                {
                    ["role"] = "tool",
                    ["tool_call_id"] = result.CallId,
                    ["content"] = StringifyResult(result.Result)
                };
            }

            yield break;
        }

        var node = new JsonObject { ["role"] = ToWireRole(message.Role) };
        var text = message.Text;
        if (!string.IsNullOrEmpty(text))
        {
            node["content"] = text;
        }

        var calls = message.Contents.OfType<FunctionCallContent>().ToList();
        if (calls.Count > 0)
        {
            var toolCalls = new JsonArray();
            foreach (var call in calls)
            {
                toolCalls.Add(new JsonObject
                {
                    ["id"] = call.CallId,
                    ["type"] = "function",
                    ["function"] = new JsonObject
                    {
                        ["name"] = call.Name,
                        ["arguments"] = call.Arguments is null
                            ? "{}"
                            : JsonSerializer.Serialize(call.Arguments, WireJson)
                    }
                });
            }

            node["tool_calls"] = toolCalls;
            if (!node.ContainsKey("content"))
            {
                node["content"] = null;
            }
        }

        // 既无文本又无工具调用的 assistant 消息上游会 400，直接丢弃
        if (!node.ContainsKey("content") && !node.ContainsKey("tool_calls"))
        {
            yield break;
        }

        yield return node;
    }

    private static string ToWireRole(ChatRole role) =>
        role == ChatRole.System ? "system"
        : role == ChatRole.Assistant ? "assistant"
        : role == ChatRole.Tool ? "tool"
        : "user";

    private static string StringifyResult(object? result) =>
        result switch
        {
            null => string.Empty,
            string text => text,
            JsonElement element => element.GetRawText(),
            _ => JsonSerializer.Serialize(result)
        };

    // ---------------------------------------------------------------- 响应对齐

    private static ChatResponse ParseResponse(string body)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(body);
        }
        catch (JsonException)
        {
            throw new InvalidOperationException($"模型返回不是合法 JSON：{Truncate(body, 300)}");
        }

        using (document)
        {
            var root = document.RootElement;
            if (!root.TryGetProperty("choices", out var choices)
                || choices.ValueKind != JsonValueKind.Array
                || choices.GetArrayLength() == 0)
            {
                throw new InvalidOperationException($"模型返回缺少 choices：{Truncate(body, 300)}");
            }

            var message = choices[0].TryGetProperty("message", out var value) ? value : default;
            var contents = new List<AIContent>();

            if (message.ValueKind == JsonValueKind.Object
                && message.TryGetProperty("content", out var content)
                && content.ValueKind == JsonValueKind.String)
            {
                var text = content.GetString();
                if (!string.IsNullOrWhiteSpace(text))
                {
                    contents.Add(new TextContent(text));
                }
            }

            if (message.ValueKind == JsonValueKind.Object
                && message.TryGetProperty("tool_calls", out var toolCalls)
                && toolCalls.ValueKind == JsonValueKind.Array)
            {
                foreach (var toolCall in toolCalls.EnumerateArray())
                {
                    var id = toolCall.TryGetProperty("id", out var idNode) ? idNode.GetString() : null;
                    if (string.IsNullOrWhiteSpace(id)
                        || !toolCall.TryGetProperty("function", out var function))
                    {
                        continue;
                    }

                    var name = function.TryGetProperty("name", out var nameNode) ? nameNode.GetString() : null;
                    if (string.IsNullOrWhiteSpace(name))
                    {
                        continue;
                    }

                    var arguments = function.TryGetProperty("arguments", out var argsNode)
                        ? ParseArguments(argsNode.ValueKind == JsonValueKind.String
                            ? argsNode.GetString()
                            : argsNode.GetRawText())
                        : null;

                    contents.Add(new FunctionCallContent(id, name, arguments));
                }
            }

            if (contents.Count == 0)
            {
                contents.Add(new TextContent(string.Empty));
            }

            return new ChatResponse(new ChatMessage(ChatRole.Assistant, contents));
        }
    }

    private static Dictionary<string, object?>? ParseArguments(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        try
        {
            var parsed = JsonNode.Parse(raw);
            return parsed is JsonObject obj
                ? obj.ToDictionary(pair => pair.Key, pair => (object?)pair.Value?.DeepClone())
                : null;
        }
        catch (JsonException)
        {
            // 上游偶发返回半截 JSON：不抛，传 null 让工具层报「参数无法解析」，模型可自行重试
            return null;
        }
    }

    private static string Truncate(string value, int max) =>
        string.IsNullOrEmpty(value) ? string.Empty : (value.Length <= max ? value : value[..max] + "…");
}
