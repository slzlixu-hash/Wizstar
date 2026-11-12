using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;
using Wizstar.Contracts;

namespace Wizstar.Agents.Ledger;

public enum LedgerProbeKind
{
    /// <summary>全新 operationId。</summary>
    Missing,

    /// <summary>命中历史记录且参数一致：回放历史结果。</summary>
    Replayed,

    /// <summary>相同 operationId 但参数被篡改：报 43009。</summary>
    Tampered
}

public sealed record LedgerRecord(
    string Scope,
    string OperationId,
    string ArgsDigest,
    string Status,
    string? ResultJson,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

/// <summary>
/// 本地幂等账本（规范 §4）：内嵌 SQLite WAL 单文件存储，杜绝外部数据库依赖。
/// 主键 (scope, operationId)；操作日志至少保留 30 天，供 meta.list_operations 反查对账。
///
/// 状态机：EXECUTING → SUCCEEDED / FAILED。
/// 写操作统一流程：Probe → Missing 时 MarkExecuting → 执行 → Complete；命中回放 or 篡改拦截。
/// </summary>
public sealed class OperationLedger(string dbPath, ILogger<OperationLedger> logger) : IDisposable
{
    private const int RetentionDays = 30;
    private const string StatusExecuting = "EXECUTING";
    private const string StatusSucceeded = "SUCCEEDED";
    private const string StatusFailed = "FAILED";

    private readonly SemaphoreSlim _gate = new(1, 1);
    private SqliteConnection? _connection;
    private bool _initialized;

    public void Dispose()
    {
        _gate.Wait();
        try
        {
            _connection?.Dispose();
            _connection = null;
        }
        finally
        {
            _gate.Release();
        }
    }

    // ---------------------------------------------------------------- 查询

    public async Task<LedgerProbeResult> ProbeAsync(string scope, string operationId, string argsDigest, CancellationToken ct = default)
    {
        await EnsureInitializedAsync(ct).ConfigureAwait(false);
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            using var command = _connection!.CreateCommand();
            command.CommandText =
                "SELECT args_digest, status, result_json FROM operations WHERE scope = $scope AND operation_id = $operation_id";
            command.Parameters.AddWithValue("$scope", scope);
            command.Parameters.AddWithValue("$operation_id", operationId);

            using var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
            if (!reader.Read())
            {
                return LedgerProbeResult.Missing();
            }

            var storedDigest = reader.GetString(0);
            if (!string.Equals(storedDigest, argsDigest, StringComparison.Ordinal))
            {
                return LedgerProbeResult.Tampered();
            }

            var status = reader.GetString(1);
            var resultJson = reader.IsDBNull(2) ? null : reader.GetString(2);
            return LedgerProbeResult.Replayed(resultJson);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task MarkExecutingAsync(string scope, string operationId, string argsDigest, CancellationToken ct = default)
    {
        await EnsureInitializedAsync(ct).ConfigureAwait(false);
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            using var command = _connection!.CreateCommand();
            command.CommandText =
                "INSERT INTO operations (scope, operation_id, args_digest, status, result_json, created_at, updated_at) " +
                "VALUES ($scope, $operation_id, $args_digest, $status, NULL, $now, $now) " +
                "ON CONFLICT(scope, operation_id) DO NOTHING";
            command.Parameters.AddWithValue("$scope", scope);
            command.Parameters.AddWithValue("$operation_id", operationId);
            command.Parameters.AddWithValue("$args_digest", argsDigest);
            command.Parameters.AddWithValue("$status", StatusExecuting);
            command.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            await command.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task CompleteAsync(string scope, string operationId, bool succeeded, string? resultJson, CancellationToken ct = default)
    {
        await EnsureInitializedAsync(ct).ConfigureAwait(false);
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            using var command = _connection!.CreateCommand();
            command.CommandText =
                "UPDATE operations SET status = $status, result_json = $result, updated_at = $now " +
                "WHERE scope = $scope AND operation_id = $operation_id";
            command.Parameters.AddWithValue("$status", succeeded ? StatusSucceeded : StatusFailed);
            command.Parameters.AddWithValue("$result", (object?)resultJson ?? DBNull.Value);
            command.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            command.Parameters.AddWithValue("$scope", scope);
            command.Parameters.AddWithValue("$operation_id", operationId);
            await command.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<LedgerRecord?> GetAsync(string scope, string operationId, CancellationToken ct = default)
    {
        await EnsureInitializedAsync(ct).ConfigureAwait(false);
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            return await QueryOneAsync(scope, operationId, ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>孤儿对账：按时间窗口反查（规范 §6 meta.list_operations）。</summary>
    public async Task<IReadOnlyList<LedgerRecord>> ListSinceAsync(DateTimeOffset since, int limit = 200, CancellationToken ct = default)
    {
        await EnsureInitializedAsync(ct).ConfigureAwait(false);
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var records = new List<LedgerRecord>();
            using var command = _connection!.CreateCommand();
            command.CommandText =
                "SELECT scope, operation_id, args_digest, status, result_json, created_at, updated_at " +
                "FROM operations WHERE updated_at >= $since ORDER BY updated_at DESC LIMIT $limit";
            command.Parameters.AddWithValue("$since", since.ToUnixTimeMilliseconds());
            command.Parameters.AddWithValue("$limit", limit);

            using var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
            while (reader.Read())
            {
                records.Add(ReadRecord(reader));
            }

            return records;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>清理超过保留期的操作日志（保留周期至少 30 天）。</summary>
    public async Task<int> PruneAsync(CancellationToken ct = default)
    {
        await EnsureInitializedAsync(ct).ConfigureAwait(false);
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var cutoff = DateTimeOffset.UtcNow.AddDays(-RetentionDays).ToUnixTimeMilliseconds();
            using var command = _connection!.CreateCommand();
            command.CommandText = "DELETE FROM operations WHERE updated_at < $cutoff AND status != 'EXECUTING'";
            command.Parameters.AddWithValue("$cutoff", cutoff);
            return await command.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    // ---------------------------------------------------------------- 基础设施

    private async Task EnsureInitializedAsync(CancellationToken ct)
    {
        if (_initialized)
        {
            return;
        }

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_initialized)
            {
                return;
            }

            var directory = Path.GetDirectoryName(Path.GetFullPath(dbPath));
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            var connection = new SqliteConnection($"Data Source={dbPath}");
            await connection.OpenAsync(ct).ConfigureAwait(false);

            // WAL 模式（规范 §4.2）+ 忙等：避免锁冲突报 SQLITE_BUSY
            using (var pragma = connection.CreateCommand())
            {
                pragma.CommandText = "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA synchronous=NORMAL;";
                await pragma.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
            }

            using (var ddl = connection.CreateCommand())
            {
                ddl.CommandText =
                    """
                    CREATE TABLE IF NOT EXISTS operations (
                        scope TEXT NOT NULL,
                        operation_id TEXT NOT NULL,
                        args_digest TEXT NOT NULL,
                        status TEXT NOT NULL,
                        result_json TEXT,
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL,
                        PRIMARY KEY (scope, operation_id)
                    );
                    CREATE INDEX IF NOT EXISTS idx_operations_updated ON operations (updated_at);
                    """;
                await ddl.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
            }

            _connection = connection;
            _initialized = true;
            logger.LogInformation("幂等账本就绪: path={Path} (SQLite WAL)", dbPath);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<LedgerRecord?> QueryOneAsync(string scope, string operationId, CancellationToken ct)
    {
        using var command = _connection!.CreateCommand();
        command.CommandText =
            "SELECT scope, operation_id, args_digest, status, result_json, created_at, updated_at " +
            "FROM operations WHERE scope = $scope AND operation_id = $operation_id";
        command.Parameters.AddWithValue("$scope", scope);
        command.Parameters.AddWithValue("$operation_id", operationId);

        using var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
        return reader.Read() ? ReadRecord(reader) : null;
    }

    private static LedgerRecord ReadRecord(SqliteDataReader reader) => new(
        reader.GetString(0),
        reader.GetString(1),
        reader.GetString(2),
        reader.GetString(3),
        reader.IsDBNull(4) ? null : reader.GetString(4),
        DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(5)),
        DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(6)));
}

public sealed record LedgerProbeResult(LedgerProbeKind Kind, string? ResultJson)
{
    public static LedgerProbeResult Missing() => new(LedgerProbeKind.Missing, null);

    public static LedgerProbeResult Replayed(string? resultJson) => new(LedgerProbeKind.Replayed, resultJson);

    public static LedgerProbeResult Tampered() => new(LedgerProbeKind.Tampered, null);
}

/// <summary>operationId 平台侧统一生成（规范 §4.1）：op-{yyyyMMdd}-{contentHash16}。</summary>
public static class OperationId
{
    public static string Generate(string serverId, string toolName, string canonicalArgs)
    {
        var date = DateTime.UtcNow.ToString("yyyyMMdd", CultureInfo.InvariantCulture);
        var hash = Sha256Hex($"{serverId}|{toolName}|{canonicalArgs}")[..16];
        return $"op-{date}-{hash}";
    }

    public static string ArgsDigest(string argsJson) => Sha256Hex(argsJson);

    private static string Sha256Hex(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}
