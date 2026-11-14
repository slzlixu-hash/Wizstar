using SqlSugar;
using Wizstar.Data.Entities.Business;

namespace Wizstar.Data.Settings;

/// <summary>
/// 运行时可配置项存储：统一落 `sys_risk_policy`（policy_key / policy_name / policy_value / description）。
///
/// 该表原本是「全局风控与预算策略」，这里复用为平台级 KV 配置表，键名约定：
///   risk.{riskLevel}.execute  → value ∈ {auto, manual}  风险等级执行策略
///   toggle.{toggleId}         → value ∈ {on, off}       环境与网络开关
///
/// 读取一律带默认值兜底：库不可用 / 键缺失时回退到默认口径，绝不让调用方拿到异常。
/// 日志走回调（与 <see cref="Llm.LlmConfigStore"/> 同口径），Data 层不引 Microsoft.Extensions.Logging。
/// </summary>
public sealed class RuntimeSettingsStore(ISqlSugarClient db, Action<string>? log = null)
{
    public const string RiskKeyPrefix = "risk.";
    public const string ToggleKeyPrefix = "toggle.";

    public static string RiskKey(string riskLevel) => $"{RiskKeyPrefix}{riskLevel}.execute";

    public static string ToggleKey(string toggleId) => $"{ToggleKeyPrefix}{toggleId}";

    /// <summary>读取全部配置行（失败返回空集合，不抛）。</summary>
    public IReadOnlyList<SysRiskPolicy> All()
    {
        try
        {
            return db.Queryable<SysRiskPolicy>().ToList();
        }
        catch (Exception ex)
        {
            log?.Invoke($"读取 sys_risk_policy 失败，按默认配置继续: {ex.Message}");
            return [];
        }
    }

    /// <summary>读取布尔配置：auto/on/true/1 → true；manual/off/false/0 → false；其余走 fallback。</summary>
    public bool GetFlag(string key, bool fallback)
    {
        try
        {
            var row = db.Queryable<SysRiskPolicy>().Where(r => r.PolicyKey == key).First();
            return row is null ? fallback : ParseFlag(row.PolicyValue, fallback);
        }
        catch (Exception ex)
        {
            log?.Invoke($"读取配置项 {key} 失败，使用默认值 {fallback}: {ex.Message}");
            return fallback;
        }
    }

    /// <summary>写入布尔配置（存在则更新，不存在则插入）。</summary>
    public bool SetFlag(string key, string name, string description, bool value)
    {
        try
        {
            var existing = db.Queryable<SysRiskPolicy>().Where(r => r.PolicyKey == key).First();
            var stored = value ? "auto" : "manual";

            if (existing is null)
            {
                db.Insertable(new SysRiskPolicy
                {
                    PolicyKey = key,
                    PolicyName = name,
                    PolicyValue = stored,
                    Description = description,
                    UpdatedAt = DateTime.Now,
                }).ExecuteCommand();
            }
            else
            {
                existing.PolicyName = name;
                existing.PolicyValue = stored;
                existing.Description = description;
                existing.UpdatedAt = DateTime.Now;
                db.Updateable(existing).ExecuteCommand();
            }

            return true;
        }
        catch (Exception ex)
        {
            log?.Invoke($"写入配置项 {key} 失败: {ex.Message}");
            return false;
        }
    }

    private static bool ParseFlag(string? raw, bool fallback) =>
        (raw ?? string.Empty).Trim().ToLowerInvariant() switch
        {
            "auto" or "on" or "true" or "1" or "yes" => true,
            "manual" or "off" or "false" or "0" or "no" => false,
            _ => fallback,
        };
}
