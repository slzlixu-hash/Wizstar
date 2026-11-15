using YamlDotNet.Core;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace Wizstar.Api.Pipelines;

/// <summary>
/// 工作流配方目录：加载 `<c>pipelines/*.yaml</c>`，文件变更自动热加载。
///
/// 与 AgentCatalog / McpCatalog 同一口径：
///  - 只读配置文件，不在代码里写死任何来源分支；
///  - 单文件解析失败只影响该文件，问题进 <see cref="Issues"/> 如实下发；
///  - 校验覆盖：ID 重复、工序重复、next 悬空、环形链路、trigger_source 冲突。
/// </summary>
public sealed class PipelineCatalog
{
    private readonly object _lock = new();
    private readonly ILogger<PipelineCatalog> _logger;
    private readonly IDeserializer _deserializer;

    private Dictionary<string, PipelineRecipe> _byId = new(StringComparer.Ordinal);
    private Dictionary<string, string> _sourceToId = new(StringComparer.OrdinalIgnoreCase);
    private List<PipelineIssue> _issues = [];
    private DateTime _lastWriteUtc = DateTime.MinValue;
    private bool _loaded;

    public PipelineCatalog(string directory, ILogger<PipelineCatalog> logger)
    {
        Directory = directory;
        _logger = logger;
        _deserializer = new DeserializerBuilder()
            .WithNamingConvention(UnderscoredNamingConvention.Instance)
            .IgnoreUnmatchedProperties()
            .Build();
    }

    /// <summary>配方目录（绝对路径或相对 ContentRoot）。</summary>
    public string Directory { get; }

    public IReadOnlyList<PipelineIssue> Issues
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

    public IReadOnlyList<PipelineRecipe> All()
    {
        ReloadIfChanged();
        lock (_lock)
        {
            return _byId.Values.ToList();
        }
    }

    public PipelineRecipe? Get(string? pipelineId)
    {
        if (string.IsNullOrWhiteSpace(pipelineId))
        {
            return null;
        }
        ReloadIfChanged();
        lock (_lock)
        {
            return _byId.GetValueOrDefault(pipelineId.Trim());
        }
    }

    /// <summary>按选品来源解析配方（来源→配方的映射完全由 YAML 声明）。</summary>
    public PipelineRecipe? ResolveBySource(string? source)
    {
        if (string.IsNullOrWhiteSpace(source))
        {
            return null;
        }
        ReloadIfChanged();
        lock (_lock)
        {
            if (!_sourceToId.TryGetValue(source.Trim(), out var id))
            {
                return null;
            }
            var recipe = _byId.GetValueOrDefault(id);
            // 停用的配方不参与来源解析（任务按 pipeline_id 绑定仍可继续）
            return recipe is { Enabled: false } ? null : recipe;
        }
    }

    /// <summary>编辑器保存 / 删除后立即重载（文件 mtime 可能在同一秒内不变）。</summary>
    public void ReloadNow()
    {
        lock (_lock)
        {
            _loaded = false;
        }
        ReloadIfChanged();
    }

    // ---------------------------------------------------------------- 加载与校验

    public void ReloadIfChanged()
    {
        var files = EnumerateFiles();
        var stamp = ComputeStamp(files);

        lock (_lock)
        {
            if (_loaded && stamp == _lastWriteUtc)
            {
                return;
            }
        }

        var issues = new List<PipelineIssue>();
        var byId = new Dictionary<string, PipelineRecipe>(StringComparer.Ordinal);
        var bySource = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var file in files)
        {
            PipelineRecipe? recipe;
            try
            {
                recipe = _deserializer.Deserialize<PipelineRecipe>(File.ReadAllText(file));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or YamlException)
            {
                issues.Add(new PipelineIssue("error", $"{Path.GetFileName(file)} 解析失败：{ex.Message}"));
                continue;
            }

            if (recipe is null)
            {
                issues.Add(new PipelineIssue("error", $"{Path.GetFileName(file)} 内容为空"));
                continue;
            }

            var fileName = Path.GetFileName(file);
            if (string.IsNullOrWhiteSpace(recipe.PipelineId))
            {
                issues.Add(new PipelineIssue("error", $"{fileName} 缺少 pipeline_id"));
                continue;
            }
            if (string.IsNullOrWhiteSpace(recipe.TriggerSource))
            {
                issues.Add(new PipelineIssue("error", $"{fileName} 缺少 trigger_source（来源→配方映射必需）"));
                continue;
            }
            if (recipe.Stages.Count == 0)
            {
                issues.Add(new PipelineIssue("error", $"{fileName} 未定义任何工序（stages）"));
                continue;
            }

            ValidateRecipe(recipe, fileName, issues, out var fatal);
            if (fatal)
            {
                continue;
            }

            if (!byId.TryAdd(recipe.PipelineId, recipe))
            {
                issues.Add(new PipelineIssue("error", $"{fileName} 的 pipeline_id={recipe.PipelineId} 重复，已忽略该文件"));
                continue;
            }

            if (bySource.TryGetValue(recipe.TriggerSource, out var existing))
            {
                issues.Add(new PipelineIssue("warn",
                    $"{fileName} 的 trigger_source={recipe.TriggerSource} 已被 {existing} 占用，按先加载者生效"));
            }
            else
            {
                bySource[recipe.TriggerSource] = recipe.PipelineId;
            }
        }

