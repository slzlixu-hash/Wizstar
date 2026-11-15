using Wizstar.Agents.Runtime;
using Wizstar.Contracts;

namespace Wizstar.Tests;

/// <summary>
/// 模型通道按 Agent 解析：wiz_llm_agent_binding 命中时用该模型，未命中回落全局默认模型。
/// （不发起真实 HTTP，只验证配置解析与句柄装配。）
/// </summary>
public class ChatClientProviderTests
{
    [Fact]
    public void GetForAgent_UsesAgentBinding_AndFallsBackToGlobal()
    {
        var provider = BuildProvider();

        Assert.Equal("model-global", provider.Get().Model);
        Assert.Equal("model-scout", provider.Get("scout").Model);
        Assert.Equal("model-global", provider.Get("unknown-agent").Model);
        Assert.Equal("live", provider.Get("scout").Mode);
    }

    [Fact]
    public void GetForAgent_PicksUpChangedBinding_WithoutRestart()
    {
        var settings = new StubRuntimeSettings();
        var provider = new ChatClientProvider(
            new HttpClientFactoryStub(),
            new ConfigurationBuilder().Build(),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<ChatClientProvider>.Instance,
            null,
            settings);

        Assert.Equal("model-scout", provider.Get("scout").Model);

        settings.AgentModel = "model-scout-v2";
        Assert.Equal("model-scout-v2", provider.Get("scout").Model);
    }

    private static ChatClientProvider BuildProvider() => new(
        new HttpClientFactoryStub(),
        new ConfigurationBuilder().Build(),
        Microsoft.Extensions.Logging.Abstractions.NullLogger<ChatClientProvider>.Instance,
        null,
        new StubRuntimeSettings());

    private sealed class StubRuntimeSettings : ILlmRuntimeSettingsProvider
    {
        public string AgentModel { get; set; } = "model-scout";

        public LlmRuntimeSettings? GetCurrent() =>
            new("deepseek", "https://example.invalid/v1", "model-global", null);

        public LlmRuntimeSettings? GetForAgent(string agentKey) =>
            string.Equals(agentKey, "scout", StringComparison.OrdinalIgnoreCase)
                ? new LlmRuntimeSettings("deepseek", "https://example.invalid/v1", AgentModel, null)
                : GetCurrent();
    }

    private sealed class HttpClientFactoryStub : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }
}
