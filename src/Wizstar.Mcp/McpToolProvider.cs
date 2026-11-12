using System.Diagnostics;
using System.Text.Json;
using Wizstar.Agents.Tools;
using Wizstar.Contracts;

namespace Wizstar.Mcp;

/// <summary>
/// MCP 工具桥接（即插即用 Step 3）：把已连接 MCP 服务的工具缓存暴露成 IToolProvider，
/// 由 ToolRegistry 按 Agent 通配授权装配成 AIFunction——新 MCP 接入后 Agent 无感可用。
///
/// 容错与优雅降级（即拔不崩）：
///  - 离线 / 故障服务的工具自动从装配清单剔除（动态工具过滤器），运行日志注明剔除；
///  - 工具调用失败 / 超时封装为合法信封回传模型（50001 可重试），不断整条对话流。
/// </summary>
public sealed class McpToolProvider(McpCatalog catalog, ILogger<McpToolProvider> logger) : IToolProvider
{
    public IReadOnlyList<ToolDescriptor> ListTools()
    {
        catalog.ReloadIfChanged();

        var tools = new List<ToolDescriptor>();
        var skipped = new List<string>();

        foreach (var snapshot in catalog.ListSnapshots())
        {
            // 动态工具过滤器：非 Connected 状态的服务一律剔除，绝不带失效 Endpoint 去跑
            if (!string.Equals(snapshot.State, McpServiceState.Connected, StringComparison.Ordinal))
            {
                skipped.Add($"{snapshot.Id}({snapshot.State})");
                continue;
            }

            var state = catalog.GetState(snapshot.Id);
            if (state is null)
            {
                continue;
            }

            foreach (var tool in state.Tools)
            {
                tools.Add(new ToolDescriptor(
                    snapshot.Id,
                    tool.Name,
                    tool.Description,
                    tool.InputSchemaJson,
                    tool.DeclaredRisk));
            }
        }

        if (skipped.Count > 0)
        {
            logger.LogDebug("MCP 工具装配剔除离线服务: {Skipped}", string.Join(", ", skipped));
        }

        return tools;
    }

    public async Task<ToolEnvelope> InvokeAsync(
        ToolDescriptor tool,
        JsonElement arguments,
        ToolContext context,
        CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        var client = catalog.CreateClient(tool.ServerId);

        try
        {
            var raw = await client.CallToolAsync(tool.Name, arguments.GetRawText(), cancellationToken).ConfigureAwait(false);
            stopwatch.Stop();

            var data = ParseData(raw);
            var serverInfo = catalog.GetState(tool.ServerId);
            var envelope = new ToolEnvelope(
                true,
                data,
                new ToolUsageInfo("call", 1),
                null,
                new ToolServerInfo(tool.ServerId, serverInfo?.ServerVersion ?? "unknown", "1.0", stopwatch.ElapsedMilliseconds),
                context.TraceId,
                false);
            return envelope;
        }
        catch (McpProtocolException ex)
        {
            stopwatch.Stop();
            var code = ex.Code > 0 ? ex.Code : ErrorCodes.InternalError;
            return new ToolEnvelope(
                false, null, new ToolUsageInfo("call", 1),
                new ToolErrorInfo(code, ex.Message, ErrorCodes.IsRetryable(code)),
                new ToolServerInfo(tool.ServerId, "unknown", "1.0", stopwatch.ElapsedMilliseconds),
                context.TraceId, false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            stopwatch.Stop();
            return new ToolEnvelope(
                false, null, new ToolUsageInfo("call", 1),
                new ToolErrorInfo(ErrorCodes.NetworkError, $"服务 {tool.ServerId} 调用超时", true),
                new ToolServerInfo(tool.ServerId, "unknown", "1.0", stopwatch.ElapsedMilliseconds),
                context.TraceId, false);
        }
        catch (Exception ex)
        {
            stopwatch.Stop();
            // 统一异常拦截：服务不可达封装为合法信封回传模型，不整条 SSE 中断崩溃
            return new ToolEnvelope(
                false, null, new ToolUsageInfo("call", 1),
                new ToolErrorInfo(ErrorCodes.NetworkError, $"服务 {tool.ServerId} 暂不可达：{ex.Message}", true),
                new ToolServerInfo(tool.ServerId, "unknown", "1.0", stopwatch.ElapsedMilliseconds),
                context.TraceId, false);
        }
    }

    /// <summary>服务端已按规范返回统一信封时直接透传；否则包一层 {text: raw}。</summary>
    private static JsonElement ParseData(string raw)
    {
        try
        {
            using var document = JsonDocument.Parse(raw);
            if (document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("success", out var success)
                && success.ValueKind == JsonValueKind.True
                && document.RootElement.TryGetProperty("data", out var data))
            {
                return data.Clone();
            }

            return JsonSerializer.SerializeToElement(new { text = raw });
        }
        catch (JsonException)
        {
            return JsonSerializer.SerializeToElement(new { text = raw });
        }
    }
}
