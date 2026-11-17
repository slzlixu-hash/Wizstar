using System.Collections.Concurrent;

namespace Wizstar.Api.Pipelines;

/// <summary>
/// 流水线运行控制：保存每个项目当前正在执行的 Advance 调用，用于「暂停 / 终止」时
/// 向执行器与下游工具调用发出取消信号，避免后续工序继续分派。
///
/// 说明：取消信号通过 CancellationToken 传递；执行器应把它传给 MCP / HTTP 调用，
/// 这样排队中的工具句柄会随 token 一起取消。数据库中同时落暂停/终止状态，
/// 即使进程重启，也不会继续推进已终止任务。
/// </summary>
public sealed class PipelineRunControl
{
    private readonly ConcurrentDictionary<string, RunState> _runs = new(StringComparer.Ordinal);

    internal PipelineRunLease Begin(string projectNo, CancellationToken cancellationToken)
    {
        var key = Normalize(projectNo);
        var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var state = new RunState(cts);

        if (_runs.TryGetValue(key, out var previous))
        {
            previous.Reason = "superseded";
            try { previous.Cts.Cancel(); } catch (ObjectDisposedException) { /* 上一轮已结束 */ }
        }

        _runs[key] = state;
        return new PipelineRunLease(this, key, state, cts.Token);
    }

    /// <summary>发出暂停/终止信号；执行器收到 token 取消后应尽快停止后续工序。</summary>
    public void Stop(string projectNo, string reason)
    {
        if (_runs.TryGetValue(Normalize(projectNo), out var state))
        {
            state.Reason = reason;
            try { state.Cts.Cancel(); } catch (ObjectDisposedException) { /* 已在收尾 */ }
        }
    }

    /// <summary>当前运行被停止的原因（pause / cancel / superseded），无运行返回 null。</summary>
    public string? Reason(string projectNo)
    {
        return _runs.TryGetValue(Normalize(projectNo), out var state) ? state.Reason : null;
    }

    internal void End(string key, RunState state)
    {
        if (_runs.TryGetValue(key, out var current) && ReferenceEquals(current, state))
        {
            _runs.TryRemove(key, out _);
        }
        state.Cts.Dispose();
    }

    private static string Normalize(string? projectNo) => (projectNo ?? string.Empty).Trim();

    internal sealed class RunState(CancellationTokenSource cts)
    {
        public CancellationTokenSource Cts { get; } = cts;
        public string? Reason { get; set; }
    }
}

/// <summary>一次 Advance 运行的租约；Dispose 时从控制表移除。</summary>
internal sealed class PipelineRunLease(
    PipelineRunControl owner, string projectNo, PipelineRunControl.RunState state, CancellationToken token) : IDisposable
{
    public CancellationToken Token { get; } = token;

    public void Dispose() => owner.End(projectNo, state);
}
