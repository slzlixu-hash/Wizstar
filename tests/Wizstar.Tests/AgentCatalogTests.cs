using Wizstar.Agents.Profiles;
using Wizstar.Agents.Tools;
using Wizstar.Contracts;

namespace Wizstar.Tests;

public class AgentCatalogTests : IDisposable
{
    private readonly string _file;

    public AgentCatalogTests()
    {
        _file = Path.Combine(Path.GetTempPath(), $"wizstar-agents-{Guid.NewGuid():N}.yaml");
        File.WriteAllText(_file, """
            agents:
              - key: commander
                name: commander
                displayName: 指挥官
                description: 编排
                systemPrompt: |
                  你是指挥官。
                allowedTools: ["*"]
                maxSteps: 6
                enabled: true
              - key: scout
                name: scout
                displayName: 选品
                description: 选品
                systemPrompt: |
                  你是选品。
                allowedTools:
                  - "builtin.get_workspace_status"
                  - "mcp-demo.*"
                maxSteps: 4
            """);
    }

    public void Dispose()
    {
        File.Delete(_file);
    }

    [Fact]
    public void LoadsProfiles_WithDefaults()
    {
        var logger = LoggerFactoryHolder.Create<AgentCatalog>();
        var catalog = new AgentCatalog(_file, logger);

        Assert.Equal(2, catalog.GetAll().Count);
        var commander = catalog.Find("commander")!;
        Assert.Equal("*", commander.AllowedTools[0]);
        Assert.Equal(6, commander.MaxSteps);
        Assert.True(commander.Enabled);

        // 缺省 enabled 默认 true
        var scout = catalog.Find("SCOUT")!;
        Assert.True(scout.Enabled);
        Assert.Equal(4, scout.MaxSteps);
    }

    [Fact]
    public void UnknownKey_ReturnsNull()
    {
        var catalog = new AgentCatalog(_file, LoggerFactoryHolder.Create<AgentCatalog>());
        Assert.Null(catalog.Find("nope"));
    }

    [Fact]
    public void HotReload_PicksUpFileChanges()
    {
        var catalog = new AgentCatalog(_file, LoggerFactoryHolder.Create<AgentCatalog>());
        Assert.Equal(2, catalog.GetAll().Count);

        // 追加第三个 Agent 触发热加载
        File.AppendAllText(_file, """

              - key: analyst
                name: analyst
                displayName: 分析
                description: 数据
                systemPrompt: |
                  你是分析。
                allowedTools: []
            """);

        Assert.Equal(3, catalog.GetAll().Count);
        Assert.NotNull(catalog.Find("analyst"));
    }

    [Fact]
    public void MissingSystemPrompt_Throws()
    {
        var badFile = _file + ".bad";
        File.WriteAllText(badFile, """
            agents:
              - key: broken
                name: broken
                systemPrompt: ""
            """);
        try
        {
            var catalog = new AgentCatalog(badFile, LoggerFactoryHolder.Create<AgentCatalog>());
            Assert.Throws<ApiException>(() => catalog.GetAll());
        }
        finally
        {
            File.Delete(badFile);
        }
    }
}

public static class LoggerFactoryHolder
{
    public static ILoggerFactory CreateFactory() => LoggerFactory.Create(_ => { });

    public static ILogger<T> Create<T>() => CreateFactory().CreateLogger<T>();
}

public class ToolRegistryWildcardTests
{
    private static ToolDescriptor Tool(string serverId, string name) =>
        new(serverId, name, "测试", "{}", null);

    private sealed class StaticProvider(IReadOnlyList<ToolDescriptor> tools) : IToolProvider
    {
        public IReadOnlyList<ToolDescriptor> ListTools() => tools;

        public Task<ToolEnvelope> InvokeAsync(ToolDescriptor tool, System.Text.Json.JsonElement arguments, ToolContext context, CancellationToken cancellationToken) =>
            throw new NotImplementedException();
    }

    private static AgentProfile Profile(params string[] allowed) =>
        new("agent", "agent", "Agent", "", "prompt", allowed, 8, true);

    [Fact]
    public void WildcardStar_AllowsEverything()
    {
        var registry = new ToolRegistry(
            [new StaticProvider([Tool("builtin", "get_status"), Tool("mcp-demo", "get_market_notes")])],
            LoggerFactoryHolder.Create<ToolRegistry>());

        var tools = registry.ResolveForAgent(Profile("*"));
        Assert.Equal(2, tools.Count);
    }

    [Fact]
    public void ServerWildcard_AndExactEntries()
    {
        var registry = new ToolRegistry(
            [new StaticProvider([
                Tool("builtin", "get_workspace_status"),
                Tool("builtin", "save_scratch_note"),
                Tool("builtin", "publish_announcement"),
                Tool("mcp-demo", "get_market_notes")
            ])],
            LoggerFactoryHolder.Create<ToolRegistry>());

        var tools = registry.ResolveForAgent(Profile(
            "builtin.get_workspace_status", "builtin.save_scratch_note", "mcp-demo.*"));

        Assert.Equal(3, tools.Count);
        Assert.All(tools, t => Assert.NotEqual("publish_announcement", t.Descriptor.Name));
    }

    [Fact]
    public void EmptyAllowedTools_AllowsNothing()
    {
        var registry = new ToolRegistry(
            [new StaticProvider([Tool("builtin", "get_status")])],
            LoggerFactoryHolder.Create<ToolRegistry>());

        Assert.Empty(registry.ResolveForAgent(Profile()));
    }

    [Fact]
    public void WildcardAuthorization_AssemblesAllTools_WithoutLimit()
    {
        // 取消 MaxToolsPerRun 后：通配授权下工具全量装配，不因数量拒绝启动、不静默截断。
        // 用 20 个（远超原 8 / 12 上限）确保「数量上限」确实已不复存在。
        var tools = Enumerable.Range(0, 20)
            .Select(i => Tool("server", $"get_tool_{i}"))
            .ToList();
        var registry = new ToolRegistry(
            [new StaticProvider(tools)],
            LoggerFactoryHolder.Create<ToolRegistry>());

        var assembled = registry.ResolveForAgent(Profile("*"));
        Assert.Equal(20, assembled.Count);
        Assert.Equal(20, assembled.Select(t => t.ModelName).Distinct().Count());
    }
}
