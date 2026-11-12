using System.Text.Json;

namespace Wizstar.Mcp;

/// <summary>
/// MCP 服务目录（运行时状态中枢）：
///  - 加载声明式清单 config/mcp-services.json（文件变更自动重载）；
///  - 维护每个服务的运行状态与工具缓存（tools_json，即插即用 Step 1 的数据源）；
///  - 创建 McpJsonRpcClient（HttpClient 走 IHttpClientFactory "mcp" 命名客户端）。
///
/// 口径（v2.0 硬口径沿用）：对账只补缺、不覆盖用户状态；移除项只停用不删数据。
/// </summary>
public sealed class McpCatalog(IConfiguration configuration, IHttpClientFactory httpFactory, ILogger<McpCatalog> logger)
{
    private readonly object _lock = new();
    private readonly Dictionary<string, RuntimeState> _states = new(StringComparer.Ordinal);
    private readonly Dictionary<string, McpServiceConfig> _configs = new(StringComparer.Ordinal);
    private DateTime _configLastWriteUtc;
    private bool _configLoaded;
    private string? _configError;

    public string ConfigPath => configuration["Mcp:ConfigPath"] ?? "config/mcp-services.json";

    public string? ConfigError => _configError;

    // ---------------------------------------------------------------- 配置加载

    public void ReloadIfChanged()
    {
        lock (_lock)
        {
            try
            {
                var path = ConfigPath;
                if (!File.Exists(path))
                {
                    _configError = $"清单文件不存在: {path}（无声明项 = 不接入任何服务，属安全降级）";
                    _configs.Clear();
                    _configLoaded = true;
                    return;
                }

                if (_configLoaded && File.GetLastWriteTimeUtc(path) == _configLastWriteUtc)
                {
                    return;
                }

                var json = File.ReadAllText(path);
                using var document = JsonDocument.Parse(json);
                var configs = new Dictionary<string, McpServiceConfig>(StringComparer.Ordinal);

                if (document.RootElement.ValueKind == JsonValueKind.Object
                    && document.RootElement.TryGetProperty("mcpServers", out var servers)
                    && servers.ValueKind == JsonValueKind.Object)
                {
                    foreach (var property in servers.EnumerateObject())
                    {
                        var id = property.Name.Trim().ToLowerInvariant();
                        if (id.Length == 0 || property.Value.ValueKind != JsonValueKind.Object)
                        {
                            continue;
                        }

                        configs[id] = ParseConfig(id, property.Value);
                    }
                }

                _configs.Clear();
                foreach (var pair in configs)
                {
                    _configs[pair.Key] = pair.Value;
                }
                _configLastWriteUtc = File.GetLastWriteTimeUtc(path);
                _configError = null;
                _configLoaded = true;
                logger.LogInformation("MCP 服务清单已加载: 文件={File} 服务数={Count}", path, _configs.Count);
            }
            catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
            {
                _configError = ex.Message;
                logger.LogWarning(ex, "MCP 服务清单加载失败，沿用上一份快照: 文件={File}", ConfigPath);
            }
        }
    }

    private static McpServiceConfig ParseConfig(string id, JsonElement node)
    {
        string Get(string key, string fallback = "")
        {
            if (node.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String)
            {
                return value.GetString() ?? fallback;
            }

            return fallback;
        }

        var args = node.TryGetProperty("args", out var argsNode) && argsNode.ValueKind == JsonValueKind.Array
            ? argsNode.EnumerateArray().Select(a => a.GetString() ?? string.Empty).ToArray()
            : null;

        var env = node.TryGetProperty("env", out var envNode) && envNode.ValueKind == JsonValueKind.Object
            ? envNode.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString() ?? string.Empty)
            : null;

