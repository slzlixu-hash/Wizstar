using YamlDotNet.Core;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace Wizstar.Agents.Skills;

/// <summary>
/// Skill 目录：加载 <c>skills/*.yaml</c>（一文件一技能），文件变更自动热加载。
/// 单文件解析失败只影响该文件并进入 Issues，不阻塞其余技能。
/// </summary>
public sealed class SkillCatalog
{
    private readonly object _lock = new();
    private readonly ILogger<SkillCatalog> _logger;
    private readonly IDeserializer _deserializer;

    private Dictionary<string, SkillDefinition> _byCode = new(StringComparer.Ordinal);
    private List<SkillIssue> _issues = [];
    private DateTime _lastWriteUtc = DateTime.MinValue;
    private bool _loaded;

    public SkillCatalog(string directory, ILogger<SkillCatalog> logger)
    {
        Directory = Path.GetFullPath(directory);
        _logger = logger;
        _deserializer = new DeserializerBuilder()
            .WithNamingConvention(UnderscoredNamingConvention.Instance)
            .IgnoreUnmatchedProperties()
            .Build();
    }

    public string Directory { get; }

    public IReadOnlyList<SkillIssue> Issues
    {
        get
        {
            ReloadIfChanged();
            lock (_lock)
            {
                return _issues.ToList();
            }
        }
    }

    public IReadOnlyList<SkillDefinition> All()
    {
        ReloadIfChanged();
        lock (_lock)
        {
            return _byCode.Values
                .OrderByDescending(s => s.Enabled)
                .ThenBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }
    }

    public SkillDefinition? Get(string? code)
    {
        if (string.IsNullOrWhiteSpace(code))
        {
            return null;
        }
        ReloadIfChanged();
        lock (_lock)
        {
            return _byCode.GetValueOrDefault(code.Trim());
        }
    }

    public string? GetSourcePath(string code)
    {
        ReloadIfChanged();
        lock (_lock)
        {
            return _byCode.TryGetValue(code, out var skill) ? skill.SourcePath : null;
        }
    }

    public void ReloadNow()
    {
        lock (_lock)
        {
            _loaded = false;
        }
        ReloadIfChanged();
    }

    public SkillDefinition? Parse(string yaml, out string? error)
    {
        try
        {
            var skill = _deserializer.Deserialize<SkillDefinition>(yaml);
            error = skill is null ? "YAML 内容为空" : null;
            return skill;
        }
        catch (Exception ex) when (ex is YamlException or IOException)
        {
            error = "YAML 解析失败：" + ex.Message;
            return null;
        }
    }

    private void ReloadIfChanged()
    {
        var files = EnumerateFiles();
        var stamp = files.Count == 0
            ? DateTime.MinValue
            : files.Max(f => File.GetLastWriteTimeUtc(f));
        lock (_lock)
        {
            if (_loaded && stamp == _lastWriteUtc)
            {
                return;
            }
        }

        var issues = new List<SkillIssue>();
        var byCode = new Dictionary<string, SkillDefinition>(StringComparer.Ordinal);
        foreach (var file in files)
        {
            SkillDefinition? skill;
            try
            {
                skill = _deserializer.Deserialize<SkillDefinition>(File.ReadAllText(file));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or YamlException)
            {
                issues.Add(new SkillIssue("error", $"{Path.GetFileName(file)} 解析失败：{ex.Message}"));
                continue;
            }

            if (skill is null)
            {
                issues.Add(new SkillIssue("error", $"{Path.GetFileName(file)} 内容为空"));
                continue;
            }

            var normalized = SkillRules.Normalize(skill);
            normalized.SourcePath = file;
            if (!SkillRules.IsValidCode(normalized.Code))
            {
                issues.Add(new SkillIssue("error", $"{Path.GetFileName(file)} 的 code 不合法（需小写字母/数字/-/_）"));
                continue;
            }
            if (string.IsNullOrWhiteSpace(normalized.Name))
            {
                issues.Add(new SkillIssue("error", $"{Path.GetFileName(file)} 缺少 name"));
                continue;
            }
            if (string.IsNullOrWhiteSpace(normalized.Agent))
            {
                issues.Add(new SkillIssue("error", $"{Path.GetFileName(file)} 缺少 agent"));
                continue;
            }
            if (byCode.ContainsKey(normalized.Code))
            {
                issues.Add(new SkillIssue("error", $"{Path.GetFileName(file)} 的 code 重复：{normalized.Code}"));
                continue;
            }
            byCode[normalized.Code] = normalized;
        }

        lock (_lock)
        {
            _byCode = byCode;
            _issues = issues;
            _lastWriteUtc = stamp;
            _loaded = true;
        }

        _logger.LogInformation("Skill 目录加载完成: {Count} 个技能（{Directory}）",
            byCode.Count, Directory);
    }

    private List<string> EnumerateFiles()
    {
        if (!System.IO.Directory.Exists(Directory))
        {
            return [];
        }
        return System.IO.Directory
            .EnumerateFiles(Directory, "*.yaml", SearchOption.TopDirectoryOnly)
            .Concat(System.IO.Directory.EnumerateFiles(Directory, "*.yml", SearchOption.TopDirectoryOnly))
            .OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }
}
