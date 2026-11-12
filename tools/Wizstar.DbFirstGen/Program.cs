using System.Text.Json;
using System.Text.RegularExpressions;
using Wizstar.Data;

// =============================================================================
// Wizstar DbFirst 实体生成器
// 读取 src/Wizstar.Api/appsettings.json 的 Database:MySql 连接串，
// 从 Wizstar 库中排除运行态 wiz_* 表，把业务表反向生成实体类。
// 可重复执行：每次先清空输出目录下已生成的 .cs，再全量重建。
// 用法：dotnet run --project tools/Wizstar.DbFirstGen
// =============================================================================

const string EntityNamespace = "Wizstar.Data.Entities.Business";

var repoRoot = FindRepoRoot();
var settingsPath = Path.Combine(repoRoot, "src", "Wizstar.Api", "appsettings.json");
using var settings = JsonDocument.Parse(File.ReadAllText(settingsPath));
var connectionString = settings.RootElement
    .GetProperty("Database").GetProperty("MySql").GetString()
    ?? throw new InvalidOperationException("appsettings.json 缺少 Database:MySql");

using var db = DbInitializer.CreateClient(connectionString);

// 业务表 = 库中全部表 - SqlSugar CodeFirst 管理的 wiz_* 运行态表
var tables = db.Ado.SqlQuery<string>(
        "SELECT table_name FROM information_schema.tables " +
        "WHERE table_schema = DATABASE() AND table_name NOT LIKE 'wiz\\_%' " +
        "ORDER BY table_name")
    .ToArray();

if (tables.Length == 0)
{
    Console.Error.WriteLine("库中未发现业务表，请先执行 db/migrations/V1__agentworkbench_schema.sql");
    return 1;
}

var outputDir = Path.Combine(repoRoot, "src", "Wizstar.Data", "Entities", "Business");
Directory.CreateDirectory(outputDir);
foreach (var stale in Directory.GetFiles(outputDir, "*.cs"))
{
    File.Delete(stale);
}

// DbFirst：PascalCase 类名/属性名/文件名 + SugarTable / SugarColumn 特性
db.DbFirst
    .Where(tables)
    .FormatClassName(ToPascalCase)
    .FormatPropertyName(ToPascalCase)
    .FormatFileName(ToPascalCase)
    .IsCreateAttribute()
    .CreateClassFile(outputDir, EntityNamespace);

// 生成物为 nullable-oblivious 风格（string 属性无初始化器），关闭该文件域的
// nullable 检查，避免 CS8618 警告污染构建输出；业务侧仍可正常读写。
foreach (var file in Directory.GetFiles(outputDir, "*.cs"))
{
    var text = File.ReadAllText(file).TrimStart('\uFEFF');

    // MySQL JSON 列 DbFirst 默认给 object（写入时类型不可控）；统一改为 string，
    // 保存原始 JSON 文本，业务侧用 System.Text.Json 自行反序列化。
    text = Regex.Replace(
        text,
        @"public object (\w+) \{get;set;\}",
        "public string $1 {get;set;} // JSON 文本");

    if (!text.StartsWith("#nullable disable", StringComparison.Ordinal))
    {
        text = "#nullable disable\n" + text;
    }
    File.WriteAllText(file, text, new System.Text.UTF8Encoding(false));
}

var generated = Directory.GetFiles(outputDir, "*.cs");
Console.WriteLine($"DbFirst 完成：{tables.Length} 张业务表 → {generated.Length} 个实体类");
Console.WriteLine($"输出目录：{outputDir}");
Console.WriteLine($"命名空间：{EntityNamespace}");
foreach (var file in generated.OrderBy(f => f))
{
    Console.WriteLine($"  {Path.GetFileName(file)}");
}

// 可选冒烟：用刚生成的实体真实插入/查询/删除一条，验证映射可用
if (args.Contains("--smoke", StringComparer.OrdinalIgnoreCase))
{
    var probe = new Wizstar.Data.Entities.Business.SelectionBatch
    {
        BatchId = "dbfirst_smoke_" + DateTime.UtcNow.ToString("yyyyMMddHHmmss"),
        BatchName = "DbFirst 冒烟验证",
        SelectionSource = "manual",
        TargetCount = 1,
        CompletedCount = 0,
        Status = "completed",
        CreatedAt = DateTime.UtcNow,
        UpdatedAt = DateTime.UtcNow,
    };
    var newId = db.Insertable(probe).ExecuteReturnBigIdentity();
    var loaded = db.Queryable<Wizstar.Data.Entities.Business.SelectionBatch>()
        .Where(x => x.Id == newId).First();
    Console.WriteLine($"冒烟读写成功：id={newId}, batch_id={loaded?.BatchId}, status={loaded?.Status}");
    db.Deleteable<Wizstar.Data.Entities.Business.SelectionBatch>()
        .Where(x => x.Id == newId).ExecuteCommand();
    Console.WriteLine("冒烟数据已清理");
}

return 0;

static string ToPascalCase(string name)
{
    return string.Concat(name
        .Split('_', StringSplitOptions.RemoveEmptyEntries)
        .Select(part => char.ToUpperInvariant(part[0]) + part[1..]));
}

static string FindRepoRoot()
{
    var dir = new DirectoryInfo(AppContext.BaseDirectory);
    while (dir is not null)
    {
        if (File.Exists(Path.Combine(dir.FullName, "Wizstar.slnx")))
        {
            return dir.FullName;
        }
        dir = dir.Parent;
    }
    throw new InvalidOperationException("未找到仓库根目录（Wizstar.slnx）");
}
