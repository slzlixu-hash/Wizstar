namespace Wizstar.Mcp;

/// <summary>鉴权模式（四档可插拔）：none 本地直连 / bearer 标准 API Key / header 自定义头 / hmac 高危签名。</summary>
public static class McpAuthTypes
{
    public const string None = "none";
    public const string Bearer = "bearer";
    public const string Header = "header";
    public const string Hmac = "hmac";

    /// <summary>归一化：空 / 未知值退化为 none；兼容旧清单（仅 keyId+secret、无 authType）→ hmac。</summary>
    public static string Normalize(string? authType, bool hasKeyIdAndSecret = false)
    {
        var value = (authType ?? string.Empty).Trim().ToLowerInvariant();
        return value switch
        {
            Bearer => Bearer,
            Header => Header,
            Hmac => Hmac,
            var v when v.Length == 0 && hasKeyIdAndSecret => Hmac, // 旧清单兼容：配了密钥对的一律按 hmac
            _ => None
        };
    }

    /// <summary>管理界面展示名。</summary>
    public static string Describe(string? authType) => Normalize(authType) switch
    {
        Bearer => "Bearer Key",
        Header => "自定义 Header",
        Hmac => "MCP-HMAC 签名",
        _ => "免鉴权"
    };
}

/// <summary>
/// 声明式 MCP 服务配置（即插即用 Step 1）：来自 config/mcp-services.json，
/// 与数据库 / 手写 SQL 彻底解耦——「放进配置 → 自动探活握手 → Agent 自动可用」。
/// </summary>
public sealed class McpServiceConfig
{
    /// <summary>服务 ID（mcpServers 的键，如 "supplier-1688"）。</summary>
    public string Id { get; init; } = string.Empty;

    public string Name { get; init; } = string.Empty;

    /// <summary>http / stdio（stdio 本期仅留配置位）。</summary>
    public string Transport { get; init; } = "http";

    /// <summary>http 传输的服务根地址（如 http://127.0.0.1:5307）。</summary>
    public string? Url { get; init; }

    /// <summary>stdio 传输的启动命令（本期未实现托管启动，保留配置位）。</summary>
    public string? Command { get; init; }

    public string[]? Args { get; init; }

    public Dictionary<string, string>? Env { get; init; }

    /// <summary>内置服务（随产品发布的自研服务，如罗盘 5206 / 1688 5207）：不可删除，仅可改配置与停用。</summary>
    public bool Builtin { get; init; }

    public bool AutoStart { get; init; }

    /// <summary>
    /// 鉴权模式（四档可插拔）：none 免鉴权（本地直连）/ bearer 标准 API Key /
    /// header 自定义请求头 / hmac MCP-HMAC 签名（高危跨公网专用）。
    /// 未配置时按旧口径兼容：清单配了 keyId+secret → hmac，否则 none。
    /// </summary>
    public string? AuthType { get; init; }

    /// <summary>header 模式的自定义头名（如 X-Api-Key），缺省 X-Api-Key。</summary>
    public string? AuthHeaderName { get; init; }

    /// <summary>MCP-HMAC 鉴权（规范 §2.2，可选）：keyId 与 secret 成对出现才生效。</summary>
    public string? AuthKeyId { get; init; }

    public string? AuthSecret { get; init; }

    /// <summary>生效的鉴权模式（归一化后；bearer/header 模式下 AuthSecret 复用为 API Key）。</summary>
    public string EffectiveAuthType =>
        McpAuthTypes.Normalize(AuthType, !string.IsNullOrWhiteSpace(AuthKeyId) && !string.IsNullOrWhiteSpace(AuthSecret));

    /// <summary>
    /// 店铺凭证（规范 §2.3，可选）：base64url(JSON({appId, appSecret, shopId}))，
    /// 经 X-Shop-Credential 头透传，严禁进 JSON-RPC 消息体、日志与 Prompt。
    /// </summary>
    public string? ShopCredential { get; init; }

    /// <summary>配置指纹：用于对账时判断配置是否变化（变化则重新握手）。不含凭证明文。</summary>
    public string Fingerprint() =>
        string.Join("|", Transport, Url ?? string.Empty, Command ?? string.Empty,
            string.Join(",", Args ?? []), string.Join(",", (Env ?? []).Select(kv => kv.Key)),
            AutoStart, Builtin ? "1" : "0", EffectiveAuthType, AuthHeaderName ?? string.Empty, AuthKeyId ?? string.Empty,
            string.IsNullOrWhiteSpace(ShopCredential) ? "0" : "1");
}

/// <summary>服务运行状态（状态灯口径：绿=Connected 待命，红=Error/Offline 异常，不伪造执行中）。</summary>
public static class McpServiceState
{
    public const string Connecting = "connecting";
    public const string Connected = "connected";
    public const string Offline = "offline";
    public const string Error = "error";
    public const string Disabled = "disabled";

    /// <summary>未启用的服务（不参与健康探测与工具装配）。</summary>
    public static bool IsActive(string state) => state is not Disabled;
}

/// <summary>tools/list 抓到的单个工具（含 x-risk 声明，可空）。</summary>
public sealed record McpToolInfo(
    string Name,
    string Description,
    string InputSchemaJson,
    string? DeclaredRisk);

/// <summary>服务的运行时快照（/api/mcp/servers 的数据源）。Url 供管理界面展示声明式地址。</summary>
public sealed record McpServiceSnapshot(
    string Id,
    string Name,
    string Transport,
    string State,
    string ProtocolVersion,
    string ServerName,
    string ServerVersion,
    int ToolCount,
    string? LastError,
    DateTimeOffset? ConnectedAt,
    DateTimeOffset? ToolsFetchedAt,
    string? Url = null,
    bool AutoStart = false,
    string? AuthKeyId = null,
    bool HasAuthSecret = false,
    string AuthType = "none",
    string? AuthHeaderName = null,
    bool Builtin = false);

/// <summary>对账摘要。</summary>
public sealed record McpReconcileSummary(
    int Added,
    int Refreshed,
    int Removed,
    int Failed,
    IReadOnlyList<string> Notes);
