namespace Wizstar.Agents.Governance;

/// <summary>
/// 风险等级执行策略的来源抽象。
///
/// 为什么需要这层：<see cref="ToolInvoker"/> 属于 Agents 层，不依赖 Data 层（SqlSugar），
/// 但「L1/L2 是否允许自动执行」是可持久化的运营配置，因此由宿主实现本接口注入。
///
/// 治理红线（实现方必须遵守）：**L3 sensitive / L4 irreversible 永远不返回 true**，
/// 即使用户把配置改成自动执行，也不允许绕过人工审批——服务端从不自动批准。
/// </summary>
public interface IRiskPolicyProvider
{
    /// <summary>该风险等级是否允许自动执行（无需 HITL 挂起）。</summary>
    bool IsAutoExecute(string risk);
}

/// <summary>
/// 默认策略：沿用 v2.0 三条硬口径——read / write 自动执行，sensitive / irreversible 强制审批。
/// </summary>
public sealed class DefaultRiskPolicyProvider : IRiskPolicyProvider
{
    public bool IsAutoExecute(string risk) =>
        string.Equals(risk, RiskLevels.Read, StringComparison.Ordinal) ||
        string.Equals(risk, RiskLevels.Write, StringComparison.Ordinal);
}
