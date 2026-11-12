using System.Security.Cryptography;
using System.Text;

namespace Wizstar.Mcp;

/// <summary>
/// MCP-HMAC 请求签名（规范 §2.2）。
/// 签名原串：{method}\n{path}\n{ts}\n{nonce}\n{sha256hex(rawBody)}\n{keyId}
/// Authorization: MCP-HMAC keyId=...,ts=...,nonce=...,sig=base64url
/// </summary>
public static class McpHmacSigner
{
    public static string? BuildAuthorizationHeader(McpServiceConfig config, HttpMethod method, string path, string body)
    {
        if (string.IsNullOrWhiteSpace(config.AuthKeyId) || string.IsNullOrWhiteSpace(config.AuthSecret))
        {
            return null;
        }

        return BuildAuthorizationHeader(config.AuthKeyId, config.AuthSecret, method.Method, path, body);
    }

    public static string BuildAuthorizationHeader(string keyId, string secret, string method, string path, string body)
    {
        var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var nonce = Guid.NewGuid().ToString("N");
        var bodyHash = Sha256Hex(body ?? string.Empty);
        var stringToSign = $"{method}\n{path}\n{ts}\n{nonce}\n{bodyHash}\n{keyId}";
        var signature = Sign(secret, stringToSign);

        return $"MCP-HMAC keyId={keyId},ts={ts},nonce={nonce},sig={signature}";
    }

    /// <summary>服务端校验原串（演示服务与测试共用同一套规则）。</summary>
    public static string StringToSign(string method, string path, long ts, string nonce, string bodySha256Hex, string keyId) =>
        $"{method}\n{path}\n{ts}\n{nonce}\n{bodySha256Hex}\n{keyId}";

    public static string Sign(string secret, string stringToSign)
    {
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        return System.Buffers.Text.Base64Url.EncodeToString(
            hmac.ComputeHash(Encoding.UTF8.GetBytes(stringToSign)));
    }

    public static string Sha256Hex(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value ?? string.Empty));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}
