using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SqlSugar;
using Wizstar.Data.Entities.Business;

namespace Wizstar.Api.Services;

/// <summary>登录态用户（不含密码哈希）。</summary>
public sealed record AuthUser(long Id, string Username, string DisplayName, string Role);

/// <summary>登录结果：成功带 token，失败带可直接提示的文案。</summary>
public sealed record LoginResult(AuthUser? User, string? Token, DateTimeOffset? ExpiresAt, string? Error)
{
    public bool Ok => User is not null && Token is not null;

    public static LoginResult Success(AuthUser user, string token, DateTimeOffset expiresAt) =>
        new(user, token, expiresAt, null);

    public static LoginResult Fail(string error) => new(null, null, null, error);
}

/// <summary>
/// 密码哈希：PBKDF2-SHA256，存储格式 `pbkdf2-sha256$迭代次数$salt(base64)$hash(base64)`。
/// 只依赖 BCL，不引入第三方加密库；校验用固定时间比较，避免时序侧信道。
/// </summary>
public static class PasswordHasher
{
    private const int Iterations = 120_000;
    private const int SaltBytes = 16;
    private const int HashBytes = 32;
    private const string Scheme = "pbkdf2-sha256";

    public static string Hash(string password)
    {
        ArgumentNullException.ThrowIfNull(password);
        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, Iterations, HashAlgorithmName.SHA256, HashBytes);
        return $"{Scheme}${Iterations}${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    public static bool Verify(string? password, string? stored)
    {
        if (string.IsNullOrEmpty(password) || string.IsNullOrEmpty(stored))
        {
            return false;
        }

        var parts = stored.Split('$');
        if (parts.Length != 4 || !string.Equals(parts[0], Scheme, StringComparison.Ordinal))
        {
            return false;
        }
        if (!int.TryParse(parts[1], out var iterations) || iterations < 1000)
        {
            return false;
        }

        byte[] salt;
        byte[] expected;
        try
        {
            salt = Convert.FromBase64String(parts[2]);
            expected = Convert.FromBase64String(parts[3]);
        }
        catch (FormatException)
        {
            return false;
        }
        if (salt.Length == 0 || expected.Length == 0)
        {
            return false;
        }

        var actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }
}

/// <summary>
/// 无状态登录令牌：`wz1.{base64url(payload)}.{base64url(HMAC-SHA256)}`。
///
/// - payload 含 sub/usr/name/role/iat/exp，服务端验签后即可恢复登录态，不建会话表；
/// - 秘钥优先取配置 `Auth:Secret`；留空时按「机器名 + 当前用户」派生本机稳定密钥，
///   既避免把密钥写进仓库，也能在进程重启后保持登录态有效。
/// </summary>
public sealed class AuthTokenService
{
    private const string Version = "wz1";
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    private readonly byte[] _secret;

    public AuthTokenService(string? configuredSecret, int tokenHours = 12)
    {
        TokenHours = Math.Clamp(tokenHours, 1, 24 * 30);
        var material = string.IsNullOrWhiteSpace(configuredSecret)
            ? "wizstar-local-auth|" + Environment.MachineName + "|" + Environment.UserName
            : configuredSecret!.Trim();
        _secret = SHA256.HashData(Encoding.UTF8.GetBytes(material));
        IsDerivedSecret = string.IsNullOrWhiteSpace(configuredSecret);
    }

    public int TokenHours { get; }

    /// <summary>true = 使用本机派生的开发密钥（不是配置里显式给的）。</summary>
    public bool IsDerivedSecret { get; }

    public string Issue(AuthUser user)
    {
        var now = DateTimeOffset.UtcNow;
        var payload = new TokenPayload(
            user.Id, user.Username, user.DisplayName, user.Role,
            now.ToUnixTimeSeconds(), now.AddHours(TokenHours).ToUnixTimeSeconds());
        var body = Base64Url.EncodeToString(JsonSerializer.SerializeToUtf8Bytes(payload, JsonOptions));
        var signature = Sign(Version + "." + body);
        return $"{Version}.{body}.{signature}";
    }