        lock (_lock)
        {
            _byId = byId;
            _sourceToId = bySource;
            _issues = issues;
            _lastWriteUtc = stamp;
            _loaded = true;
        }

        if (issues.Count > 0)
        {
            _logger.LogWarning("工作流配方加载完成：{Count} 条配方，{Issues} 个问题（目录 {Directory}）",
                byId.Count, issues.Count, Directory);
        }
        else
        {
            _logger.LogInformation("工作流配方加载完成：{Count} 条配方（目录 {Directory}）", byId.Count, Directory);
        }
    }

    /// <summary>配方校验（供编辑器保存 / 导入复用）。</summary>
    public static void ValidateRecipe(PipelineRecipe recipe, string fileName, List<PipelineIssue> issues, out bool fatal)
    {
        fatal = false;
        var codes = new HashSet<string>(StringComparer.Ordinal);
        foreach (var stage in recipe.Stages)
        {
            if (string.IsNullOrWhiteSpace(stage.Code))
            {
                issues.Add(new PipelineIssue("error", $"{fileName} 存在空 code 的工序"));
                fatal = true;
                return;
            }
            if (!codes.Add(stage.Code))
            {
                issues.Add(new PipelineIssue("error", $"{fileName} 工序 code={stage.Code} 重复"));
                fatal = true;
                return;
            }
            if (!string.Equals(stage.Type, PipelineStageTypes.Auto, StringComparison.OrdinalIgnoreCase)
                && !string.Equals(stage.Type, PipelineStageTypes.HumanGate, StringComparison.OrdinalIgnoreCase))
            {
                issues.Add(new PipelineIssue("error", $"{fileName} 工序 {stage.Code} 的 type={stage.Type} 非法（auto|hitl_gate）"));
                fatal = true;
                return;
            }
            if (stage.IsHumanGate && string.IsNullOrWhiteSpace(stage.AutoRule))
            {
                issues.Add(new PipelineIssue("warn", $"{fileName} 闸口 {stage.Code} 未声明 auto_rule，审核面板将无判定口径"));
            }
        }

        // next 必须指向存在的工序
        foreach (var stage in recipe.Stages)
        {
            if (!string.IsNullOrWhiteSpace(stage.Next) && !codes.Contains(stage.Next))
            {
                issues.Add(new PipelineIssue("error", $"{fileName} 工序 {stage.Code} 的 next={stage.Next} 不存在"));
                fatal = true;
                return;
            }
        }

        // 环检测：从首节点沿 next 走，步数不得超过工序数
        var cursor = recipe.FirstStage;
        var visited = new HashSet<string>(StringComparer.Ordinal);
        while (cursor is not null)
        {
            if (!visited.Add(cursor.Code))
            {
                issues.Add(new PipelineIssue("error", $"{fileName} 存在环形链路（{cursor.Code} 重复出现）"));
                fatal = true;
                return;
            }
            cursor = string.IsNullOrWhiteSpace(cursor.Next) ? null : recipe.FindStage(cursor.Next);
        }

        if (visited.Count != recipe.Stages.Count)
        {
            issues.Add(new PipelineIssue("warn",
                $"{fileName} 有 {recipe.Stages.Count - visited.Count} 个工序不在首节点的主链路上（无法被自动推进）"));
        }

        // 自动节点既没有 agent 也没有 skill：能登记但只能人工完成
        foreach (var stage in recipe.Stages.Where(s => !s.IsHumanGate && string.IsNullOrWhiteSpace(s.Agent) && string.IsNullOrWhiteSpace(s.Skill)))
        {
            issues.Add(new PipelineIssue("warn", $"{fileName} 自动工序 {stage.Code} 未声明 agent/skill，需要人工推进"));
        }
    }

    private List<string> EnumerateFiles()
    {
        try
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
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "工作流配方目录不可读: {Directory}", Directory);
            return [];
        }
    }

    private static DateTime ComputeStamp(List<string> files)
    {
        var stamp = DateTime.MinValue;
        foreach (var file in files)
        {
            try
            {
                var write = File.GetLastWriteTimeUtc(file);
                if (write > stamp)
                {
                    stamp = write;
                }
            }
            catch (IOException)
            {
                // 文件正在被写入：下一次重载再看
            }
        }
        return stamp;
    }
}
