using SqlSugar;
using Wizstar.Contracts;
using Wizstar.Data.Entities;
using Wizstar.Data.Entities.Business;

namespace Wizstar.Data.Llm;

/// <summary>模型调用的默认参数（来自 appsettings，界面本期不暴露）。</summary>
public sealed record LlmRuntimeDefaults(double Temperature, int MaxOutputTokens, int TimeoutSeconds);

/// <summary>
/// LLM 配置存储：llm_provider（供应商）/ llm_model_definition（支持模型）/ wiz_llm_agent_binding（Agent 分派）。
///
/// 口径：
///  - 种子逐项补缺不覆盖（已存在的供应商 / 模型 / 分派一律不动）；
///  - 内置（is_seed=1，DeepSeek）禁删；删除供应商先删模型定义，避免外键 RESTRICT；
///  - API Key 只存 AES-GCM 密文 + 掩码，明文按需解密；
///  - GetCurrent() 是运行时热配置源，任何存储异常都吞掉并返回 null（回退 offline，不拖垮健康检查）。
///  - 本期只保留公网 OpenAI 兼容 API 供应商，不支持本机私有化部署。
/// </summary>
public sealed class LlmConfigStore(
    ISqlSugarClient db,
    string? masterKey,
    LlmRuntimeDefaults defaults,
    Action<string>? warn = null) : ILlmRuntimeSettingsProvider
{
    private static readonly (string Code, string Name, string BaseUrl)[] Seeds =
    [
        ("deepseek", "DeepSeek 深度求索", "https://api.deepseek.com/v1"),
    ];

    private static readonly (string Code, string ModelId, string DisplayName, bool Default)[] SeedModels =
    [
        ("deepseek", "deepseek-chat", "deepseek-chat", true),
        ("deepseek", "deepseek-reasoner", "deepseek-reasoner（R1）", false),
    ];

    private static readonly (string Agent, string Model, string Provider)[] SeedBindings =
    [
        ("commander", "deepseek-chat", "deepseek"),
        ("scout", "deepseek-chat", "deepseek"),
        ("sourcing", "deepseek-chat", "deepseek"),
        ("creative", "deepseek-chat", "deepseek"),
        ("publisher", "deepseek-chat", "deepseek"),
        ("analyst", "deepseek-reasoner", "deepseek"),
    ];

    // ---------------------------------------------------------------- 种子

    /// <summary>启动自检：逐项补齐内置供应商 / 模型 / Agent 分派；已有数据一律不动。</summary>
    public void EnsureSeed()
    {
        var now = DateTime.Now;

        foreach (var s in Seeds)
        {
            if (FindProvider(s.Code) is not null) continue;
            db.Insertable(new LlmProvider
            {
                ProviderCode = s.Code,
                DisplayName = s.Name,
                BaseUrl = s.BaseUrl,
                ApiKeyCipher = null!,
                ApiKeyHint = null,
                IsSeed = true,
                Enabled = true,
                UpdatedAt = now
            }).ExecuteCommand();
        }

        foreach (var m in SeedModels)
        {
            if (FindModel(m.Code, m.ModelId) is not null) continue;
            db.Insertable(new LlmModelDefinition
            {
                ProviderCode = m.Code,
                ModelId = m.ModelId,
                DisplayName = m.DisplayName,
                IsDefaultGlobal = m.Default,
                Enabled = true
            }).ExecuteCommand();
        }

        foreach (var b in SeedBindings)
        {
            var existing = db.Queryable<LlmAgentBindingRecord>()
                .Where(x => x.AgentKey == b.Agent).First();
            if (existing is not null) continue;
            db.Insertable(new LlmAgentBindingRecord
            {
                AgentKey = b.Agent,
                ModelId = b.Model,
                ProviderCode = b.Provider,
                UpdatedAtUtc = DateTime.UtcNow
            }).ExecuteCommand();
        }
    }

    private LlmModelDefinition? FindModel(string code, string modelId) =>
        db.Queryable<LlmModelDefinition>()
            .Where(m => m.ProviderCode == code && m.ModelId == modelId).First();

    // ---------------------------------------------------------------- 查询

    public List<LlmProvider> ListProviders() => db.Queryable<LlmProvider>()
        .ToList()
        .OrderByDescending(p => p.IsSeed)
        .ThenBy(p => p.ProviderCode)
        .ToList();

    public List<LlmModelDefinition> ListModels() => db.Queryable<LlmModelDefinition>()
        .ToList()
        .OrderBy(m => m.ProviderCode)
        .ThenBy(m => m.Id)
        .ToList();

    public List<LlmAgentBindingRecord> ListBindings() => db.Queryable<LlmAgentBindingRecord>().ToList();

    public LlmProvider? FindProvider(string code) =>
        db.Queryable<LlmProvider>().Where(p => p.ProviderCode == code).First();

    public string? GetApiKey(string code)
    {
        var provider = FindProvider(code);
        return provider is null ? null : ApiKeyProtector.Unprotect(provider.ApiKeyCipher, masterKey);
    }

    // ---------------------------------------------------------------- 供应商 CRUD

    public LlmProvider CreateProvider(string code, string name, string baseUrl, string? apiKey, string[]? models)
    {
        if (FindProvider(code) is not null)
        {
            throw new InvalidOperationException($"供应商标识已存在: {code}");
        }

        var provider = new LlmProvider
        {
            ProviderCode = code,
            DisplayName = name,
            BaseUrl = baseUrl,
            ApiKeyCipher = null!,
            ApiKeyHint = null,
            IsSeed = false,
            Enabled = true,
            UpdatedAt = DateTime.Now
        };
        if (!string.IsNullOrWhiteSpace(apiKey))
        {
            provider.ApiKeyCipher = ApiKeyProtector.Protect(apiKey.Trim(), masterKey);
            provider.ApiKeyHint = ApiKeyProtector.Hint(apiKey.Trim());
        }
        db.Insertable(provider).ExecuteCommand();

        foreach (var modelId in (models ?? []).Where(m => !string.IsNullOrWhiteSpace(m)).Distinct())
        {
            AddModel(code, modelId.Trim(), null);
        }

        return provider;
    }

    public LlmProvider UpdateProvider(string code, string? name, string? baseUrl, bool? enabled, string? apiKey)
    {
        var provider = FindProvider(code) ?? throw new InvalidOperationException($"供应商不存在: {code}");
        if (!string.IsNullOrWhiteSpace(name)) provider.DisplayName = name.Trim();
        if (!string.IsNullOrWhiteSpace(baseUrl)) provider.BaseUrl = baseUrl.Trim().TrimEnd('/');
        if (enabled.HasValue) provider.Enabled = enabled.Value;
        // apiKey 不传（null）= 保留已保存 Key；传空串 = 清除；传值 = 加密保存。
        if (apiKey is not null)
        {
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                provider.ApiKeyCipher = null!;
                provider.ApiKeyHint = null;
            }
            else
            {
                var plain = apiKey.Trim();
                provider.ApiKeyCipher = ApiKeyProtector.Protect(plain, masterKey);
                provider.ApiKeyHint = ApiKeyProtector.Hint(plain);
            }
        }
        provider.UpdatedAt = DateTime.Now;
        db.Updateable(provider).ExecuteCommand();
        return provider;
    }

    /// <summary>内置种子禁删。返回 false 表示被拒绝。</summary>
    public bool DeleteProvider(string code)
    {
        var provider = FindProvider(code);
        if (provider is null || provider.IsSeed)
        {
            return false;
        }

        db.Deleteable<LlmModelDefinition>().Where(m => m.ProviderCode == code).ExecuteCommand();
        db.Deleteable<LlmProvider>().Where(p => p.ProviderCode == code).ExecuteCommand();
        db.Deleteable<LlmAgentBindingRecord>().Where(b => b.ProviderCode == code).ExecuteCommand();
        return true;
    }

    public void SetApiKey(string code, string? apiKey)
    {
        var provider = FindProvider(code) ?? throw new InvalidOperationException($"供应商不存在: {code}");
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            provider.ApiKeyCipher = null!;
            provider.ApiKeyHint = null;
        }
        else
        {
            var plain = apiKey.Trim();
            provider.ApiKeyCipher = ApiKeyProtector.Protect(plain, masterKey);
            provider.ApiKeyHint = ApiKeyProtector.Hint(plain);
        }
        provider.UpdatedAt = DateTime.Now;
        db.Updateable(provider).ExecuteCommand();
    }

    // ---------------------------------------------------------------- 支持模型

    public LlmModelDefinition AddModel(string code, string modelId, string? displayName)
    {
        if (FindProvider(code) is null)
        {
            throw new InvalidOperationException($"供应商不存在: {code}");
        }

        var existing = FindModel(code, modelId);
        if (existing is not null)
        {
            if (!string.IsNullOrWhiteSpace(displayName))
            {
                existing.DisplayName = displayName.Trim();
                db.Updateable(existing).ExecuteCommand();
            }
            return existing;
        }

        var model = new LlmModelDefinition
        {
            ProviderCode = code,
            ModelId = modelId,
            DisplayName = string.IsNullOrWhiteSpace(displayName) ? modelId : displayName.Trim(),
            IsDefaultGlobal = false,
            Enabled = true
        };
        db.Insertable(model).ExecuteCommand();
        return model;
    }

    public bool DeleteModel(string code, string modelId)
    {
        var model = db.Queryable<LlmModelDefinition>()
            .Where(m => m.ProviderCode == code && m.ModelId == modelId).First();
        if (model is null)
        {
            return false;
        }

        db.Deleteable<LlmModelDefinition>().Where(m => m.Id == model.Id).ExecuteCommand();
        return true;
    }

    // ---------------------------------------------------------------- 默认模型与分派

    public void SetDefaultModel(string? providerCode, string? modelId)
    {
        LlmModelDefinition? target = null;
        if (!string.IsNullOrWhiteSpace(modelId))
        {
            var query = db.Queryable<LlmModelDefinition>().Where(m => m.ModelId == modelId);
            if (!string.IsNullOrWhiteSpace(providerCode))
            {
                query = query.Where(m => m.ProviderCode == providerCode);
            }
            // 先校验目标存在，再清默认值，避免「清了默认但没设上」的中间态。
            target = query.First() ?? throw new InvalidOperationException($"默认模型不存在: {modelId}");
        }

        db.Ado.ExecuteCommand("UPDATE llm_model_definition SET is_default_global = 0");
        if (target is null) return;

        target.IsDefaultGlobal = true;
        db.Updateable(target).ExecuteCommand();
    }

    public void SaveBindings(IReadOnlyDictionary<string, string> bindings)
    {
        var models = ListModels();
        foreach (var (agentKey, modelId) in bindings)
        {
            if (string.IsNullOrWhiteSpace(agentKey) || string.IsNullOrWhiteSpace(modelId)) continue;
            var model = models.FirstOrDefault(m => m.ModelId == modelId);
            if (model is null) continue;

            var existing = db.Queryable<LlmAgentBindingRecord>()
                .Where(b => b.AgentKey == agentKey).First();
            if (existing is null)
            {
                db.Insertable(new LlmAgentBindingRecord
                {
                    AgentKey = agentKey,
                    ModelId = modelId,
                    ProviderCode = model.ProviderCode,
                    UpdatedAtUtc = DateTime.UtcNow
                }).ExecuteCommand();
            }
            else
            {
                existing.ModelId = modelId;
                existing.ProviderCode = model.ProviderCode;
                existing.UpdatedAtUtc = DateTime.UtcNow;
                db.Updateable(existing).ExecuteCommand();
            }
        }
    }

    // ---------------------------------------------------------------- 运行时热配置

    public LlmRuntimeSettings? GetCurrent()
    {
        try
        {
            var model = db.Queryable<LlmModelDefinition>()
                .Where(m => m.IsDefaultGlobal && m.Enabled).First();
            if (model is null)
            {
                return null;
            }

            var provider = db.Queryable<LlmProvider>()
                .Where(p => p.ProviderCode == model.ProviderCode && p.Enabled).First();
            if (provider is null || string.IsNullOrWhiteSpace(provider.BaseUrl))
            {
                return null;
            }

            var apiKey = ApiKeyProtector.Unprotect(provider.ApiKeyCipher, masterKey);
            // 公网供应商未配置 Key 时判为 offline（不伪造在线）；自建本地网关允许免密。
            if (string.IsNullOrWhiteSpace(apiKey) && !IsLoopback(provider.BaseUrl))
            {
                return null;
            }

            return new LlmRuntimeSettings(
                provider.ProviderCode,
                provider.BaseUrl.Trim().TrimEnd('/'),
                model.ModelId,
                string.IsNullOrWhiteSpace(apiKey) ? null : apiKey,
                defaults.Temperature,
                defaults.MaxOutputTokens,
                defaults.TimeoutSeconds);
        }
        catch (Exception ex)
        {
            warn?.Invoke($"动态 LLM 配置读取失败，回退离线: {ex.Message}");
            return null;
        }
    }

    /// <summary>逐项定位「为什么还不能上真实模型」，供 health / bootstrap / 设置页显示。</summary>
    public string? DescribeOffline()
    {
        try
        {
            var model = db.Queryable<LlmModelDefinition>()
                .Where(m => m.IsDefaultGlobal && m.Enabled).First();
            if (model is null) return "系统设置中尚未设置默认全局模型";

            var provider = db.Queryable<LlmProvider>()
                .Where(p => p.ProviderCode == model.ProviderCode && p.Enabled).First();
            if (provider is null) return $"默认模型所属供应商不存在或已停用：{model.ProviderCode}";
            if (string.IsNullOrWhiteSpace(provider.BaseUrl)) return "供应商 Base URL 未配置";

            var apiKey = ApiKeyProtector.Unprotect(provider.ApiKeyCipher, masterKey);
            if (string.IsNullOrWhiteSpace(apiKey) && !IsLoopback(provider.BaseUrl))
            {
                return $"供应商「{provider.DisplayName}」尚未配置 API Key";
            }
            return "配置读取异常，使用离线回退";
        }
        catch (Exception ex)
        {
            warn?.Invoke($"离线原因诊断失败: {ex.Message}");
            return "配置库不可用，使用离线回退";
        }
    }

    private static bool IsLoopback(string baseUrl) =>
        Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri)
        && (uri.Host is "127.0.0.1" or "::1" or "[::1]"
            || string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase));
}
