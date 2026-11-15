using SqlSugar;
using Wizstar.Data.Entities;
using Wizstar.Data.Entities.Business;

namespace Wizstar.Data;

/// <summary>
/// SqlSugar 接入：本地 MySQL Wizstar 库，CodeFirst。
/// 启动时调用 <see cref="Initialize"/>：库不存在则创建，然后按实体同步表结构。
/// </summary>
public static class DbInitializer
{
    private static readonly Type[] EntityTypes =
    [
        typeof(AgentSessionRecord),
        typeof(ApprovalRecord),
        typeof(OperationRecord),
        // 统一审计轨迹（轨迹日志界面）
        typeof(AuditLogRecord),
        typeof(LlmAgentBindingRecord),
        // 登录账号表（sys_user）：首次启动由 AuthService 种子写入默认管理员
        typeof(SysUser),
        // 商品立项主表：工作流字段（pipeline_id/current_stage/stage_status/stage_note）靠这里补列
        typeof(SkuProject),
        // 长期规则：tags / expires_at / hit_count / sample_count / sync_agent_keys 等自学习字段靠这里补列
        typeof(AgentMemory),
        // 本地知识库：enabled 启停字段靠这里补列
        typeof(AgentKnowledgeItem),
    ];

    /// <summary>用默认连接串直接初始化（供命令行 / 测试使用）。</summary>
    public static void Initialize(string connectionString, Action<string>? log = null)
    {
        using var db = CreateClient(connectionString);
        // 库不存在则创建（CREATE DATABASE IF NOT EXISTS Wizstar ... utf8mb4）
        db.DbMaintenance.CreateDatabase();
        // 按实体建表 / 补列（只增不改：已存在列不会删除或改类型）
        db.CodeFirst.InitTables(EntityTypes);
        // 既有库由 DbFirst 建表：后加的列会被补成 NOT NULL（无默认值），插入商品会失败。
        // CodeFirst 不会放宽已存在列，这里做一次幂等归一（仅当列存在且 NOT NULL 时 ALTER）。
        NormalizeNullableColumns(db, "sku_project", "pipeline_id", "current_stage", "stage_status", "stage_note");
        // 记忆表由 DbFirst 建表：自学习候选需要 verified_by/verified_at/source_ref 可空
        NormalizeNullableColumns(db, "agent_memory",
            "verified_by", "verified_at", "source_ref", "tags", "expires_at",
            "hit_count", "sample_count", "sync_agent_keys");
        log?.Invoke($"SqlSugar CodeFirst 完成：{string.Join(", ", EntityTypes.Select(t => t.Name))}");
    }

    /// <summary>把指定表的列放宽为可空（幂等；仅处理确实存在且 NOT NULL 的列）。</summary>
    private static void NormalizeNullableColumns(SqlSugarClient db, string table, params string[] columns)
    {
        try
        {
            var list = string.Join(",", columns.Select(c => "'" + c.Replace("'", "''") + "'"));
            var existing = db.Ado.SqlQuery<ColumnState>(
                $"SELECT COLUMN_NAME AS COLUMN_NAME, IS_NULLABLE AS IS_NULLABLE FROM information_schema.COLUMNS " +
                $"WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{table}' AND COLUMN_NAME IN ({list})");

            foreach (var column in existing.Where(c => !string.Equals(c.IS_NULLABLE, "YES", StringComparison.OrdinalIgnoreCase)))
            {
                var def = ColumnDefinitions.GetValueOrDefault(column.COLUMN_NAME, "VARCHAR(255)");
                db.Ado.ExecuteCommand(
                    $"ALTER TABLE `{table}` MODIFY COLUMN `{column.COLUMN_NAME}` {def} NULL DEFAULT NULL");
            }
        }
        catch (Exception)
        {
            // 归一失败不阻塞启动：实体侧已声明可空，新库不受影响；旧库会在插入时暴露真实错误
        }
    }

    /// <summary>工作流列的 DDL 类型（与实体 Length 保持一致）。</summary>
    private static readonly Dictionary<string, string> ColumnDefinitions = new(StringComparer.OrdinalIgnoreCase)
    {
        ["pipeline_id"] = "VARCHAR(64)",
        ["current_stage"] = "VARCHAR(64)",
        ["stage_status"] = "VARCHAR(32)",
        ["stage_note"] = "VARCHAR(512)",
        ["verified_by"] = "VARCHAR(255)",
        ["verified_at"] = "DATETIME",
        ["source_ref"] = "VARCHAR(255)",
        ["tags"] = "VARCHAR(256)",
        ["expires_at"] = "DATETIME",
        ["hit_count"] = "INT",
        ["sample_count"] = "INT",
        ["sync_agent_keys"] = "VARCHAR(256)",
    };

    /// <summary>information_schema 查询结果。</summary>
    private sealed class ColumnState
    {
        public string COLUMN_NAME { get; set; } = string.Empty;

        public string IS_NULLABLE { get; set; } = string.Empty;
    }

    /// <summary>标准连接配置（MySQL，自动关闭连接）。</summary>
    private static ConnectionConfig BuildConfig(string connectionString) => new()
    {
        ConnectionString = connectionString,
        DbType = DbType.MySql,
        IsAutoCloseConnection = true,
        InitKeyType = InitKeyType.Attribute,
    };

    /// <summary>构建标准 SqlSugar 客户端（供命令行 / 一次性初始化使用）。</summary>
    public static SqlSugarClient CreateClient(string connectionString) =>
        new SqlSugarClient(BuildConfig(connectionString));

    /// <summary>
    /// 构建线程安全客户端：注册成 Singleton 供多个 HTTP 请求共享时必须用 SqlSugarScope，
    /// 否则并发查询会抛 "This MySqlConnection is already in use"（A2 并行预取实测踩到）。
    /// </summary>
    public static ISqlSugarClient CreateScopeClient(string connectionString) =>
        new SqlSugarScope(BuildConfig(connectionString));
}
