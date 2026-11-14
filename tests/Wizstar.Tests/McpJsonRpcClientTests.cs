using System.Text;
using System.Text.Json;
using Wizstar.Mcp;

namespace Wizstar.Tests;

/// <summary>
/// 进程内假 MCP 服务（规范 V1.0 对齐）：/healthz + POST /mcp JSON-RPC，
/// 校验 McpJsonRpcClient 的握手 / 会话 / 工具清单 / 调用 / HMAC 全链路。
/// </summary>
public sealed class FakeMcpServer : IDisposable
{
    private readonly HttpListener _listener = new();
    private readonly string _prefix;

    public string BaseUrl { get; }

    /// <summary>按四档鉴权期望构造：hmac 验签 / bearer 头 / 自定义 header / none（拒绝任何鉴权头，证明客户端确实没发）。</summary>
    public FakeMcpServer(string? hmacSecret = null, string? bearerSecret = null, string? headerSecret = null, string? headerName = "X-Api-Key")
    {
        var port = GetFreePort();
        _prefix = $"http://127.0.0.1:{port}/mcpdemo/";
        BaseUrl = $"http://127.0.0.1:{port}/mcpdemo";
        HmacSecret = hmacSecret;
        BearerSecret = bearerSecret;
        HeaderSecret = headerSecret;
        HeaderName = headerName ?? "X-Api-Key";
        _listener.Prefixes.Add(_prefix);
    }

    public string? HmacSecret { get; }
    public string? BearerSecret { get; }
    public string? HeaderSecret { get; }
    public string HeaderName { get; }

    public int AuthFailCount;

    public int HealthProbeCount;
    public int InitializeCount;

    public void Start()
    {
        _listener.Start();
        _ = Task.Run(async () =>
        {
            while (_listener.IsListening)
            {
                HttpListenerContext context;
                try
                {
                    context = await _listener.GetContextAsync();
                }
                catch (HttpListenerException)
                {
                    return; // listener 已停
                }

                try
                {
                    await HandleAsync(context);
                }
                catch
                {
                    // 演示服务：单请求失败不崩
                }
            }
        });
    }

    private async Task HandleAsync(HttpListenerContext context)
    {
        var request = context.Request;
        var response = context.Response;

        if (request.HttpMethod == "GET" && request.Url!.AbsolutePath == "/mcpdemo/healthz")
        {
            Interlocked.Increment(ref HealthProbeCount);
            await WriteJsonAsync(response, 200, new { status = "ok" });
            return;
        }

        if (request.HttpMethod != "POST" || request.Url!.AbsolutePath != "/mcpdemo/mcp")
        {
            await WriteJsonAsync(response, 404, new { error = "not found" });
            return;
        }

        using var reader = new StreamReader(request.InputStream, Encoding.UTF8);
        var body = await reader.ReadToEndAsync();
        using var document = JsonDocument.Parse(body);
        var root = document.RootElement;
        var id = root.TryGetProperty("id", out var idNode) ? idNode.GetInt64() : (long?)null;
        var method = root.TryGetProperty("method", out var methodNode) ? methodNode.GetString() : "";

        if (!VerifyAuth(request, body))
        {
            Interlocked.Increment(ref AuthFailCount);
            await WriteJsonAsync(response, 200, new
            {
                jsonrpc = "2.0",
                id,
                error = new { code = 41001, message = "鉴权失败" }
            });
            return;
        }

        switch (method)
        {
            case "initialize":
                Interlocked.Increment(ref InitializeCount);
                await WriteJsonAsync(response, 200, new
                {
                    jsonrpc = "2.0",
                    id,
                    result = new
                    {
                        protocolVersion = McpJsonRpcClient.ProtocolVersion,
                        capabilities = new { tools = new { } },
                        serverInfo = new { name = "fake-server", version = "9.9.9" }
                    }
                }, new Dictionary<string, string> { ["Mcp-Session-Id"] = "fake-session-1" });
                break;

            case "notifications/initialized":
                response.StatusCode = 202;
                response.Close();
                break;

            case "tools/list":
                await WriteJsonAsync(response, 200, new
                {
                    jsonrpc = "2.0",
                    id,
                    result = new
                    {
                        tools = new object[]
                        {
                            new Dictionary<string, object?>
                            {
                                ["name"] = "get_fake_status",
                                ["description"] = "假只读工具",
                                ["x-risk"] = "read",
                                ["inputSchema"] = JsonSerializer.Deserialize<JsonElement>("""{"type":"object","properties":{}}""")
                            },
                            new Dictionary<string, object?>
                            {
                                ["name"] = "update_fake_record",
                                ["description"] = "假写工具",
                                ["inputSchema"] = JsonSerializer.Deserialize<JsonElement>("""{"type":"object","properties":{}}""")
                            }
                        }
                    }
                });
                break;

            case "tools/call":
                var toolName = root.GetProperty("params").GetProperty("name").GetString();
                await WriteJsonAsync(response, 200, new
                {
                    jsonrpc = "2.0",
                    id,
                    result = new
                    {
                        content = new object[]
                        {
                            new { type = "text", text = $$"""{"success":true,"data":{"tool":"{{toolName}}"},"traceId":"t-1","replayed":false}""" }
                        }
                    }
                });
                break;

            default:
                await WriteJsonAsync(response, 200, new
                {
                    jsonrpc = "2.0",
                    id,
                    error = new { code = -32601, message = $"method not found: {method}" }
                });
                break;
        }
    }

