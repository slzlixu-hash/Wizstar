namespace Wizstar.Mcp;

/// <summary>
/// 对账循环（即插即用 Step 1 运行时同步 / Reconciliation）：
///  ① 读声明清单与运行状态对比；
///  ② 新配置自动补齐状态槽并握手（initialize + tools/list 刷工具缓存）；
///  ③ 清单中移除的只停用不删数据；
///  ④ 配置指纹变化的服务重新握手。
/// 只补缺、不覆盖用户运行状态；启动时与前端「刷新插件」时各跑一次。
/// </summary>
public sealed class McpReconciler(McpCatalog catalog, ILogger<McpReconciler> logger)
{
    /// <param name="ct">取消令牌。</param>
    /// <param name="handshake">
    /// 是否对新增 / 变更服务执行握手。<c>false</c> 时仅登记清单、不建立连接，
    /// 用于「启动自动握手 MCP 服务」开关关闭的场景（界面仍能看到已登记服务）。
    /// </param>
    public async Task<McpReconcileSummary> ReconcileAsync(CancellationToken ct = default, bool handshake = true)
    {
        catalog.ReloadIfChanged();

        var notes = new List<string>();
        var added = 0;
        var refreshed = 0;
        var removed = 0;
        var failed = 0;

        // ① 新增 / 指纹变化 → 握手补齐
        foreach (var id in catalog.ConfiguredIds)
        {
            var config = catalog.GetConfig(id)!;
            var state = catalog.GetOrAddState(config);

            var isNew = state.State == McpServiceState.Connecting && state.ConnectedAt is null;
            var fingerprintChanged = !string.Equals(state.ConfigFingerprint, config.Fingerprint(), StringComparison.Ordinal)
                                     && state.ConnectedAt is not null;

            if (!isNew && !fingerprintChanged)
            {
                continue;
            }

            // 全局总闸：toggle.auto-handshake。关闭时一律不握手，仅登记清单。
            if (!handshake)
            {
                if (isNew) catalog.SetOffline(id, "全局自动握手已关闭，可手动连接");
                notes.Add($"服务 {id} 已登记，全局自动握手已关闭");
                continue;
            }

            // 服务级开关：autoStart。只在「首次登记」时生效——
            // 配置指纹变化说明该服务此前已连过，属运行期重配，不受 autoStart 约束，
            // 否则手动连上的服务会在下一次对账时被误踢下线。
            if (isNew && !config.AutoStart)
            {
                catalog.SetOffline(id, "未开启启动时自动握手，可手动连接");
                notes.Add($"服务 {id} 已登记，未开启启动时自动握手");
                continue;
            }

            if (await HandshakeAsync(id, ct).ConfigureAwait(false))
            {
                if (isNew)
                {
                    added++;
                    notes.Add($"新增服务 {id} 已接入并拉取工具");
                }
                else
                {
                    refreshed++;
                    notes.Add($"服务 {id} 配置已变更，重新握手完成");
                }
            }
            else
            {
                failed++;
                var error = catalog.GetState(id)?.LastError ?? "握手失败";
                notes.Add($"服务 {id} 握手失败：{error}");
            }
        }

        // ② 清单中已移除的服务 → 停用（不删数据）
        var configured = catalog.ConfiguredIds.ToHashSet(StringComparer.Ordinal);
        foreach (var snapshot in catalog.ListSnapshots())
        {
            if (!configured.Contains(snapshot.Id) && snapshot.State != McpServiceState.Disabled)
            {
                catalog.MarkRemoved(snapshot.Id);
                removed++;
                notes.Add($"服务 {snapshot.Id} 已从清单移除并停用");
            }
        }

        var summary = new McpReconcileSummary(added, refreshed, removed, failed, notes);
        logger.LogInformation("MCP 对账完成: added={Added} refreshed={Refreshed} removed={Removed} failed={Failed}",
            added, refreshed, removed, failed);
        return summary;
    }

    /// <summary>握手 + tools/list（超时受控，失败置 Error 不抛出）。</summary>
    public async Task<bool> HandshakeAsync(string id, CancellationToken ct = default)
    {
        var config = catalog.GetConfig(id);
        if (config is null)
        {
            return false;
        }

        // 管理界面新建的服务还没有状态槽（未经对账循环）：先补缺，否则
        // SetConnected / SetError 会静默丢状态，快照查不到该服务。
        catalog.GetOrAddState(config);

        if (!string.Equals(config.Transport, "http", StringComparison.OrdinalIgnoreCase))
        {
            catalog.SetError(id, $"transport={config.Transport}：stdio 托管启动本期未实现，仅支持 http");
            return false;
        }

        var client = catalog.CreateClient(id);
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));

            var (serverName, serverVersion, protocolVersion) = await client.ConnectAsync(timeout.Token).ConfigureAwait(false);
            var tools = await client.ListToolsAsync(timeout.Token).ConfigureAwait(false);
            catalog.SetConnected(id, serverName, serverVersion, protocolVersion, tools);
            return true;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            catalog.SetError(id, "握手超时（10 秒）");
            return false;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            catalog.SetError(id, ex.Message);
            logger.LogWarning(ex, "MCP 握手失败: server={Id}", id);
            return false;
        }
    }
}
