using Wizstar.Api.Services;
using Wizstar.Data.Entities.Business;

namespace Wizstar.Tests;

/// <summary>内存版账号存储：不依赖 MySQL，覆盖登录服务的行为契约。</summary>
public sealed class InMemoryUserStore : IUserStore
{
    private readonly List<SysUser> _rows = [];
    private long _nextId = 1;

    public IReadOnlyList<SysUser> Rows => _rows;

    public int InsertCount { get; private set; }

    public DateTime? LastTouch { get; private set; }

    public SysUser? FindByUsername(string username) =>
        _rows.FirstOrDefault(u => string.Equals(u.Username, username, StringComparison.Ordinal));

    public void TouchLogin(long userId, DateTime at)
    {
        var row = _rows.FirstOrDefault(u => u.Id == userId);
        if (row is not null)
        {
            row.LastLoginAt = at;
        }
        LastTouch = at;
    }

    public void Insert(SysUser user)
    {
        user.Id = _nextId++;
        _rows.Add(user);
        InsertCount++;
    }
}

public class PasswordHasherTests
{
    [Fact]
    public void Hash_ProducesPbkdf2Format_WithUniqueSalt()
    {
        var first = PasswordHasher.Hash("admin123");
        var second = PasswordHasher.Hash("admin123");

        Assert.StartsWith("pbkdf2-sha256$120000$", first);
        Assert.Equal(4, first.Split('$').Length);
        Assert.NotEqual(first, second); // 随机盐 → 同一密码两次哈希不同
        Assert.DoesNotContain("admin123", first); // 明文绝不出现
    }

    [Fact]
    public void Verify_AcceptsCorrectPassword_AndRejectsOthers()
    {
        var stored = PasswordHasher.Hash("admin123");

        Assert.True(PasswordHasher.Verify("admin123", stored));
        Assert.False(PasswordHasher.Verify("admin124", stored));
        Assert.False(PasswordHasher.Verify("", stored));
        Assert.False(PasswordHasher.Verify("admin123", null));
    }

    [Theory]
    [InlineData("plain-text-password")]
    [InlineData("pbkdf2-sha256$abc$zzz$yyy")]
    [InlineData("pbkdf2-sha256$120000$not-base64$also-bad")]
    [InlineData("bcrypt$12$whatever")]
    public void Verify_RejectsMalformedStoredHashes(string stored)
    {
        Assert.False(PasswordHasher.Verify("admin123", stored));
    }
}

public class AuthTokenServiceTests
{
    [Fact]
    public void IssueAndValidate_RoundTripsUser()
    {
        var tokens = new AuthTokenService("unit-test-secret", 12);
        var user = new AuthUser(7, "admin", "系统管理员", "admin");

        var token = tokens.Issue(user);

        Assert.StartsWith("wz1.", token);
        Assert.Equal(3, token.Split('.').Length);
        Assert.True(tokens.TryValidate(token, out var parsed));
        Assert.NotNull(parsed);
        Assert.Equal(user.Id, parsed!.Id);
        Assert.Equal(user.Username, parsed.Username);
        Assert.Equal("admin", parsed.Role);
    }

    [Fact]
    public void Validate_RejectsTamperedOrForeignTokens()
    {
        var tokens = new AuthTokenService("unit-test-secret", 12);
        var token = tokens.Issue(new AuthUser(1, "admin", "管理员", "admin"));

        // 篡改 payload
        var parts = token.Split('.');
        Assert.False(tokens.TryValidate($"{parts[0]}.{parts[1]}x.{parts[2]}", out _));

        // 篡改签名
        Assert.False(tokens.TryValidate($"{parts[0]}.{parts[1]}.{parts[2]}x", out _));

        // 换密钥签发的令牌
        var other = new AuthTokenService("another-secret", 12);
        Assert.False(tokens.TryValidate(other.Issue(new AuthUser(1, "admin", "管理员", "admin")), out _));

        // 空 / 格式错
        Assert.False(tokens.TryValidate(null, out _));
        Assert.False(tokens.TryValidate("not-a-token", out _));
        Assert.False(tokens.TryValidate("", out _));
    }