    private bool VerifyAuth(HttpListenerRequest request, string body)
    {
        if (HmacSecret is not null) return VerifyHmac(request, body);
        if (BearerSecret is not null) return request.Headers["Authorization"] == "Bearer " + BearerSecret;
        if (HeaderSecret is not null) return request.Headers[HeaderName] == HeaderSecret;

        // none 模式：任何鉴权头都算多余（证明客户端确实没发 Authorization / Key 头）
        return request.Headers["Authorization"] is null
            && request.Headers["X-Api-Key"] is null
            && request.Headers["X-Custom-Key"] is null;
    }

    private bool VerifyHmac(HttpListenerRequest request, string body)
    {
        var header = request.Headers["Authorization"] ?? string.Empty;
        var match = System.Text.RegularExpressions.Regex.Match(
            header, @"^MCP-HMAC keyId=([^,]+),ts=(\d+),nonce=([^,]+),sig=([A-Za-z0-9_-]+)$");
        if (!match.Success)
        {
            return false;
        }

        var bodyHash = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(body))).ToLowerInvariant();
        var stringToSign = $"{request.HttpMethod}\n{request.Url!.PathAndQuery}\n{match.Groups[2].Value}\n{match.Groups[3].Value}\n{bodyHash}\n{match.Groups[1].Value}";
        var expected = Wizstar.Mcp.McpHmacSigner.Sign(HmacSecret!, stringToSign);
        return expected == match.Groups[4].Value;
    }

    private static async Task WriteJsonAsync(
        HttpListenerResponse response, int status, object payload, Dictionary<string, string>? headers = null)
    {
        var body = JsonSerializer.Serialize(payload);
        response.StatusCode = status;
        response.ContentType = "application/json; charset=utf-8";
        if (headers is not null)
        {
            foreach (var pair in headers)
            {
                response.Headers[pair.Key] = pair.Value;
            }
        }

        var bytes = Encoding.UTF8.GetBytes(body);
        response.ContentLength64 = bytes.Length;
        await response.OutputStream.WriteAsync(bytes);
        response.Close();
    }

    private static int GetFreePort()
    {
        using var socket = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        socket.Start();
        return ((System.Net.IPEndPoint)socket.LocalEndpoint).Port;
    }

    public void Dispose()
    {
        _listener.Stop();
        _listener.Close();
    }
}