    public bool TryValidate(string? token, out AuthUser? user)
    {
        user = null;
        if (string.IsNullOrWhiteSpace(token))
        {
            return false;
        }

        var parts = token.Trim().Split('.');
        if (parts.Length != 3 || !string.Equals(parts[0], Version, StringComparison.Ordinal))
        {
            return false;
        }

        var expected = Sign(parts[0] + "." + parts[1]);
        if (!FixedTimeEquals(expected, parts[2]))
        {
            return false;
        }

        TokenPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize<TokenPayload>(
                Base64Url.DecodeFromChars(parts[1]), JsonOptions);
        }
        catch (Exception ex) when (ex is FormatException or JsonException)
        {
            return false;
        }

        if (payload is null || payload.Exp <= DateTimeOffset.UtcNow.ToUnixTimeSeconds())
        {
            return false;
        }

        user = new AuthUser(payload.Sub, payload.Usr, payload.Name, payload.Role);
        return true;
    }

    /// <summary>登录接口回传给前端展示的过期时间（供 UI 做提前续期/提示）。</summary>
    public DateTimeOffset ExpiresAt() => DateTimeOffset.UtcNow.AddHours(TokenHours);

    private string Sign(string input)
    {
        using var hmac = new HMACSHA256(_secret);
        return Base64Url.EncodeToString(hmac.ComputeHash(Encoding.UTF8.GetBytes(input)));
    }

    private static bool FixedTimeEquals(string left, string right)
    {
        var a = Encoding.UTF8.GetBytes(left);
        var b = Encoding.UTF8.GetBytes(right);
        return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
    }

    private sealed record TokenPayload(long Sub, string Usr, string Name, string Role, long Iat, long Exp);
}

/// <summary>账号存储抽象：生产走 MySQL，测试可注入内存实现。</summary>
public interface IUserStore
{
    SysUser? FindByUsername(string username);

    void TouchLogin(long userId, DateTime at);

    void Insert(SysUser user);
}

/// <summary>sys_user 表的 SqlSugar 实现。</summary>
public sealed class SqlUserStore(ISqlSugarClient db) : IUserStore
{
    public SysUser? FindByUsername(string username) =>
        db.Queryable<SysUser>().First(u => u.Username == username);

    public void TouchLogin(long userId, DateTime at) =>
        db.Updateable<SysUser>()
            .SetColumns(u => u.LastLoginAt == at)
            .Where(u => u.Id == userId)
            .ExecuteCommand();

    public void Insert(SysUser user) =>
        db.Insertable(user).ExecuteCommand();
}

/// <summary>
/// 登录服务：默认管理员种子 + 账号密码校验 + 令牌签发。
/// 默认账号 admin / admin123（首次启动自动写入 sys_user，已存在则不覆盖密码）。
/// </summary>
public sealed class AuthService(IUserStore store, AuthTokenService tokens, ILogger<AuthService> logger)
{
    public const string DefaultUsername = "admin";
    public const string DefaultPassword = "admin123";

    /// <summary>补缺默认管理员；返回是否真的创建了账号。</summary>
    public bool EnsureSeed()
    {
        if (store.FindByUsername(DefaultUsername) is not null)
        {
            return false;
        }

        store.Insert(new SysUser
        {
            Username = DefaultUsername,
            PasswordHash = PasswordHasher.Hash(DefaultPassword),
            DisplayName = "系统管理员",
            Role = "admin",
            IsActive = true,
            // 既有库的 last_login_at 为 NOT NULL（CodeFirst 只增不改），种子时显式给值
            LastLoginAt = DateTime.Now,
            CreatedAt = DateTime.Now,
        });
        logger.LogWarning("已创建默认管理员账号 {User}（初始密码 {Password}），请尽快修改密码",
            DefaultUsername, DefaultPassword);
        return true;
    }

    public LoginResult Login(string? username, string? password)
    {
        var name = (username ?? string.Empty).Trim();
        if (name.Length == 0 || string.IsNullOrEmpty(password))
        {
            return LoginResult.Fail("请输入账号和密码");
        }

        var record = store.FindByUsername(name);
        // 账号不存在与密码错误返回同一文案，避免账号枚举
        if (record is null || !PasswordHasher.Verify(password, record.PasswordHash))
        {
            return LoginResult.Fail("账号或密码错误");
        }
        if (!record.IsActive)
        {
            return LoginResult.Fail("账号已停用，请联系管理员");
        }

        store.TouchLogin(record.Id, DateTime.Now);
        var user = new AuthUser(record.Id, record.Username, record.DisplayName, record.Role);
        return LoginResult.Success(user, tokens.Issue(user), tokens.ExpiresAt());
    }
}
