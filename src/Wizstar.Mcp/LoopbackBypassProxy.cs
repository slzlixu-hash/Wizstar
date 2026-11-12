using System.Net;

namespace Wizstar.Mcp;

/// <summary>
/// 回环地址强制直连代理。
///
/// 踩过的坑（旧项目 v2.0 治理层口径）：宿主环境注入 HTTP_PROXY 时，.NET 会把
/// 127.0.0.1 的请求也交给代理——代理转发后 Node 的 req.url 变成绝对地址，
/// 表现为「URL 明明正确却 404」或「拿回另一个服务的响应」。
/// 本地 MCP 服务必须直连回环，绝不走代理。
/// </summary>
public sealed class LoopbackBypassProxy(IWebProxy? inner) : IWebProxy
{
    public ICredentials? Credentials
    {
        get => inner?.Credentials;
        set { if (inner is not null) inner.Credentials = value; }
    }

    public Uri? GetProxy(Uri destination) =>
        IsLoopback(destination) ? null : inner?.GetProxy(destination);

    public bool IsBypassed(Uri host) =>
        IsLoopback(host) || (inner?.IsBypassed(host) ?? true);

    private static bool IsLoopback(Uri uri) =>
        uri.IsLoopback
        || string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase)
        || (IPAddress.TryParse(uri.Host, out var address) &&
            (IPAddress.IsLoopback(address) || IsLocalSubnet(address)));

    private static bool IsLocalSubnet(IPAddress address) =>
        address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork
        && address.GetAddressBytes()[..3] is [127, _, _];
}