public class McpJsonRpcClientTests : IDisposable
{
    private readonly FakeMcpServer _server;
    private readonly HttpClient _http;
    private readonly ILogger _logger = LoggerFactoryHolder.Create<McpJsonRpcClient>();

    public McpJsonRpcClientTests()
    {
        _server = new FakeMcpServer();
        _server.Start();
        _http = new HttpClient();
    }

    public void Dispose()
    {
        _http.Dispose();
        _server.Dispose();
    }

    private McpJsonRpcClient CreateClient(string? keyId = null, string? secret = null)
    {
        var config = new McpServiceConfig
        {
            Id = "fake",
            Name = "假服务",
            Transport = "http",
            Url = _server.BaseUrl,
            AuthKeyId = keyId,
            AuthSecret = secret
        };
        return new McpJsonRpcClient("fake", config, _http, _logger);
    }

    [Fact]
    public async Task Connect_InitializesAndCapturesServerInfo()
    {
        var client = CreateClient();
        var (name, version, protocol) = await client.ConnectAsync();

        Assert.Equal("fake-server", name);
        Assert.Equal("9.9.9", version);
        Assert.Equal(McpJsonRpcClient.ProtocolVersion, protocol);
        Assert.True(client.IsInitialized);
    }

    [Fact]
    public async Task ListTools_ReturnsXRiskDeclarations()
    {
        var client = CreateClient();
        var tools = await client.ListToolsAsync();

        Assert.Equal(2, tools.Count);
        var readTool = tools.Single(t => t.Name == "get_fake_status");
        Assert.Equal("read", readTool.DeclaredRisk);

        var writeTool = tools.Single(t => t.Name == "update_fake_record");
        Assert.Null(writeTool.DeclaredRisk);
    }

    [Fact]
    public async Task CallTool_ReturnsEnvelopeText()
    {
        var client = CreateClient();
        var raw = await client.CallToolAsync("update_fake_record", """{"content":"hello"}""");

        Assert.Contains("\"success\":true", raw);
        Assert.Contains("update_fake_record", raw);
    }

    [Fact]
    public async Task Handshake_IsIdempotentWithinClient()
    {
        var client = CreateClient();
        await client.ConnectAsync();
        await client.ConnectAsync();
        Assert.Equal(1, _server.InitializeCount);
    }

    [Fact]
    public async Task HealthProbe_ReturnsTrue()
    {
        var client = CreateClient();
        Assert.True(await client.HealthProbeAsync());
    }

    [Fact]
    public async Task HmacSignedRequests_AreAcceptedByServer()
    {
        // 兼容口径：配置只有 keyId+secret、未写 authType → 自动归一化为 hmac 并签名
        using var server = new FakeMcpServer(hmacSecret: "test-secret");
        server.Start();

        var config = new McpServiceConfig
        {
            Id = "fake",
            Transport = "http",
            Url = server.BaseUrl,
            AuthKeyId = "wizstar",
            AuthSecret = "test-secret"
        };
        var client = new McpJsonRpcClient("fake", config, _http, _logger);
        var tools = await client.ListToolsAsync();
        Assert.Equal(2, tools.Count);
        Assert.Equal(0, server.AuthFailCount);
    }

    [Fact]
    public async Task UnsignedRequests_AreRejectedWhenServerRequiresHmac()
    {
        using var server = new FakeMcpServer(hmacSecret: "test-secret");
        server.Start();

        var config = new McpServiceConfig { Id = "fake", Transport = "http", Url = server.BaseUrl };
        var client = new McpJsonRpcClient("fake", config, _http, _logger);

        var ex = await Assert.ThrowsAsync<McpProtocolException>(() => client.ConnectAsync());
        Assert.Contains("41001", ex.Message);
    }

    /* ------------------------------ 四档鉴权模式 ------------------------------ */

