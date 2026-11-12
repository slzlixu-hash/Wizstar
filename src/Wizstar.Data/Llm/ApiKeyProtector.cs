using System.Security.Cryptography;
using System.Text;

namespace Wizstar.Data.Llm;

/// <summary>
/// API Key 落库保护：AES-256-GCM，密文格式 version(1) | nonce(12) | tag(16) | ciphertext。
///
/// 主密钥来源优先级：Security:MasterKey 配置（可由环境变量 WIZSTAR_MASTER_KEY 覆盖）→
/// 本机开发默认派生值。这是「不在仓库里放明文凭据」的保护，不是生产级 KMS；
/// 明文只在用户主动点「显示」或装配模型请求时出现，不进日志、不进统一信封的错误消息。
/// </summary>
public static class ApiKeyProtector
{
    private const byte Version = 1;
    private const int NonceSize = 12;
    private const int TagSize = 16;
    private const string DevelopmentSeed = "wizstar-local-dev-master-key-v1";

    public static byte[] Protect(string plain, string? masterKey)
    {
        ArgumentNullException.ThrowIfNull(plain);
        var plainBytes = Encoding.UTF8.GetBytes(plain);
        var nonce = RandomNumberGenerator.GetBytes(NonceSize);
        var cipher = new byte[plainBytes.Length];
        var tag = new byte[TagSize];

        using var aes = new AesGcm(DeriveKey(masterKey), TagSize);
        aes.Encrypt(nonce, plainBytes, cipher, tag);

        var blob = new byte[1 + NonceSize + TagSize + cipher.Length];
        blob[0] = Version;
        nonce.CopyTo(blob, 1);
        tag.CopyTo(blob, 1 + NonceSize);
        cipher.CopyTo(blob, 1 + NonceSize + TagSize);
        return blob;
    }

    /// <summary>解密失败（密钥变更 / 数据损坏）一律返回 null，不抛异常、不泄露内容。</summary>
    public static string? Unprotect(byte[]? blob, string? masterKey)
    {
        if (blob is null || blob.Length < 1 + NonceSize + TagSize || blob[0] != Version)
        {
            return null;
        }

        try
        {
            var nonce = blob.AsSpan(1, NonceSize);
            var tag = blob.AsSpan(1 + NonceSize, TagSize);
            var cipher = blob.AsSpan(1 + NonceSize + TagSize);
            var plain = new byte[cipher.Length];

            using var aes = new AesGcm(DeriveKey(masterKey), TagSize);
            aes.Decrypt(nonce, cipher, tag, plain);
            return Encoding.UTF8.GetString(plain);
        }
        catch (CryptographicException)
        {
            return null;
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    /// <summary>掩码回显，如 sk-9****7a9c（头部 4 字符 + 掩码 + 尾部 4 字符）；短串只保留 ****。</summary>
    public static string Hint(string plain)
    {
        if (string.IsNullOrEmpty(plain))
        {
            return string.Empty;
        }

        return plain.Length <= 8
            ? "****"
            : plain[..4] + "****" + plain[^4..];
    }

    private static byte[] DeriveKey(string? masterKey) =>
        SHA256.HashData(Encoding.UTF8.GetBytes(
            string.IsNullOrWhiteSpace(masterKey) ? DevelopmentSeed : masterKey.Trim()));
}
