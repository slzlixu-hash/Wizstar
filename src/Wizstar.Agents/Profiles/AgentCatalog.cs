using System.IO;
using System.Security;
using Wizstar.Contracts;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace Wizstar.Agents.Profiles;

/// <summary>
/// Agent 名册：只读加载 config/agents.yaml，文件变更自动热加载。
/// 加载失败保留上一份有效快照并记录 LastError，不吞掉也不崩进程。
/// </summary>
public sealed class AgentCatalog(string filePath, ILogger<AgentCatalog> logger)
{
    private readonly object _lock = new();
    private readonly IDeserializer _deserializer = new DeserializerBuilder()
        .WithNamingConvention(CamelCaseNamingConvention.Instance)
        .Build();

    private List<AgentProfile> _profiles = [];
    private DateTime _lastWriteUtc;
    private bool _loaded;

    public string? LastError { get; private set; }

    public IReadOnlyList<AgentProfile> GetAll()
    {
        EnsureLoaded();
        lock (_lock)
        {
            return _profiles;
        }
    }

    public AgentProfile? Find(string key)
    {
        var normalized = (key ?? string.Empty).Trim().ToLowerInvariant();
        return GetAll().FirstOrDefault(p => string.Equals(p.Key, normalized, StringComparison.Ordinal));
    }

    private void EnsureLoaded()
    {
        lock (_lock)
        {
            if (_loaded && !FileChanged())
            {
                return;
            }

            try
            {
                var profiles = LoadFromFile();
                _profiles = profiles;
                _lastWriteUtc = File.GetLastWriteTimeUtc(filePath);
                LastError = null;
                _loaded = true;
                logger.LogInformation("Agent 名册已加载: 文件={File}, 数量={Count}", filePath, profiles.Count);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or SecurityException or YamlDotNet.Core.YamlException)
            {
                LastError = ex.Message;
                if (!_loaded)
                {
                    // 首次加载失败：宁可启动失败也不拿空名册假装正常
                    throw ApiException.Internal($"Agent 名册加载失败（{filePath}）：{ex.Message}");
                }
                logger.LogWarning(ex, "Agent 名册热加载失败，沿用上一份快照: 文件={File}", filePath);
            }
        }
    }

    private bool FileChanged() =>
        File.Exists(filePath) && File.GetLastWriteTimeUtc(filePath) != _lastWriteUtc;

    private List<AgentProfile> LoadFromFile()
    {
        if (!File.Exists(filePath))
        {
            throw new IOException($"名册文件不存在: {filePath}");
        }

        var yaml = File.ReadAllText(filePath);
        var file = _deserializer.Deserialize<AgentFile>(yaml) ?? new AgentFile();

        var profiles = new List<AgentProfile>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in file.Agents)
        {
            var key = entry.Key.Trim().ToLowerInvariant();
            if (key.Length == 0)
            {
                throw ApiException.Validation("agents.yaml 存在空 key 的条目");
            }

            if (!seen.Add(key))
            {
                throw ApiException.Validation($"agents.yaml 存在重复 key: {key}");
            }

            if (string.IsNullOrWhiteSpace(entry.SystemPrompt))
            {
                throw ApiException.Validation($"Agent {key} 缺少 systemPrompt（人设必须由后端固化）");
            }

            profiles.Add(new AgentProfile(
                key,
                string.IsNullOrWhiteSpace(entry.Name) ? key : entry.Name.Trim(),
                string.IsNullOrWhiteSpace(entry.DisplayName) ? entry.Name : entry.DisplayName.Trim(),
                entry.Description?.Trim() ?? string.Empty,
                entry.SystemPrompt,
                entry.AllowedTools ?? [],
                Math.Clamp(entry.MaxSteps, 1, 32),
                entry.Enabled));
        }

        return profiles;
    }
}
