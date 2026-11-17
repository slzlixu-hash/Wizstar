using YamlDotNet.Serialization;

namespace Wizstar.Api.Pipelines;

/// <summary>
/// 工作流配方（pipelines/*.yaml）：把「选品来源 → 工序顺序」从代码里移到配置。
///
/// 设计红线：任何按来源分支的逻辑都不写进 C#——来源到配方的映射由 <see cref="PipelineRecipe.TriggerSource"/>
/// 声明，指挥官只按 next 指针推进状态机。
/// </summary>
public sealed class PipelineRecipe
{
    /// <summary>配方唯一 ID（sku_project.pipeline_id 存这个值）。</summary>
    public string PipelineId { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    /// <summary>触发来源：与 sku_project.selection_source 对齐（douyin_compass / jushuitan / ...）。</summary>
    public string TriggerSource { get; set; } = string.Empty;

    public string? Description { get; set; }

    /// <summary>是否启用：停用的配方不参与「按来源解析」，仍可在编辑器里查看/改。</summary>
    public bool Enabled { get; set; } = true;

    public List<PipelineStage> Stages { get; set; } = [];

    /// <summary>按 code 找节点（大小写敏感，保持 YAML 原样）。</summary>
    public PipelineStage? FindStage(string? code) =>
        string.IsNullOrWhiteSpace(code)
            ? null
            : Stages.FirstOrDefault(s => string.Equals(s.Code, code, StringComparison.Ordinal));

    [YamlIgnore]
    public PipelineStage? FirstStage => Stages.Count > 0 ? Stages[0] : null;

    /// <summary>节点在配方中的顺序（用于前端时间线推导已完成/未开始）。</summary>
    public int IndexOf(string? code)
    {
        if (string.IsNullOrWhiteSpace(code))
        {
            return -1;
        }
        for (var i = 0; i < Stages.Count; i++)
        {
            if (string.Equals(Stages[i].Code, code, StringComparison.Ordinal))
            {
                return i;
            }
        }
        return -1;
    }
}

/// <summary>单个工序节点（Stage）。</summary>
public sealed class PipelineStage
{
    /// <summary>工序代号（如 scout_ingest / sourcing_1688 / qualification_gate）。</summary>
    public string Code { get; set; } = string.Empty;

    public string? Name { get; set; }

    /// <summary>auto = 自动执行；hitl_gate = 人机闸口（挂起等待审批）。</summary>
    public string Type { get; set; } = PipelineStageTypes.Auto;

    /// <summary>负责的 Agent key（取自 agents.yaml）。</summary>
    public string? Agent { get; set; }

    /// <summary>绑定的技能/MCP 能力名（执行器按此接线）。</summary>
    public string? Skill { get; set; }

    /// <summary>执行模式提示（direct_publish / listing_0 / update_and_list ...），透传给执行器与界面。</summary>
    public string? Mode { get; set; }

    /// <summary>右侧抽屉要展示的面板类型（qualification / media_compare ...），由前端注册表渲染。</summary>
    public string? Panel { get; set; }

    /// <summary>自动审核规则（展示给人工的判定口径；引擎不解析表达式）。</summary>
    public string? AutoRule { get; set; }

    /// <summary>闸口是否强制人工确认（默认 true；false 表示可由执行器自动放行）。</summary>
    public bool RequireHuman { get; set; } = true;

    /// <summary>下一个工序 code；null 表示本条流水线终点。</summary>
    public string? Next { get; set; }

    [YamlIgnore]
    public bool IsHumanGate => string.Equals(Type, PipelineStageTypes.HumanGate, StringComparison.OrdinalIgnoreCase);
}

/// <summary>节点类型常量。</summary>
public static class PipelineStageTypes
{
    public const string Auto = "auto";
    public const string HumanGate = "hitl_gate";
}

/// <summary>工序状态常量（sku_project.stage_status）。</summary>
public static class PipelineStageStatus
{
    public const string Pending = "pending";
    public const string Running = "running";
    public const string WaitingHuman = "waiting_human";
    public const string Completed = "completed";
    public const string Failed = "failed";
    public const string Blocked = "blocked";
    /// <summary>人工暂停（保留现场；恢复后从当前工序继续）。</summary>
    public const string Paused = "paused";
    /// <summary>人工终止（任务不再推进；重新执行需新建任务）。</summary>
    public const string Cancelled = "cancelled";
}

/// <summary>配方校验问题（加载时收集，接口如实下发，不静默丢弃）。</summary>
public sealed record PipelineIssue(string Level, string Message);
