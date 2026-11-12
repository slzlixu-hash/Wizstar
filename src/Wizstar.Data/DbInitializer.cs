using SqlSugar;
using Wizstar.Data.Entities;

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
    ];

    /// <summary>用默认连接串直接初始化（供命令行 / 测试使用）。</summary>
    public static void Initialize(string connectionString, Action<string>? log = null)
    {
        using var db = CreateClient(connectionString);
        // 库不存在则创建（CREATE DATABASE IF NOT EXISTS Wizstar ... utf8mb4）
        db.DbMaintenance.CreateDatabase();
        // 按实体建表 / 补列（只增不改：已存在列不会删除或改类型）
        db.CodeFirst.InitTables(EntityTypes);
        log?.Invoke($"SqlSugar CodeFirst 完成：{string.Join(", ", EntityTypes.Select(t => t.Name))}");
    }

    /// <summary>构建标准 SqlSugar 客户端（MySQL，自动关闭连接）。</summary>
    public static SqlSugarClient CreateClient(string connectionString)
    {
        return new SqlSugarClient(new ConnectionConfig
        {
            ConnectionString = connectionString,
            DbType = DbType.MySql,
            IsAutoCloseConnection = true,
            InitKeyType = InitKeyType.Attribute,
        });
    }
}
