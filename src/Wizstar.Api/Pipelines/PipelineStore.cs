using System.Text;
using System.Text.RegularExpressions;
using SqlSugar;
using Wizstar.Contracts;
using Wizstar.Data.Entities.Business;
using YamlDotNet.Core;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace Wizstar.Api.Pipelines;

/// <summary>
/// 工作流配方写入器：编辑器保存 / 导入 / 删除 YAML（pipelines/*.yaml）。
///
/// 口径：
///  - 工序顺序即执行顺序：保存时按列表顺序重算 next 指针（线性链路），前端无需手写 next；
///  - 写盘前复用 <see cref="PipelineCatalog.ValidateRecipe"/> 校验，校验不过一律拒绝；
///  - 删除前检查是否仍被 sku_project 引用，避免把在跑任务的配方删掉；
///  - 写盘后立即 ReloadNow，编排器与运行台马上看到新配方。
/// </summary>
public sealed class PipelineStore(PipelineCatalog catalog, ISqlSugarClient db, ILogger<PipelineStore> logger)
{
    private static readonly Regex IdPattern = new("^[a-z0-9][a-z0-9._-]{0,63}$", RegexOptions.Compiled);

    private readonly ISerializer _serializer = new SerializerBuilder()
        .WithNamingConvention(UnderscoredNamingConvention.Instance)
        .Build();

    /// <summary>新建配方（ID 已存在则拒绝）。</summary>
    public PipelineRecipe Create(PipelineRecipe draft)
    {
        var recipe = Normalize(draft);
        var path = FilePath(recipe.PipelineId);
        // 文件名可能不等于 ID（YAML 可任意命名），因此同时检查目录里已加载的同 ID 配方
        if (File.Exists(path) || catalog.Get(recipe.PipelineId) is not null)
        {
            throw ApiException.Validation($"工作流配方已存在: {recipe.PipelineId}");
        }
        Write(path, Serialize(recipe));
        catalog.ReloadNow();
        return catalog.Get(recipe.PipelineId) ?? recipe;
    }

    /// <summary>更新配方（必须已存在）。</summary>
    public PipelineRecipe Update(string pipelineId, PipelineRecipe draft)
    {
        var id = NormalizeId(pipelineId);
        var path = FilePath(id);
        if (!File.Exists(path))
        {
            throw ApiException.Validation($"工作流配方不存在: {id}");
        }

        // 路由 ID 优先，避免改错条目
        draft.PipelineId = id;
        var recipe = Normalize(draft);
        Write(path, Serialize(recipe));
        catalog.ReloadNow();
        return catalog.Get(id) ?? recipe;
    }

    /// <summary>导入 YAML（同 ID 覆盖）。</summary>
    public PipelineRecipe Import(string? yaml)
    {
        if (string.IsNullOrWhiteSpace(yaml))
        {
            throw ApiException.Validation("YAML 内容不能为空");
        }

        PipelineRecipe? parsed;
        try
        {
            parsed = new DeserializerBuilder()
                .WithNamingConvention(UnderscoredNamingConvention.Instance)
                .IgnoreUnmatchedProperties()
                .Build()
                .Deserialize<PipelineRecipe>(yaml);
        }
        catch (YamlException ex)
        {
            throw ApiException.Validation("YAML 解析失败：" + ex.Message);
        }

        if (parsed is null)
        {
            throw ApiException.Validation("YAML 内容为空");
        }

        var recipe = Normalize(parsed);
        Write(FilePath(recipe.PipelineId), Serialize(recipe));
        catalog.ReloadNow();
        logger.LogInformation("导入工作流配方: {PipelineId}", recipe.PipelineId);
        return catalog.Get(recipe.PipelineId) ?? recipe;
    }

    /// <summary>预览草稿生成的 YAML（不落盘）。</summary>
    public string Preview(PipelineRecipe draft)
    {
        var recipe = Normalize(draft);
        Validate(recipe);
        return Serialize(recipe);
    }

    /// <summary>导出配方 YAML 文本。</summary>
    public string ExportYaml(string pipelineId)
    {
        var id = NormalizeId(pipelineId);
        var path = FilePath(id);
        if (File.Exists(path))
        {
            return File.ReadAllText(path);
        }

        var recipe = catalog.Get(id) ?? throw ApiException.Validation($"工作流配方不存在: {id}");
        return Serialize(recipe);
    }

