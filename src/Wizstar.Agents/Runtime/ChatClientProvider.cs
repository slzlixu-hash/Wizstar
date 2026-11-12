using Microsoft.Extensions.AI;

namespace Wizstar.Agents.Runtime;

/// <summary>模型通道句柄：client + 运行模式 + 离线原因。</summary>
public sealed record ChatClientHandle(IChatClient Client, string Mode, string Reason);

/// <summary>
/// 模型供给：按配置装配 OpenAI 兼容客户端；配置不完整时回退离线桩并给出原因。
/// 口径：真实模型优先，失败显式回退并逐条标注 live / offline，不伪造在线。
/// </summary>
public sealed class ChatClientProvider(
    IHttpClientFactory httpFactory,
    IConfiguration configuration,
    ILogger<ChatClientProvider> logger,
    IChatClient? forcedClient = null)
{
    private readonly object _lock = new();
    private ChatClientHandle? _handle;

    /// <summary>当前模式（live / offline），供 health 与 SSE meta 事件使用。</summary>
    public string Mode => Get().Mode;

    /// <summary>离线原因（live 模式为 null）。</summary>
    public string? OfflineReason => Get().Mode == "offline" ? Get().Reason : null;

    public ChatClientHandle Get()
    {
        lock (_lock)
        {
            if (_handle is not null)
            {
                return _handle;
            }

            _handle = Build();
            logger.LogInformation("模型通道就绪: mode={Mode} reason={Reason}", _handle.Mode, _handle.Reason);
            return _handle;
        }
    }

    private ChatClientHandle Build()
    {
        // 测试桩：脚本化 ChatClient 直接注入（跳过真实配置装配）
        if (forcedClient is not null)
        {
            return new ChatClientHandle(forcedClient, "live", null);
        }

        var baseUrl = configuration["LLM:BaseUrl"]?.Trim();
        var modelName = configuration["LLM:Model"]?.Trim();
        var apiKey = configuration["LLM:ApiKey"]?.Trim();
        var temperature = configuration.GetValue("LLM:Temperature", 0.7);
        var maxTokens = configuration.GetValue("LLM:MaxOutputTokens", 2048);
        var timeoutSeconds = Math.Clamp(configuration.GetValue("LLM:TimeoutSeconds", 120), 10, 600);

        if (string.IsNullOrWhiteSpace(baseUrl) || string.IsNullOrWhiteSpace(modelName))
        {
            return new ChatClientHandle(
                new OfflineChatClient("未配置 LLM:BaseUrl / LLM:Model，使用离线回退"),
                "offline",
                "未配置 LLM:BaseUrl / LLM:Model");
        }

        var http = httpFactory.CreateClient("llm");
        http.Timeout = TimeSpan.FromSeconds(timeoutSeconds);

        var client = new OpenAiCompatibleChatClient(
            http, baseUrl, modelName, apiKey, temperature, maxTokens,
            logger);

        return new ChatClientHandle(client, "live", null);
    }
}