        return new McpServiceConfig
        {
            Id = id,
            Name = string.IsNullOrWhiteSpace(Get("name")) ? id : Get("name"),
            Transport = string.IsNullOrWhiteSpace(Get("transport", "http")) ? "http" : Get("transport", "http").Trim().ToLowerInvariant(),
            Url = node.TryGetProperty("url", out var urlNode) && urlNode.ValueKind == JsonValueKind.String ? urlNode.GetString() : null,
            Command = node.TryGetProperty("command", out var cmdNode) && cmdNode.ValueKind == JsonValueKind.String ? cmdNode.GetString() : null,
            Args = args,
            Env = env,
            AutoStart = node.TryGetProperty("autoStart", out var autoNode) && autoNode.ValueKind == JsonValueKind.True,
            AuthKeyId = node.TryGetProperty("authKeyId", out var keyNode) ? keyNode.GetString() : null,
            AuthSecret = node.TryGetProperty("authSecret", out var secretNode) ? secretNode.GetString() : null,
            ShopCredential = node.TryGetProperty("shopCredential", out var credNode) ? credNode.GetString() : null
        };
    }

    // ---------------------------------------------------------------- 状态管理

    public IReadOnlyList<string> ConfiguredIds
    {
        get
        {
            ReloadIfChanged();
            lock (_lock)
            {
                return _configs.Keys.ToList();
            }
        }
    }

    public McpServiceConfig? GetConfig(string id)
    {
        ReloadIfChanged();
        lock (_lock)
        {
            return _configs.GetValueOrDefault(id);
        }
    }

    public RuntimeState? GetState(string id)
    {
        lock (_lock)
        {
            return _states.GetValueOrDefault(id);
        }
    }

    /// <summary>获取或创建状态槽（对账只补缺：已存在的状态不覆盖）。</summary>
    public RuntimeState GetOrAddState(McpServiceConfig config)
    {
        lock (_lock)
        {
            if (_states.TryGetValue(config.Id, out var existing))
            {
                return existing;
            }

            var state = new RuntimeState(config.Id, config.Fingerprint());
            _states[config.Id] = state;
            return state;
        }
    }

    /// <summary>清单中已移除的服务：只停用不删数据（v2.0 硬口径）。</summary>
    public void MarkRemoved(string id)
    {
        lock (_lock)
        {
            if (_states.TryGetValue(id, out var state) && state.State != McpServiceState.Disabled)
            {
                state.State = McpServiceState.Disabled;
                state.LastError = "已从声明清单移除，服务停用（数据保留）";
                state.Tools = [];
                logger.LogInformation("MCP 服务已按清单移除并停用: {Id}", id);
            }
        }
    }

    public void SetError(string id, string error)
    {
        lock (_lock)
        {
            if (_states.TryGetValue(id, out var state))
            {
                state.State = McpServiceState.Error;
                state.LastError = error;
            }
        }
    }

    public void SetOffline(string id, string error)
    {
        lock (_lock)
        {
            if (_states.TryGetValue(id, out var state))
            {
                state.State = McpServiceState.Offline;
                state.LastError = error;
            }
        }
    }

    /// <summary>握手成功后写入完整状态与工具缓存（tools_json）。</summary>
    public void SetConnected(string id, string serverName, string serverVersion, string protocolVersion, IReadOnlyList<McpToolInfo> tools)
    {
        lock (_lock)
        {
            if (_states.TryGetValue(id, out var state))
            {
                state.State = McpServiceState.Connected;
                state.LastError = null;
                state.ServerName = serverName;
                state.ServerVersion = serverVersion;
                state.ProtocolVersion = protocolVersion;
                state.ConnectedAt = DateTimeOffset.Now;
                state.Tools = tools;
                state.ToolsFetchedAt = DateTimeOffset.Now;
            }
        }
    }

    public McpJsonRpcClient CreateClient(string id)
    {
        var config = GetConfig(id) ?? throw ApiException.Validation($"未声明的 MCP 服务: {id}");
        return new McpJsonRpcClient(id, config, httpFactory.CreateClient("mcp"), logger);
    }

    public IReadOnlyList<McpServiceSnapshot> ListSnapshots()
    {
        ReloadIfChanged();
        lock (_lock)
        {
            var snapshots = new List<McpServiceSnapshot>();
            foreach (var (id, state) in _states)
            {
                snapshots.Add(new McpServiceSnapshot(
                    id,
                    _configs.TryGetValue(id, out var config) ? config.Name : id,
                    _configs.TryGetValue(id, out var cfg) ? cfg.Transport : "http",
                    state.State,
                    state.ProtocolVersion,
                    state.ServerName,
                    state.ServerVersion,
                    state.Tools.Count,
                    state.LastError,
                    state.ConnectedAt,
                    state.ToolsFetchedAt));
            }

            return snapshots;
        }
    }

    /// <summary>运行时状态槽（内部可变，外部只读快照经 ListSnapshots）。</summary>
    public sealed class RuntimeState(string id, string fingerprint)
    {
        public string Id { get; } = id;
        public string ConfigFingerprint { get; set; } = fingerprint;
        public string State { get; set; } = McpServiceState.Connecting;
        public string ServerName { get; set; } = string.Empty;
        public string ServerVersion { get; set; } = string.Empty;
        public string ProtocolVersion { get; set; } = string.Empty;
        public string? LastError { get; set; }
        public DateTimeOffset? ConnectedAt { get; set; }
        public DateTimeOffset? ToolsFetchedAt { get; set; }
        public IReadOnlyList<McpToolInfo> Tools { get; set; } = [];
    }
}