    /// <summary>删除配方（仍被任务引用时拒绝）。</summary>
    public void Delete(string pipelineId)
    {
        var id = NormalizeId(pipelineId);
        var path = FilePath(id);
        if (!File.Exists(path))
        {
            throw ApiException.Validation($"工作流配方不存在: {id}");
        }

        try
        {
            if (db.Queryable<SkuProject>().Any(p => p.PipelineId == id))
            {
                throw ApiException.Validation($"该配方仍被任务使用（pipeline_id={id}），请先处理相关任务再删除");
            }
        }
        catch (ApiException)
        {
            throw;
        }
        catch (Exception ex)
        {
            // 商品表不可用：不阻塞删除，但记录日志
            logger.LogWarning(ex, "删除配方前检查任务引用失败: {PipelineId}", id);
        }

        File.Delete(path);
        catalog.ReloadNow();
        logger.LogInformation("删除工作流配方: {PipelineId}", id);
    }

    // ---------------------------------------------------------------- 内部

    private static string NormalizeId(string? pipelineId)
    {
        var id = (pipelineId ?? string.Empty).Trim().ToLowerInvariant();
        if (!IdPattern.IsMatch(id))
        {
            throw ApiException.Validation("配方 ID 只允许小写字母 / 数字 / ._-，且以字母或数字开头（最长 64 位）");
        }
        return id;
    }

    /// <summary>整理字段并按顺序重算 next 指针。</summary>
    private static PipelineRecipe Normalize(PipelineRecipe draft)
    {
        var id = NormalizeId(draft.PipelineId);
        var stages = (draft.Stages ?? [])
            .Where(s => s is not null)
            .Select(s => new PipelineStage
            {
                Code = (s.Code ?? string.Empty).Trim(),
                Name = string.IsNullOrWhiteSpace(s.Name) ? null : s.Name.Trim(),
                Type = string.IsNullOrWhiteSpace(s.Type) ? PipelineStageTypes.Auto : s.Type.Trim().ToLowerInvariant(),
                Agent = string.IsNullOrWhiteSpace(s.Agent) ? null : s.Agent.Trim(),
                Skill = string.IsNullOrWhiteSpace(s.Skill) ? null : s.Skill.Trim(),
                Mode = string.IsNullOrWhiteSpace(s.Mode) ? null : s.Mode.Trim(),
                Panel = string.IsNullOrWhiteSpace(s.Panel) ? null : s.Panel.Trim(),
                AutoRule = string.IsNullOrWhiteSpace(s.AutoRule) ? null : s.AutoRule.Trim(),
                RequireHuman = s.RequireHuman,
                Next = null,
            })
            .ToList();

        // 列表顺序即链路顺序
        for (var i = 0; i < stages.Count; i++)
        {
            stages[i].Next = i + 1 < stages.Count ? stages[i + 1].Code : null;
        }

        return new PipelineRecipe
        {
            PipelineId = id,
            Name = string.IsNullOrWhiteSpace(draft.Name) ? id : draft.Name.Trim(),
            TriggerSource = (draft.TriggerSource ?? string.Empty).Trim().ToLowerInvariant(),
            Description = string.IsNullOrWhiteSpace(draft.Description) ? null : draft.Description.Trim(),
            Enabled = draft.Enabled,
            Stages = stages,
        };
    }

    private static void Validate(PipelineRecipe recipe)
    {
        var issues = new List<PipelineIssue>();
        PipelineCatalog.ValidateRecipe(recipe, recipe.PipelineId + ".yaml", issues, out var fatal);
        var errors = issues.Where(i => i.Level == "error").Select(i => i.Message).ToList();
        if (fatal || errors.Count > 0)
        {
            throw ApiException.Validation("配方校验失败：" + string.Join("；", errors.DefaultIfEmpty("未知错误")));
        }
    }

    private string Serialize(PipelineRecipe recipe)
    {
        var header = new StringBuilder()
            .AppendLine("# 由工作流编排器保存（pipelines/" + recipe.PipelineId + ".yaml）")
            .AppendLine("# stages 顺序即执行顺序；next 指针由服务端按顺序自动生成")
            .ToString();
        return header + _serializer.Serialize(recipe);
    }

    private string FilePath(string pipelineId) =>
        Path.Combine(catalog.Directory, pipelineId + ".yaml");

    private static void Write(string path, string content)
    {
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, content, new UTF8Encoding(false));
        File.Move(tmp, path, true);
    }
}
