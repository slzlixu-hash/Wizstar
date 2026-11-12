using System.Text.Json;
using Wizstar.Contracts;

namespace Wizstar.Agents.Tools;

/// <summary>
/// 工具描述符：来自任意 IToolProvider（内置工具 / MCP 服务）。
/// DeclaredRisk 是服务端显式声明的 x-risk（规范 §3.2），只升不降。
/// </summary>
public sealed record ToolDescriptor(
    string ServerId,
    string Name,
    string Description,
    string? InputSchemaJson,
    string? DeclaredRisk);

/// <summary>
/// 一次工具调用的执行上下文。DryRun 由治理层按 write 风险与配置决定。
/// </summary>
public sealed record ToolContext(
    string AgentKey,
    string TraceId,
    string ConversationId,
    bool DryRun)
{
    /// <summary>从上下文派生幂等 scope（规范 §4.1：账本主键隔离跨服务操作）。</summary>
    public string Scope(ToolDescriptor tool) => $"{tool.ServerId}.{tool.Name}";
}

/// <summary>
/// 工具供给器：内置工具与 MCP 工具共用这一个抽象。
/// AgentRunner / ToolInvoker 只面对 Provider，不感知工具来自哪里（即插即用 Step 3 的基础）。
/// </summary>
public interface IToolProvider
{
    /// <summary>当前可见的工具清单。离线服务的工具必须被上层自动剔除（规范：即拔不崩）。</summary>
    IReadOnlyList<ToolDescriptor> ListTools();

    /// <summary>执行一个工具调用，返回统一信封（规范 §5.1）。</summary>
    Task<ToolEnvelope> InvokeAsync(
        ToolDescriptor tool,
        JsonElement arguments,
        ToolContext context,
        CancellationToken cancellationToken);
}
