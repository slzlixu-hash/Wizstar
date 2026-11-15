using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Wizstar.Agents.Profiles;

/// <summary>
/// Agent 级 MCP 工具切片（Tool Slicing）持久化。
///
/// 设计口径：
///   - agents.yaml 的 allowedTools 是「名册默认授权」；
///   - 本文件保存运营在管理界面里对某个 MCP 服务的精确勾选，覆盖该服务的默认授权；
///   - 未配置切片的服务继续沿用 agents.yaml，避免一次保存把其它服务误伤；
///   - 运行时只看「该 Agent + 该 MCP 服务」的切片，不涉及内置工具与 Skill 授权。
///
/// 文件结构（config/agent-mcp-policies.json）：
/// {
///   "commander": {
///     "mcp-1688": ["search_products", "get_offer"]
///   }
/// }
/// </summary>
public sealed class AgentMcpPolicyStore(string filePath, ILogger<AgentMcpPolicyStore> logger)
{
    private readonly object _lock = new();
    private Dictionary<string, Dictionary<string, List<string>>> _slices = new(StringComparer.Ordinal);
    private DateTime _lastWriteUtc;
    private bool _loaded;

    public string FilePath => filePath;

    public IReadOnlyDictionary<string, IReadOnlyList<string>> GetAgentSlices(string agentKey)
    {
        var key = Normalize(agentKey);
        lock (_lock)
        {
            EnsureLoaded();
            if (!_slices.TryGetValue(key, out var servers))
            {
                return new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
            }

            return servers.ToDictionary(
                pair => pair.Key,
                pair => (IReadOnlyList<string>)pair.Value.ToList(),
                StringComparer.Ordinal);
        }
    }

    /// <summary>返回 null 表示该服务没有切片，运行时继续沿用 agents.yaml 的默认授权。</summary>
    public IReadOnlyList<string>? GetSlice(string agentKey, string serverId)
    {
        var key = Normalize(agentKey);
        var server = Normalize(serverId);
        lock (_lock)
        {
            EnsureLoaded();
            return _slices.TryGetValue(key, out var servers) && servers.TryGetValue(server, out var tools)
                ? tools.ToList()
                : null;
        }
    }

    public bool HasAgentPolicy(string agentKey)
    {
        var key = Normalize(agentKey);
        lock (_lock)
        {
            EnsureLoaded();
            return _slices.TryGetValue(key, out var servers) && servers.Count > 0;
        }
    }

    /// <summary>运行时逐工具判定：没有该服务的切片 → 放行（沿用名册默认授权）。</summary>
    public bool Allows(string agentKey, string serverId, string toolName)
    {
        var key = Normalize(agentKey);
        var server = Normalize(serverId);
        lock (_lock)
        {
            EnsureLoaded();
            if (!_slices.TryGetValue(key, out var servers) || !servers.TryGetValue(server, out var tools))
            {
                return true;
            }

            return tools.Any(name => string.Equals(name, toolName, StringComparison.Ordinal));
        }
    }

    public IReadOnlyList<string> SetSlice(string agentKey, string serverId, IEnumerable<string> tools)
    {
        var key = Normalize(agentKey);
        var server = Normalize(serverId);
        var normalized = tools
            .Select(t => (t ?? string.Empty).Trim())
            .Where(t => t.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(t => t, StringComparer.Ordinal)
            .ToList();

        lock (_lock)
        {
            EnsureLoaded();
            if (!_slices.TryGetValue(key, out var servers))
            {
                servers = new Dictionary<string, List<string>>(StringComparer.Ordinal);
                _slices[key] = servers;
            }
            servers[server] = normalized;
            Persist();
            return normalized;
        }
    }

    public bool ClearSlice(string agentKey, string serverId)
    {
        var key = Normalize(agentKey);
        var server = Normalize(serverId);
        lock (_lock)
        {
            EnsureLoaded();
            if (!_slices.TryGetValue(key, out var servers) || !servers.Remove(server))
            {
                return false;
            }
            if (servers.Count == 0)
            {
                _slices.Remove(key);
            }
            Persist();
            return true;
        }
    }

    private void EnsureLoaded()
    {
        if (_loaded && !FileChanged())
        {
            return;
        }

        if (!File.Exists(filePath))
        {
            _slices = new Dictionary<string, Dictionary<string, List<string>>>(StringComparer.Ordinal);
            _loaded = true;
            _lastWriteUtc = DateTime.MinValue;
            return;
        }

        try
        {
            var json = File.ReadAllText(filePath);
            var parsed = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, List<string>>>>(
                json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            _slices = new Dictionary<string, Dictionary<string, List<string>>>(StringComparer.Ordinal);
            if (parsed is not null)
            {
                foreach (var agent in parsed)
                {
                    var key = Normalize(agent.Key);
                    if (key.Length == 0 || agent.Value is null)
                    {
                        continue;
                    }

                    var servers = new Dictionary<string, List<string>>(StringComparer.Ordinal);
                    foreach (var server in agent.Value)
                    {
                        var serverId = Normalize(server.Key);
                        if (serverId.Length == 0)
                        {
                            continue;
                        }
                        servers[serverId] = (server.Value ?? [])
                            .Select(t => (t ?? string.Empty).Trim())
                            .Where(t => t.Length > 0)
                            .Distinct(StringComparer.Ordinal)
                            .OrderBy(t => t, StringComparer.Ordinal)
                            .ToList();
                    }
                    if (servers.Count > 0)
                    {
                        _slices[key] = servers;
                    }
                }
            }

            _loaded = true;
            _lastWriteUtc = File.GetLastWriteTimeUtc(filePath);
            logger.LogInformation("Agent MCP 切片已加载: 文件={File} Agent数={Count}", filePath, _slices.Count);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            _loaded = true;
            _lastWriteUtc = File.Exists(filePath) ? File.GetLastWriteTimeUtc(filePath) : DateTime.MinValue;
            logger.LogWarning(ex, "Agent MCP 切片加载失败，沿用当前内存快照: 文件={File}", filePath);
        }
    }

    private bool FileChanged() =>
        File.Exists(filePath) && File.GetLastWriteTimeUtc(filePath) != _lastWriteUtc;

    private void Persist()
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(filePath));
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var json = JsonSerializer.Serialize(_slices, new JsonSerializerOptions { WriteIndented = true });
        var temp = filePath + ".tmp";
        File.WriteAllText(temp, json);
        File.Move(temp, filePath, overwrite: true);
        _lastWriteUtc = File.GetLastWriteTimeUtc(filePath);
        logger.LogInformation("Agent MCP 切片已保存: 文件={File} Agent数={Count}", filePath, _slices.Count);
    }

    private static string Normalize(string? value) => (value ?? string.Empty).Trim().ToLowerInvariant();
}
