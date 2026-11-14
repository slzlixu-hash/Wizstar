using System.Text.Json;
using System.Text.Json.Nodes;

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
            Builtin = node.TryGetProperty("builtin", out var builtinNode) && builtinNode.ValueKind == JsonValueKind.True,
            AuthType = Get("authType"),
            AuthHeaderName = Get("authHeaderName"),
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

    /// <summary>运行时停用（保留清单条目）：状态置 Disabled、清空工具缓存，数据不删。</summary>
    public void SetDisabled(string id, string reason)
    {
        lock (_lock)
        {
            if (_states.TryGetValue(id, out var state))
            {
                state.State = McpServiceState.Disabled;
                state.LastError = reason;
                state.Tools = [];
                logger.LogInformation("MCP 服务已停用（清单保留）: {Id} 原因={Reason}", id, reason);
            }
        }
    }

    // ---------------------------------------------------------------- 声明清单写入
    /// <summary>管理界面写入：新增 / 更新一条服务声明，原子落盘后立刻热加载。</summary>
    public McpServiceConfig UpsertConfig(McpServiceConfig config)
    {
        var id = NormalizeId(config.Id);
        if (string.IsNullOrEmpty(id))
        {
            throw new ArgumentException("服务 ID 不合法", nameof(config));
        }

        lock (_lock)
        {
            var path = Path.GetFullPath(ConfigPath);
            var root = ReadConfigRoot(path);
            var servers = EnsureServersObject(root);
            var previous = servers[id] as JsonObject;

            // 凭证明文不回显给前端：编辑时未提交则沿用清单中的旧值。
            var keyId = config.AuthKeyId ?? previous?["authKeyId"]?.GetValue<string>();
            var secret = config.AuthSecret ?? previous?["authSecret"]?.GetValue<string>();
            var credential = config.ShopCredential ?? previous?["shopCredential"]?.GetValue<string>();
            // 鉴权模式：显式提交优先；未提交（null）沿用旧值；旧清单只有密钥对时归一化为 hmac。
            var authType = McpAuthTypes.Normalize(
                config.AuthType ?? previous?["authType"]?.GetValue<string>(),
                !string.IsNullOrWhiteSpace(keyId) && !string.IsNullOrWhiteSpace(secret));
            var headerName = config.AuthHeaderName ?? previous?["authHeaderName"]?.GetValue<string>();
            // 内置标记：界面新建的外部服务不带 builtin；编辑时沿用清单旧值，防止把内置服务改丢。
            // 内置属性不可通过编辑移除（内置可改配置、不可删除）。
            var builtin = config.Builtin || previous?["builtin"]?.GetValue<bool>() == true;

            var node = new JsonObject
            {
                ["name"] = string.IsNullOrWhiteSpace(config.Name) ? id : config.Name,
                ["transport"] = string.IsNullOrWhiteSpace(config.Transport) ? "http" : config.Transport.Trim().ToLowerInvariant(),
                ["autoStart"] = config.AutoStart,
                ["authType"] = authType
            };
            if (!string.IsNullOrWhiteSpace(config.Url)) node["url"] = config.Url;
            if (!string.IsNullOrWhiteSpace(config.Command)) node["command"] = config.Command;
            if (config.Args is { Length: > 0 })
            {
                node["args"] = new JsonArray(config.Args.Select(a => (JsonNode?)JsonValue.Create(a)).ToArray());
            }
            if (config.Env is { Count: > 0 })
            {
                var env = new JsonObject();
                foreach (var pair in config.Env) env[pair.Key] = pair.Value;
                node["env"] = env;
            }
            if (authType == McpAuthTypes.Header && !string.IsNullOrWhiteSpace(headerName)) node["authHeaderName"] = headerName;
            if (builtin) node["builtin"] = true;
            if (!string.IsNullOrWhiteSpace(keyId)) node["authKeyId"] = keyId;
            if (!string.IsNullOrWhiteSpace(secret)) node["authSecret"] = secret;
            if (!string.IsNullOrWhiteSpace(credential)) node["shopCredential"] = credential;

            servers[id] = node;
            WriteConfigRoot(path, root);
            ForceReload();
        }

        return GetConfig(id)!;
    }

    /// <summary>从清单移除服务声明；对应运行时状态按「只停用不删数据」处理。</summary>
    public bool RemoveConfig(string id)
    {
        var key = NormalizeId(id);
        lock (_lock)
        {
            var path = Path.GetFullPath(ConfigPath);
            var root = ReadConfigRoot(path);
            var servers = EnsureServersObject(root);
            if (!servers.Remove(key))
            {
                return false;
            }

            WriteConfigRoot(path, root);
            ForceReload();
            MarkRemoved(key);
        }
        return true;
    }

    public static string NormalizeId(string? id) => (id ?? string.Empty).Trim().ToLowerInvariant();

    private void ForceReload()
    {
        // 同一秒内连续写入时文件时间戳可能不变，显式失效避免读到旧清单。
        _configLoaded = false;
        ReloadIfChanged();
    }

    private static JsonObject ReadConfigRoot(string path)
    {
        if (!File.Exists(path) || string.IsNullOrWhiteSpace(File.ReadAllText(path)))
        {
            return new JsonObject { ["mcpServers"] = new JsonObject() };
        }

        return JsonNode.Parse(File.ReadAllText(path)) as JsonObject
            ?? throw new InvalidOperationException("MCP 清单根节点不是 JSON 对象");
    }

    private static JsonObject EnsureServersObject(JsonObject root)
    {
        if (root["mcpServers"] is JsonObject servers)
        {
            return servers;
        }

        var created = new JsonObject();
        root["mcpServers"] = created;
        return created;
    }

    private static void WriteConfigRoot(string path, JsonObject root)
    {
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        // 与 API 层同一口径：中文不转 \uXXXX，保持清单文件人类可读。
        var json = root.ToJsonString(new JsonSerializerOptions
        {
            WriteIndented = true,
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
        });
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, json, new System.Text.UTF8Encoding(false));
        File.Move(tmp, path, true);
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
                var cfg = _configs.GetValueOrDefault(id);
                snapshots.Add(new McpServiceSnapshot(
                    id,
                    cfg?.Name ?? id,
                    cfg?.Transport ?? "http",
                    state.State,
                    state.ProtocolVersion,
                    state.ServerName,
                    state.ServerVersion,
                    state.Tools.Count,
                    state.LastError,
                    state.ConnectedAt,
                    state.ToolsFetchedAt,
                    cfg?.Url,
                    cfg?.AutoStart ?? false,
                    cfg?.AuthKeyId,
                    !string.IsNullOrWhiteSpace(cfg?.AuthSecret),
                    cfg?.EffectiveAuthType ?? McpAuthTypes.None,
                    cfg?.AuthHeaderName,
                    cfg?.Builtin ?? false));
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
