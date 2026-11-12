using SqlSugar;

namespace Wizstar.Data.Entities;

/// <summary>Agent 会话持久化记录（CodeFirst）。</summary>
[SugarTable("wiz_agent_session", TableDescription = "Agent 会话与消息历史")]
public class AgentSessionRecord
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnDescription = "自增主键")]
    public long Id { get; set; }

    [SugarColumn(Length = 64, ColumnDescription = "会话 ID（conversationId）", UniqueGroupNameList = new[] { "uk_conversation" })]
    public string ConversationId { get; set; } = string.Empty;

    [SugarColumn(Length = 64, ColumnDescription = "Agent Key")]
    public string AgentKey { get; set; } = string.Empty;

    [SugarColumn(ColumnDataType = "longtext", ColumnDescription = "消息历史 JSON（ChatMessage 序列化）")]
    public string MessagesJson { get; set; } = "[]";

    [SugarColumn(ColumnDescription = "最后更新时间（UTC）")]
    public DateTime UpdatedAtUtc { get; set; }
}
