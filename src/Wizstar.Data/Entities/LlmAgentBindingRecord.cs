using SqlSugar;

namespace Wizstar.Data.Entities;

/// <summary>
/// Agent → 模型分派映射（运行态表，由 CodeFirst 管理）。
/// 与业务表 llm_provider / llm_model_definition 分开：前者是配置主数据，本表是工作台运行态。
/// </summary>
[SugarTable("wiz_llm_agent_binding")]
public sealed class LlmAgentBindingRecord
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "agent_key", Length = 64)]
    public string AgentKey { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "model_id", Length = 64)]
    public string ModelId { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "provider_code", Length = 32)]
    public string ProviderCode { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "updated_at_utc")]
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
}
