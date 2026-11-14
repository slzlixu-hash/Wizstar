using Wizstar.Agents.Governance;
using Wizstar.Data.Settings;

namespace Wizstar.Api.Services;

/// <summary>
/// 风险执行策略的落库实现：读 `sys_risk_policy` 中 `risk.{level}.execute` 配置。
///
/// 治理红线：<see cref="RiskLevels.Irreversible"/> 恒定返回 false（强制人工审批），
/// 即使库里被手工改成 auto 也不放行——服务端从不自动批准不可逆操作。
/// </summary>
public sealed class DbRiskPolicyProvider(RuntimeSettingsStore settings) : IRiskPolicyProvider
{
    public bool IsAutoExecute(string risk)
    {
        if (string.Equals(risk, RiskLevels.Irreversible, StringComparison.Ordinal))
        {
            return false;
        }

        var fallback = string.Equals(risk, RiskLevels.Read, StringComparison.Ordinal) ||
                       string.Equals(risk, RiskLevels.Write, StringComparison.Ordinal);

        return settings.GetFlag(RuntimeSettingsStore.RiskKey(risk), fallback);
    }
}
