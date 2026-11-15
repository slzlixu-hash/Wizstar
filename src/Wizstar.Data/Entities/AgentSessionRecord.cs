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

    [SugarColumn(Length = 256, IsNullable = true, ColumnDescription = "群聊标题（单聊为空）")]
    public string? Title { get; set; }

    [SugarColumn(ColumnDataType = "longtext", IsNullable = true, ColumnDescription = "群聊参会 Agent JSON 数组")]
    public string? ParticipantsJson { get; set; }

    [SugarColumn(IsNullable = true, ColumnDescription = "归档时间（UTC，空=未归档）")]
    public DateTime? ArchivedAtUtc { get; set; }
}
