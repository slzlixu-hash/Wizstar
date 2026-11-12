namespace Wizstar.Mcp;

/// <summary>
/// MCP 服务健康心跳（规范：即插即用 Step 2 生命周期 / 容错）：
///  - 后台轻量轮询 GET /healthz（2 秒超时），挂掉自动变 Offline，不阻塞主系统；
///  - 恢复时自动重新握手（initialize + tools/list）把工具缓存补回来；
///  - 清单文件变更自动重载（声明式清单热更新）。
/// </summary>
public sealed class McpHealthMonitor(
    McpCatalog catalog,
    McpReconciler reconciler,
    IConfiguration configuration,
    ILogger<McpHealthMonitor> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var intervalSeconds = Math.Clamp(configuration.GetValue("Mcp:HealthIntervalSeconds", 15), 5, 300);
        logger.LogInformation("MCP 健康心跳启动: 间隔 {Interval}s", intervalSeconds);

        // 启动即先跑一轮，不等第一个周期；失败不拖垮宿主（下个周期继续）
        try
        {
            await ProbeAllAsync(stoppingToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "MCP 启动健康探测失败（下个周期继续）");
        }

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(intervalSeconds));
        while (!stoppingToken.IsCancellationRequested
               && await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
        {
            try
            {
                await ProbeAllAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "健康心跳周期异常（下个周期继续）");
            }
        }
    }

    private async Task ProbeAllAsync(CancellationToken ct)
    {
        catalog.ReloadIfChanged();

        foreach (var snapshot in catalog.ListSnapshots())
        {
            if (!McpServiceState.IsActive(snapshot.State))
            {
                continue; // disabled 不参与探测
            }

            if (!string.Equals(snapshot.Transport, "http", StringComparison.OrdinalIgnoreCase))
            {
                continue; // stdio 本期未实现托管
            }

            var config = catalog.GetConfig(snapshot.Id);
            if (config is null)
            {
                continue;
            }

            var client = catalog.CreateClient(snapshot.Id);
            var healthy = await client.HealthProbeAsync(ct).ConfigureAwait(false);

            if (healthy)
            {
                if (snapshot.State != McpServiceState.Connected || snapshot.ToolCount == 0)
                {
                    // 恢复 / 首次接入：重新握手补工具缓存
                    var ok = await reconciler.HandshakeAsync(snapshot.Id, ct).ConfigureAwait(false);
                    logger.LogInformation("MCP 服务恢复并重新握手: {Id} 成功={Ok}", snapshot.Id, ok);
                }
            }
            else if (snapshot.State == McpServiceState.Connected || snapshot.State == McpServiceState.Connecting)
            {
                catalog.SetOffline(snapshot.Id, "健康探测失败（/healthz 不可达）");
                logger.LogWarning("MCP 服务离线: {Id}（工具已从装配中剔除，恢复后自动补回）", snapshot.Id);
            }
        }
    }
}
