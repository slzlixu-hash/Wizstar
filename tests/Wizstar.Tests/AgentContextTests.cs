using Microsoft.Extensions.AI;
using Wizstar.Agents.Runtime;

namespace Wizstar.Tests;

/// <summary>上下文拼装与按 Agent 会话隔离的单测（不依赖 MySQL）。</summary>
public class AgentContextComposerTests
{
    private static AgentContextComposer.MemoryFact Fact(long id, string subject, string value, string status = "verified", decimal confidence = 0.9m) =>
        new(id, subject, "报价", value, confidence, status, new DateTime(2026, 11, 14));

    private static AgentContextComposer.KnowledgeDoc Doc(long id, string title, string content) =>
        new(id, title, "合规", content, new DateTime(2026, 11, 14));

    [Fact]
    public void Compose_IncludesMemoryAndKnowledge_WithIds()
    {
        var block = AgentContextComposer.Compose(
            [Fact(1, "供应商A", "¥12.5 含税，起订 50 件")],
            [Doc(2, "违禁词", "禁用绝对化用语")],
            4000, 4000);

        Assert.False(block.IsEmpty);
        Assert.Contains("供应商A", block.MemoryText);
        Assert.Contains("¥12.5", block.MemoryText);
        Assert.Contains("违禁词", block.KnowledgeText);
        Assert.Equal([1L], block.MemoryIds);
        Assert.Equal([2L], block.KnowledgeIds);
        Assert.False(block.Truncated);

        var message = block.ToSystemMessage();
        Assert.NotNull(message);
        Assert.Contains("【长期记忆】", message);
        Assert.Contains("【知识库】", message);
    }

    [Fact]
    public void Compose_FiltersDeletedAndRejectedMemories()
    {
        var block = AgentContextComposer.Compose(
            [
                Fact(1, "保留", "有效事实"),
                Fact(2, "已删除", "不该出现", status: "deleted"),
                Fact(3, "已驳回", "不该出现", status: "rejected"),
                Fact(4, "待确认", "不该出现", status: "pending"),
            ],
            [], 4000, 4000);

        Assert.Equal([1L], block.MemoryIds);
        Assert.DoesNotContain("已删除", block.MemoryText);
        Assert.DoesNotContain("已驳回", block.MemoryText);
        Assert.DoesNotContain("待确认", block.MemoryText);
    }

    [Fact]
    public void TagFilter_GlobalAlwaysMatches_SpecificRequiresScope()
    {
        Assert.True(MemoryTagFilter.MatchesTags(null, "#全局"));
        Assert.True(MemoryTagFilter.MatchesTags(null, null));
        Assert.False(MemoryTagFilter.MatchesTags(null, "#保温杯"));
        Assert.True(MemoryTagFilter.MatchesTags(["保温杯"], "#保温杯 #冬季"));
        Assert.False(MemoryTagFilter.MatchesTags(["女装"], "#保温杯"));
        Assert.True(MemoryTagFilter.MatchesTags(["微信小店"], "#全局 #微信小店"));
        Assert.False(MemoryTagFilter.MatchesTags(["女装"], "#全局 #微信小店"));
    }

    [Fact]
    public void TagFilter_SharedRuleHitsTargetAgent()
    {
        Assert.True(MemoryTagFilter.SharedWith("scout,sourcing", "sourcing"));
        Assert.False(MemoryTagFilter.SharedWith("scout,sourcing", "commander"));
        Assert.False(MemoryTagFilter.SharedWith(null, "scout"));
        Assert.True(MemoryTagFilter.IsExpired(DateTime.Now.AddDays(-1), DateTime.Now));
        Assert.False(MemoryTagFilter.IsExpired(null, DateTime.Now));
    }

    [Fact]
    public void Compose_TruncatesWhenOverLimit_AndFlagsIt()
    {
        var facts = Enumerable.Range(1, 30)
            .Select(i => Fact(i, "主题" + i, new string('长', 60)))
            .ToList();

        var block = AgentContextComposer.Compose(facts, [], maxMemoryChars: 400, maxKnowledgeChars: 400);

        Assert.True(block.Truncated);
        Assert.True(block.MemoryIds.Count < facts.Count);
        Assert.True(block.TotalChars <= 400 + 200); // 允许最后一条略超（按行判断后再写入）
        Assert.Contains("已按配置上限截断", block.ToSystemMessage());
    }

    [Fact]
    public void Compose_EmptyInputs_ProducesEmptyBlockWithoutMessage()
    {
        var block = AgentContextComposer.Compose([], [], 4000, 4000);

        Assert.True(block.IsEmpty);
        Assert.Null(block.ToSystemMessage());
        Assert.Empty(block.MemoryIds);
    }
}

public class ConversationIsolationTests
{
    [Fact]
    public void SameConversationId_IsolatedByAgent()
    {
        var store = new ConversationStore();
        store.Append("conv-1", "scout", new ChatMessage(ChatRole.User, "选品问题"));
        store.Append("conv-1", "analyst", new ChatMessage(ChatRole.User, "分析问题"));

        var scout = store.GetHistory("conv-1", "scout");
        var analyst = store.GetHistory("conv-1", "analyst");

        Assert.Single(scout);
        Assert.Single(analyst);
        Assert.Equal("选品问题", scout[0].Text);
        Assert.Equal("分析问题", analyst[0].Text);
    }

    [Fact]
    public void UnknownAgent_SeesNoHistory()
    {
        var store = new ConversationStore();
        store.Append("conv-2", "scout", new ChatMessage(ChatRole.User, "只属于 scout"));

        Assert.Empty(store.GetHistory("conv-2", "publisher"));
    }
}