    [Theory]
    // 旧清单兼容：未写 authType 但配了密钥对 → hmac；其余退化 none
    [InlineData(null, true, McpAuthTypes.Hmac)]
    [InlineData("", false, McpAuthTypes.None)]
    [InlineData("bearer", false, McpAuthTypes.Bearer)]
    [InlineData("HEADER", false, McpAuthTypes.Header)]
    [InlineData("unknown", true, McpAuthTypes.None)]
    [InlineData("HMAC", false, McpAuthTypes.Hmac)]
    public void AuthType_NormalizesCorrectly(string? raw, bool hasKeyIdAndSecret, string expected)
    {
        Assert.Equal(expected, McpAuthTypes.Normalize(raw, hasKeyIdAndSecret));
    }

    [Fact]
    public async Task NoneMode_SendsNoAuthHeader_EvenWithStaleCredentials()
    {
        // none 服务端拒绝任何鉴权头：残留的 keyId/secret 也不得被客户端带出
        using var server = new FakeMcpServer();
        server.Start();

        var config = new McpServiceConfig
        {
            Id = "fake",
            Transport = "http",
            Url = server.BaseUrl,
            AuthType = McpAuthTypes.None,
            AuthKeyId = "stale-key",
            AuthSecret = "stale-secret"
        };
        var client = new McpJsonRpcClient("fake", config, _http, _logger);

        var tools = await client.ListToolsAsync();
        Assert.Equal(2, tools.Count);
        Assert.Equal(0, server.AuthFailCount);
    }

    [Fact]
    public async Task BearerMode_SendsStandardAuthorizationHeader()
    {
        using var server = new FakeMcpServer(bearerSecret: "bk-secret-123");
        server.Start();

        var config = new McpServiceConfig
        {
            Id = "fake",
            Transport = "http",
            Url = server.BaseUrl,
            AuthType = McpAuthTypes.Bearer,
            AuthSecret = "bk-secret-123"
        };
        var client = new McpJsonRpcClient("fake", config, _http, _logger);

        Assert.Equal(2, (await client.ListToolsAsync()).Count);
        Assert.Equal(0, server.AuthFailCount);
    }

    [Fact]
    public async Task BearerMode_WrongKey_IsRejectedByServer()
    {
        using var server = new FakeMcpServer(bearerSecret: "bk-secret-123");
        server.Start();

        var config = new McpServiceConfig
        {
            Id = "fake",
            Transport = "http",
            Url = server.BaseUrl,
            AuthType = McpAuthTypes.Bearer,
            AuthSecret = "wrong-key"
        };
        var client = new McpJsonRpcClient("fake", config, _http, _logger);

        var ex = await Assert.ThrowsAsync<McpProtocolException>(() => client.ConnectAsync());
        Assert.Contains("41001", ex.Message);
    }

    [Fact]
    public async Task HeaderMode_SendsCustomHeader()
    {
        using var server = new FakeMcpServer(headerSecret: "hk-456", headerName: "X-Custom-Key");
        server.Start();

        var config = new McpServiceConfig
        {
            Id = "fake",
            Transport = "http",
            Url = server.BaseUrl,
            AuthType = McpAuthTypes.Header,
            AuthHeaderName = "X-Custom-Key",
            AuthSecret = "hk-456"
        };
        var client = new McpJsonRpcClient("fake", config, _http, _logger);

        Assert.Equal(2, (await client.ListToolsAsync()).Count);
        Assert.Equal(0, server.AuthFailCount);
    }

    [Fact]
    public async Task HeaderMode_DefaultsToXApiKeyHeader()
    {
        using var server = new FakeMcpServer(headerSecret: "hk-456"); // 缺省头名 X-Api-Key
        server.Start();

        var config = new McpServiceConfig
        {
            Id = "fake",
            Transport = "http",
            Url = server.BaseUrl,
            AuthType = McpAuthTypes.Header,
            AuthSecret = "hk-456"
        };
        var client = new McpJsonRpcClient("fake", config, _http, _logger);

        Assert.Equal(2, (await client.ListToolsAsync()).Count);
        Assert.Equal(0, server.AuthFailCount);
    }
}
