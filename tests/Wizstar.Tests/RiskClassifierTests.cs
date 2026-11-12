using Wizstar.Agents.Governance;
using Wizstar.Agents.Tools;

namespace Wizstar.Tests;

public class RiskClassifierTests
{
    private static ToolDescriptor Tool(string name, string? declared = null) =>
        new("builtin", name, "测试工具", "{}", declared);

    [Theory]
    [InlineData("get_status", RiskLevels.Read)]
    [InlineData("query_orders", RiskLevels.Read)]
    [InlineData("list_products", RiskLevels.Read)]
    [InlineData("search_offers", RiskLevels.Read)]
    [InlineData("meta.health", RiskLevels.Read)]
    public void ReadVerbs_AreClassifiedAsRead(string name, string expected) =>
        Assert.Equal(expected, RiskClassifier.Classify(Tool(name)));

    [Theory]
    [InlineData("publish_product", RiskLevels.Irreversible)]
    [InlineData("pay_order", RiskLevels.Irreversible)]
    [InlineData("delete_sku", RiskLevels.Irreversible)]
    [InlineData("refund_money", RiskLevels.Irreversible)]
    public void IrreversibleVerbs_AreClassifiedAsIrreversible(string name, string expected) =>
        Assert.Equal(expected, RiskClassifier.Classify(Tool(name)));

    [Theory]
    [InlineData("update_price", RiskLevels.Write)]
    [InlineData("save_draft", RiskLevels.Write)]
    [InlineData("sync_inventory", RiskLevels.Write)]
    [InlineData("create_task", RiskLevels.Write)]
    public void WriteVerbs_AreClassifiedAsWrite(string name, string expected) =>
        Assert.Equal(expected, RiskClassifier.Classify(Tool(name)));

    [Fact]
    public void UnknownVerb_DefaultsToWrite()
    {
        // 未知动词默认 write（宁可多审，不可漏审）
        Assert.Equal(RiskLevels.Write, RiskClassifier.Classify(Tool("do_something")));
        Assert.Equal(RiskLevels.Write, RiskClassifier.Classify(Tool("run_pipeline")));
    }

    [Fact]
    public void DeclaredXRisk_WinsOverVerb()
    {
        // 服务端显式声明优先（规范 §3.2）
        Assert.Equal(RiskLevels.Irreversible, RiskClassifier.Classify(Tool("get_status", RiskLevels.Irreversible)));
        Assert.Equal(RiskLevels.Irreversible, RiskClassifier.Classify(Tool("update_draft", RiskLevels.Irreversible)));
    }

    [Fact]
    public void XRiskOnlyRaises_NeverLowers()
    {
        // x-risk 只升不降：声明 read 但动词是 irreversible → 仍按 irreversible
        Assert.Equal(RiskLevels.Irreversible, RiskClassifier.Classify(Tool("publish_product", RiskLevels.Read)));
        // 未知声明值按 write 处理（不信任声明，也不放行）
        Assert.Equal(RiskLevels.Write, RiskClassifier.Classify(Tool("get_status", "weird-risk")));
    }

    [Theory]
    [InlineData(RiskLevels.Read, false)]
    [InlineData(RiskLevels.Write, true)]
    [InlineData(RiskLevels.Irreversible, true)]
    public void MutatingFlags_FollowRisk(string risk, bool expectedMutating)
    {
        Assert.Equal(expectedMutating, RiskClassifier.IsMutating(risk));
        Assert.Equal(risk == RiskLevels.Irreversible, RiskClassifier.RequiresApproval(risk));
    }
}
