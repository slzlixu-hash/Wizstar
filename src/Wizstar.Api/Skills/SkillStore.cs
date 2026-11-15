using System.Text;
using Wizstar.Agents.Profiles;
using Wizstar.Agents.Skills;
using Wizstar.Contracts;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace Wizstar.Api.Skills;

/// <summary>
/// Skill 写侧：校验后落盘 <c>skills/&lt;code&gt;.yaml</c>，并立即热重载 SkillCatalog。
/// </summary>
public sealed class SkillStore(
    SkillCatalog catalog,
    AgentCatalog agents,
    ILogger<SkillStore> logger)
{
    private readonly ISerializer _serializer = new SerializerBuilder()
        .WithNamingConvention(UnderscoredNamingConvention.Instance)
        .Build();

    public SkillDefinition Create(SkillDefinition draft)
    {
        var skill = NormalizeAndValidate(draft);
        if (catalog.Get(skill.Code) is not null || File.Exists(FilePath(skill.Code)))
        {
            throw ApiException.Validation($"Skill 已存在: {skill.Code}");
        }
        Write(FilePath(skill.Code), Serialize(skill));
        catalog.ReloadNow();
        return catalog.Get(skill.Code) ?? skill;
    }

    public SkillDefinition Update(string code, SkillDefinition draft)
    {
        var existing = catalog.Get(code) ?? throw ApiException.Validation($"Skill 不存在: {code}");
        if (!string.Equals(draft.Code?.Trim(), code, StringComparison.Ordinal))
        {
            throw ApiException.Validation("Skill 的唯一标识（code）创建后不可修改");
        }
        var skill = NormalizeAndValidate(draft);
        var path = existing.SourcePath ?? FilePath(code);
        skill.SourcePath = path;
        Write(path, Serialize(skill));
        catalog.ReloadNow();
        return catalog.Get(code) ?? skill;
    }

    public bool Delete(string code)
    {
        var skill = catalog.Get(code);
        if (skill is null)
        {
            return false;
        }
        var path = skill.SourcePath ?? FilePath(code);
        if (File.Exists(path))
        {
            File.Delete(path);
        }
        catalog.ReloadNow();
        logger.LogInformation("删除 Skill: {Code}", code);
        return true;
    }

    public SkillDefinition SetEnabled(string code, bool enabled)
    {
        var skill = catalog.Get(code) ?? throw ApiException.Validation($"Skill 不存在: {code}");
        var draft = Clone(skill);
        draft.Enabled = enabled;
        return Update(code, draft);
    }

    public SkillDefinition Import(string? yaml)
    {
        if (string.IsNullOrWhiteSpace(yaml))
        {
            throw ApiException.Validation("YAML 内容不能为空");
        }
        var parsed = catalog.Parse(yaml, out var error);
        if (parsed is null)
        {
            throw ApiException.Validation(error ?? "YAML 解析失败");
        }
        var skill = NormalizeAndValidate(parsed);
        var existing = catalog.Get(skill.Code);
        if (existing is not null)
        {
            var draft = Clone(skill);
            draft.SourcePath = existing.SourcePath;
            return Update(skill.Code, draft);
        }
        return Create(skill);
    }

    public string PreviewYaml(SkillDefinition draft)
    {
        var skill = NormalizeAndValidate(draft);
        return Serialize(skill);
    }

    private SkillDefinition NormalizeAndValidate(SkillDefinition draft)
    {
        var skill = SkillRules.Normalize(draft);
        if (!SkillRules.IsValidCode(skill.Code))
        {
            throw ApiException.Validation("Skill code 不合法：需以小写字母/数字开头，仅含小写字母、数字、-、_");
        }
        if (string.IsNullOrWhiteSpace(skill.Name))
        {
            throw ApiException.Validation("Skill 名称不能为空");
        }
        if (string.IsNullOrWhiteSpace(skill.Agent) || agents.Find(skill.Agent) is null)
        {
            throw ApiException.Validation($"执行 Agent 不存在: {skill.Agent}");
        }
        if (string.IsNullOrWhiteSpace(skill.Prompt))
        {
            throw ApiException.Validation("SOP 核心作业指令（Prompt）不能为空");
        }
        return skill;
    }

    private string Serialize(SkillDefinition skill)
    {
        var header = new StringBuilder()
            .AppendLine("# Skill SOP · 保存后热加载，无需重启")
            .AppendLine($"# code: {skill.Code}")
            .AppendLine($"# agent: {skill.Agent}")
            .AppendLine("# allowed_tools 支持 serverId.tool / serverId.* / *")
            .AppendLine();
        return header + _serializer.Serialize(skill);
    }

    private string FilePath(string code) => Path.Combine(catalog.Directory, code + ".yaml");

    private static SkillDefinition Clone(SkillDefinition skill) => new()
    {
        Code = skill.Code,
        Name = skill.Name,
        Description = skill.Description,
        Agent = skill.Agent,
        Enabled = skill.Enabled,
        TriggerMode = skill.TriggerMode,
        AllowedTools = skill.AllowedTools.ToList(),
        Prompt = skill.Prompt,
        Temperature = skill.Temperature,
        MaxOutputTokens = skill.MaxOutputTokens,
        Retry = skill.Retry,
        SourcePath = skill.SourcePath,
    };

    private static void Write(string path, string content)
    {
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, content, new UTF8Encoding(false));
        File.Move(tmp, path, true);
    }
}