    [Fact]
    public void DerivedSecret_IsStable_AndTokensSurviveRestart()
    {
        var first = new AuthTokenService(null, 12);
        var second = new AuthTokenService("", 12);

        Assert.True(first.IsDerivedSecret);
        var token = first.Issue(new AuthUser(1, "admin", "管理员", "admin"));
        Assert.True(second.TryValidate(token, out _)); // 同一台机器重启后仍有效
    }
}

public class AuthServiceTests
{
    private static AuthService Create(InMemoryUserStore store) =>
        new(store, new AuthTokenService("unit-test-secret", 12), LoggerFactoryHolder.Create<AuthService>());

    [Fact]
    public void EnsureSeed_CreatesDefaultAdminOnce_WithoutOverwriting()
    {
        var store = new InMemoryUserStore();
        var service = Create(store);

        Assert.True(service.EnsureSeed());
        Assert.False(service.EnsureSeed()); // 幂等：已存在不再插入

        Assert.Equal(1, store.InsertCount);
        var admin = store.FindByUsername(AuthService.DefaultUsername);
        Assert.NotNull(admin);
        Assert.Equal("admin", admin!.Role);
        Assert.True(admin.IsActive);
        Assert.True(PasswordHasher.Verify(AuthService.DefaultPassword, admin.PasswordHash));
        Assert.False(PasswordHasher.Verify("wrong-password", admin.PasswordHash));
    }

    [Fact]
    public void Login_WithDefaultCredentials_ReturnsTokenAndTouchesLastLogin()
    {
        var store = new InMemoryUserStore();
        var service = Create(store);
        service.EnsureSeed();

        var result = service.Login("admin", "admin123");

        Assert.True(result.Ok);
        Assert.NotNull(result.User);
        Assert.Equal("admin", result.User!.Username);
        Assert.NotNull(result.Token);
        Assert.NotNull(result.ExpiresAt);
        Assert.NotNull(store.LastTouch);

        // 令牌可被同一密钥的服务验证
        var tokens = new AuthTokenService("unit-test-secret", 12);
        Assert.True(tokens.TryValidate(result.Token, out var parsed));
        Assert.Equal("admin", parsed!.Username);
    }

    [Fact]
    public void Login_WrongCredentials_ReturnsGenericError()
    {
        var store = new InMemoryUserStore();
        var service = Create(store);
        service.EnsureSeed();

        var wrongPassword = service.Login("admin", "wrong");
        var unknownUser = service.Login("nobody", "admin123");

        Assert.False(wrongPassword.Ok);
        Assert.False(unknownUser.Ok);
        // 不区分「账号不存在」与「密码错误」，避免账号枚举
        Assert.Equal(wrongPassword.Error, unknownUser.Error);
        Assert.Equal("账号或密码错误", wrongPassword.Error);
        Assert.Null(store.LastTouch);
    }

    [Fact]
    public void Login_InactiveAccount_IsRejected()
    {
        var store = new InMemoryUserStore();
        var service = Create(store);
        service.EnsureSeed();
        store.FindByUsername("admin")!.IsActive = false;

        var result = service.Login("admin", "admin123");

        Assert.False(result.Ok);
        Assert.Equal("账号已停用，请联系管理员", result.Error);
    }

    [Fact]
    public void Login_BlankInput_IsRejectedWithoutLookup()
    {
        var store = new InMemoryUserStore();
        var service = Create(store);
        service.EnsureSeed();

        Assert.Equal("请输入账号和密码", service.Login("", "admin123").Error);
        Assert.Equal("请输入账号和密码", service.Login("admin", "").Error);
        Assert.Equal("请输入账号和密码", service.Login(null, null).Error);
    }
}
