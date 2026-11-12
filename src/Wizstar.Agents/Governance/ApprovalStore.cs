using System.Collections.ObjectModel;

namespace Wizstar.Agents.Governance;

/// <summary>审批单状态：pending / approved / rejected。</summary>
public static class ApprovalStatus
{
    public const string Pending = "pending";
    public const string Approved = "approved";
    public const string Rejected = "rejected";
}

/// <summary>
/// 一次 HITL 审批单。服务端从不自动批准；
/// 批准后也不自动执行——下一次携带相同 operationId 的工具调用才会真正落到工具层。
/// </summary>
public sealed record ApprovalRequest(
    Guid Id,
    string AgentKey,
    string ServerId,
    string ToolName,
    string Risk,
    string OperationId,
    string ArgsDigest,
    string ArgumentsJson,
    string Status,
    string? Note,
    DateTimeOffset CreatedAt,
    DateTimeOffset? DecidedAt);

/// <summary>审批单存储抽象（本期内存实现；落库留给业务库接入阶段）。</summary>
public interface IApprovalStore
{
    ApprovalRequest Create(ApprovalRequest request);

    ApprovalRequest? Get(Guid id);

    ApprovalRequest? FindPendingOrDecided(string serverId, string toolName, string operationId, string argsDigest);

    ApprovalRequest? Decide(Guid id, string status, string? note);

    IReadOnlyList<ApprovalRequest> List(string? status = null, int limit = 100);
}

/// <summary>内存审批存储：线程安全，只保留最近 MaxEntries 条（防内存膨胀）。</summary>
public sealed class InMemoryApprovalStore(int maxEntries = 500) : IApprovalStore
{
    private readonly object _lock = new();
    private readonly Dictionary<Guid, ApprovalRequest> _byId = new();
    private readonly Queue<Guid> _order = new();
    private readonly Dictionary<string, Guid> _byOperation = new(StringComparer.Ordinal);

    public ApprovalRequest Create(ApprovalRequest request)
    {
        lock (_lock)
        {
            _byId[request.Id] = request;
            _byOperation[OperationKey(request.ServerId, request.ToolName, request.OperationId, request.ArgsDigest)] = request.Id;
            _order.Enqueue(request.Id);

            while (_order.Count > maxEntries && _order.TryDequeue(out var oldest))
            {
                var old = _byId.GetValueOrDefault(oldest);
                if (old is not null)
                {
                    _byId.Remove(oldest);
                    _byOperation.Remove(OperationKey(old.ServerId, old.ToolName, old.OperationId, old.ArgsDigest));
                }
            }
        }

        return request;
    }

    public ApprovalRequest? Get(Guid id)
    {
        lock (_lock)
        {
            return _byId.GetValueOrDefault(id);
        }
    }

    public ApprovalRequest? FindPendingOrDecided(string serverId, string toolName, string operationId, string argsDigest)
    {
        lock (_lock)
        {
            var key = OperationKey(serverId, toolName, operationId, argsDigest);
            return _byOperation.TryGetValue(key, out var id) ? _byId.GetValueOrDefault(id) : null;
        }
    }

    public ApprovalRequest? Decide(Guid id, string status, string? note)
    {
        lock (_lock)
        {
            var existing = _byId.GetValueOrDefault(id);
            if (existing is null || existing.Status != ApprovalStatus.Pending)
            {
                return null; // 已决策或不存在：返回 null 让端点报错，不重复决策
            }

            var decided = existing with
            {
                Status = status,
                Note = note ?? existing.Note,
                DecidedAt = DateTimeOffset.Now
            };
            _byId[id] = decided;
            return decided;
        }
    }

    public IReadOnlyList<ApprovalRequest> List(string? status = null, int limit = 100)
    {
        lock (_lock)
        {
            IEnumerable<ApprovalRequest> query = _order.ToArray()
                .Reverse()
                .Select(id => _byId.GetValueOrDefault(id))
                .Where(r => r is not null)
                .Cast<ApprovalRequest>();

            if (!string.IsNullOrWhiteSpace(status))
            {
                query = query.Where(r => string.Equals(r.Status, status, StringComparison.Ordinal));
            }

            return new ReadOnlyCollection<ApprovalRequest>(query.Take(limit).ToList());
        }
    }

    private static string OperationKey(string serverId, string toolName, string operationId, string argsDigest) =>
        $"{serverId}|{toolName}|{operationId}|{argsDigest}";
}
