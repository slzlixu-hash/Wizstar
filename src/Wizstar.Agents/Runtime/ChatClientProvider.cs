using Microsoft.Extensions.AI;
using Wizstar.Contracts;

namespace Wizstar.Agents.Runtime;

/// <summary>模型通道句柄：client + 运行模式 + 离线原因。</summary>
public sealed record ChatClientHandle(IChatClient Client, string Mode, string? Reason);

/// <summary>
/// 模型供给：优先读「系统设置」里的动态配置（数据库），其次读 appsettings 静态配置，
/// 都不完整时回退离线桩并给出原因。
/// 口径：真实模型优先，失败显式回退并逐条标注 live / offline，不伪造在线。
///
/// A2：每次 Get() 都重新解析配置并比对签名，界面保存后无需重启即可 offline → live。
/// 签名只在内存比对，含明文 Key 但不写日志。
/// </summary>
public sealed class ChatClientProvider(
    IHttpClientFactory httpFactory,
    IConfiguration configuration,
    ILogger<ChatClientProvider> logger,
    IChatClient? forcedClient = null,
    ILlmRuntimeSettingsProvider? runtimeSettings = null)
{
    private readonly object _lock = new();
    private ChatClientHandle? _handle;
    private string? _signature;

    /// <summary>当前模式（live / offline），供 health 与 SSE meta 事件使用。</summary>
    public string Mode => Get().Mode;

    /// <summary>离线原因（live 模式为 null）。</summary>
    public string? OfflineReason
    {
        get
        {
            var handle = Get();
            return handle.Mode == "offline" ? handle.Reason : null;
        }
    }

    public ChatClientHandle Get()
    {
        lock (_lock)
        {
            var (settings, dynamicReason) = ResolveSettings();
            var signature = SignatureOf(settings) + "|" + (dynamicReason ?? string.Empty);
            if (_handle is not null && _signature == signature)
            {
                return _handle;
            }

            _handle = Build(settings, dynamicReason);
            _signature = signature;
            logger.LogInformation("模型通道就绪: mode={Mode} reason={Reason} source={Source}",
                _handle.Mode, _handle.Reason, settings is null ? "static" : settings.ProviderCode);
            return _handle;
        }
    }

    private (LlmRuntimeSettings? Settings, string? Reason) ResolveSettings()
    {
        try
        {
            var settings = runtimeSettings?.GetCurrent();
            // 动态配置不可用时向配置源要一句可读原因，避免 health 显示误导性的「未配置模型」。
            var reason = settings is null ? runtimeSettings?.DescribeOffline() : null;
            return (settings, reason);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "动态 LLM 配置读取失败，回退静态配置");
            return (null, "动态配置读取失败，回退静态配置");
        }
    }

    private static string SignatureOf(LlmRuntimeSettings? s) => s is null
        ? "static"
        : string.Join("|", s.ProviderCode, s.BaseUrl, s.Model, s.ApiKey ?? string.Empty,
            s.Temperature, s.MaxOutputTokens, s.TimeoutSeconds);

    private ChatClientHandle Build(LlmRuntimeSettings? settings, string? dynamicReason)
    {
        // 测试桩：脚本化 ChatClient 直接注入（跳过真实配置装配）
        if (forcedClient is not null)
        {
            return new ChatClientHandle(forcedClient, "live", null);
        }

        var baseUrl = (settings is not null ? settings.BaseUrl : configuration["LLM:BaseUrl"])?.Trim();
        var modelName = (settings is not null ? settings.Model : configuration["LLM:Model"])?.Trim();
        var apiKey = (settings is not null ? settings.ApiKey : configuration["LLM:ApiKey"])?.Trim();
        var temperature = settings?.Temperature ?? configuration.GetValue("LLM:Temperature", 0.7);
        var maxTokens = settings?.MaxOutputTokens ?? configuration.GetValue("LLM:MaxOutputTokens", 2048);
        var timeoutSeconds = Math.Clamp(
            settings?.TimeoutSeconds ?? configuration.GetValue("LLM:TimeoutSeconds", 120), 10, 600);

        if (string.IsNullOrWhiteSpace(baseUrl) || string.IsNullOrWhiteSpace(modelName))
        {
            var reason = dynamicReason ?? "系统设置中尚未配置默认模型 / Base URL，使用离线回退";
            return new ChatClientHandle(new OfflineChatClient(reason), "offline", reason);
        }

        var http = httpFactory.CreateClient("llm");
        http.Timeout = TimeSpan.FromSeconds(timeoutSeconds);

        var client = new OpenAiCompatibleChatClient(
            http, baseUrl, modelName, apiKey, temperature, maxTokens, logger);

        return new ChatClientHandle(client, "live", null);
    }
}
