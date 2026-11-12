using System.Collections.Concurrent;
using System.Text.Json;
using Wizstar.Agents.Governance;
using Wizstar.Contracts;

namespace Wizstar.Agents.Tools;

/// <summary>
/// 内置演示工具供给器（ServerId=builtin）：用于验证「工具回路 + 风险分级 + 幂等 + HITL」全链路，
/// 不依赖任何外部服务。真实 MCP 服务接入后，这里的工具依然可用（即插即用不影响内置能力）。
///
/// 三个工具刻意覆盖三个风险档：
///   get_workspace_status   → read（免审批）
///   save_scratch_note      → write（可逆，支持 dry-run）
///   publish_announcement   → irreversible（强制挂起等人工审批）
/// </summary>
public sealed class BuiltinToolsProvider : IToolProvider
{
    public const string ServerId = "builtin";

    private readonly ConcurrentDictionary<string, string> _notes = new(StringComparer.Ordinal);
    private readonly DateTimeOffset _startedAt = DateTimeOffset.Now;

    public string Version => "1.0.0";

    public IReadOnlyList<ToolDescriptor> ListTools() =>
    [
        new(
            ServerId,
            "get_workspace_status",
            "查询工作台运行状态：启动时间、已存便签数、当前模式。",
            """{"type":"object","properties":{},"required":[]}""",
            RiskLevels.Read),
        new(
            ServerId,
            "save_scratch_note",
            "保存一条工作台便签（可逆写操作，dry-run 时只返回预览不落盘）。",
            """{"type":"object","required":["content"],"properties":{"content":{"type":"string","description":"便签正文"}}}""",
            RiskLevels.Write),
        new(
            ServerId,
            "publish_announcement",
            "发布公告（不可逆操作：对外可见，需要人工审批后才能真正执行）。",
            """{"type":"object","required":["title","body"],"properties":{"title":{"type":"string","description":"公告标题"},"body":{"type":"string","description":"公告正文"}}}""",
            RiskLevels.Irreversible)
    ];

    public Task<ToolEnvelope> InvokeAsync(
        ToolDescriptor tool,
        JsonElement arguments,
        ToolContext context,
        CancellationToken cancellationToken)
    {
        var elapsed = 0L;
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();

        ToolEnvelope envelope = tool.Name switch
        {
            "get_workspace_status" => GetWorkspaceStatus(context),
            "save_scratch_note" => SaveNote(arguments, context),
            "publish_announcement" => PublishAnnouncement(arguments, context),
            _ => Fail(ErrorCodes.ValidationError, $"内置工具不存在: {tool.Name}")
        };

        stopwatch.Stop();
        elapsed = stopwatch.ElapsedMilliseconds;

        envelope = envelope with { Server = new ToolServerInfo(ServerId, Version, "1.0", elapsed) };
        return Task.FromResult(envelope);
    }

    private ToolEnvelope GetWorkspaceStatus(ToolContext context)
    {
        var data = JsonSerializer.SerializeToElement(new
        {
            serverId = ServerId,
            uptimeSeconds = (long)(DateTimeOffset.Now - _startedAt).TotalSeconds,
            totalNotes = _notes.Count,
            dryRun = context.DryRun
        });
        return new ToolEnvelope(true, data, new ToolUsageInfo("call", 1), null, null, context.TraceId, false);
    }

    private ToolEnvelope SaveNote(JsonElement arguments, ToolContext context)
    {
        var content = GetStringArg(arguments, "content");
        if (string.IsNullOrWhiteSpace(content))
        {
            return Fail(ErrorCodes.ValidationError, "参数 content 不能为空");
        }

        if (context.DryRun)
        {
            var preview = JsonSerializer.SerializeToElement(new
            {
                dryRun = true,
                wouldSave = content,
                message = "试运行：本次为 dry-run，便签未落盘"
            });
            return new ToolEnvelope(true, preview, new ToolUsageInfo("call", 1), null, null, context.TraceId, false);
        }

        _notes[Guid.NewGuid().ToString("N")[..12]] = content;
        var data = JsonSerializer.SerializeToElement(new
        {
            saved = true,
            totalNotes = _notes.Count
        });
        return new ToolEnvelope(true, data, new ToolUsageInfo("call", 1), null, null, context.TraceId, false);
    }

    private ToolEnvelope PublishAnnouncement(JsonElement arguments, ToolContext context)
    {
        var title = GetStringArg(arguments, "title");
        var body = GetStringArg(arguments, "body");
        if (string.IsNullOrWhiteSpace(title) || string.IsNullOrWhiteSpace(body))
        {
            return Fail(ErrorCodes.ValidationError, "参数 title / body 不能为空");
        }

        if (context.DryRun)
        {
            var preview = JsonSerializer.SerializeToElement(new
            {
                dryRun = true,
                wouldPublish = new { title, body },
                message = "试运行：公告未发布"
            });
            return new ToolEnvelope(true, preview, new ToolUsageInfo("call", 1), null, null, context.TraceId, false);
        }

        var published = JsonSerializer.SerializeToElement(new
        {
            published = true,
            announcementId = "ann-" + Guid.NewGuid().ToString("N")[..8],
            title
        });
        return new ToolEnvelope(true, published, new ToolUsageInfo("call", 1), null, null, context.TraceId, false);
    }

    private static string? GetStringArg(JsonElement arguments, string name)
    {
        if (arguments.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        return arguments.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static ToolEnvelope Fail(int code, string message) => new(
        false,
        null,
        new ToolUsageInfo("call", 1),
        new ToolErrorInfo(code, message, ErrorCodes.IsRetryable(code)),
        null,
        string.Empty,
        false);
}
