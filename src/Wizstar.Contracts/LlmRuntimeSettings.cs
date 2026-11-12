namespace Wizstar.Contracts;

/// <summary>
/// 当前生效的 LLM 通道参数。由配置存储（llm_provider + llm_model_definition）解析，
/// 交给 <c>ChatClientProvider</c> 装配真实模型客户端；返回 null 表示应回退静态配置 / 离线桩。
/// </summary>
public sealed record LlmRuntimeSettings(
    string ProviderCode,
    string BaseUrl,
    string Model,
    string? ApiKey,
    double Temperature = 0.7,
    int MaxOutputTokens = 2048,
    int TimeoutSeconds = 120);

/// <summary>
/// LLM 运行时配置源。实现必须自行吞掉存储异常并返回 null（不得让健康检查 / 对话因配置库异常而失败）。
/// 每次调用都返回最新值，宿主据此做热切换。
/// </summary>
public interface ILlmRuntimeSettingsProvider
{
    LlmRuntimeSettings? GetCurrent();

    /// <summary>
    /// GetCurrent() 返回 null 时给出可读的离线原因（默认模型 / 供应商 / API Key 哪一项缺失）。
    /// 默认实现返回 null，宿主再回退到静态配置的原因文案；实现不得抛异常。
    /// </summary>
    string? DescribeOffline() => null;
}
