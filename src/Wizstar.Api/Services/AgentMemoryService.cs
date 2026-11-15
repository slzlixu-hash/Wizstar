using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SqlSugar;
using Wizstar.Agents.Profiles;
using Wizstar.Agents.Runtime;
using Wizstar.Contracts;
using Wizstar.Data.Entities;
using Wizstar.Data.Entities.Business;

namespace Wizstar.Api.Services;

/// <summary>
/// 数据库版 Agent 上下文提供者：按 agent_key 读取长期记忆 + 知识库 + 上下文设置，
/// 按字符上限拼装后注入；每次运行后写一条快照（注入了哪些 id、多少字、是否截断）。
/// </summary>
public sealed class DbAgentContextProvider(ISqlSugarClient db, ILogger<DbAgentContextProvider> logger)
    : IAgentContextProvider
{
    public const int DefaultMaxMemoryChars = 4000;
    public const int DefaultMaxKnowledgeChars = 4000;

    public Task<AgentContextBlock> BuildAsync(
        string agentKey,
        string conversationId,
        IReadOnlyList<string>? tags,
        CancellationToken cancellationToken)
    {
        var settings = LoadSettings(agentKey);
        var now = DateTime.Now;
        var scopeTags = (tags ?? [])
            .SelectMany(MemoryTagFilter.Split)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        // 自己名下的规则 + 被同步到当前 Agent 的规则；按标签 / 有效期 / 状态过滤
        var memories = db.Queryable<AgentMemory>()
            .ToList()
            .Where(m => string.Equals(m.AgentKey, agentKey, StringComparison.OrdinalIgnoreCase)
                || MemoryTagFilter.SharedWith(m.SyncAgentKeys, agentKey))
            .Where(m => AgentContextComposer.IsInjectableStatus(m.Status))
            .Where(m => !MemoryTagFilter.IsExpired(m.ExpiresAt, now))
            .Where(m => MemoryTagFilter.MatchesTags(scopeTags, m.Tags))
            .OrderByDescending(m => m.Confidence)
            .ThenByDescending(m => m.UpdatedAt)
            .Select(m => new AgentContextComposer.MemoryFact(
                m.Id, m.Subject ?? string.Empty, m.Metric, m.ValueText ?? string.Empty,
                m.Confidence, m.Status ?? "pending", m.UpdatedAt))
            .ToList();

        var docs = db.Queryable<AgentKnowledgeItem>()
            .Where(k => k.AgentKey == agentKey)
            .ToList()
            .Where(k => k.Enabled != false)
            .OrderByDescending(k => k.UpdatedAt)
            .Select(k => new AgentContextComposer.KnowledgeDoc(
                k.Id, k.Title ?? string.Empty, k.Tags, k.Content ?? string.Empty, k.UpdatedAt))
            .ToList();

        var block = AgentContextComposer.Compose(
            memories, docs, settings.MaxMemoryChars, settings.MaxKnowledgeChars);

        RecordHits(block.MemoryIds);

        logger.LogDebug(
            "Agent 上下文: agent={Agent} conv={Conv} tags={Tags} memory={Memory} knowledge={Knowledge} chars={Chars} truncated={Truncated}",
            agentKey, conversationId, string.Join(",", scopeTags),
            block.MemoryIds.Count, block.KnowledgeIds.Count, block.TotalChars, block.Truncated);

        return Task.FromResult(block);
    }

    /// <summary>被真正装配进 System Prompt 的规则才计命中，预览/列表不计。</summary>
    private void RecordHits(IReadOnlyList<long> ids)
    {
        if (ids.Count == 0)
        {
            return;
        }
        try
        {
            var list = string.Join(",", ids.Select(id => id.ToString()));
            db.Ado.ExecuteCommand(
                $"UPDATE agent_memory SET hit_count = COALESCE(hit_count, 0) + 1 WHERE id IN ({list})");
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "记忆命中计数更新失败（不阻断对话）");
        }
    }

    public Task RecordAsync(string agentKey, string conversationId, AgentContextBlock block, CancellationToken cancellationToken)
    {
        db.Insertable(new AgentContextSnapshot
        {
            AgentKey = agentKey,
            SessionId = conversationId,
            InjectedMemoryIds = JsonSerializer.Serialize(block.MemoryIds),
            InjectedKnowledgeIds = JsonSerializer.Serialize(block.KnowledgeIds),
            TotalChars = block.TotalChars,
            Truncated = block.Truncated,
            CreatedAt = DateTime.Now,
        }).ExecuteCommand();
        return Task.CompletedTask;
    }

    private AgentContextSetting LoadSettings(string agentKey)
    {
        var existing = db.Queryable<AgentContextSetting>().First(s => s.AgentKey == agentKey);
        if (existing is not null)
        {
            return existing;
        }

        var created = new AgentContextSetting
        {
            AgentKey = agentKey,
            MaxMemoryChars = DefaultMaxMemoryChars,
            MaxKnowledgeChars = DefaultMaxKnowledgeChars,
            EnableL1Extraction = true,
            UpdatedAt = DateTime.Now,
        };
        try
        {
            db.Insertable(created).ExecuteCommand();
        }
        catch (Exception ex)
        {
            // 并发插入撞主键：读回既有行即可
            logger.LogDebug(ex, "Agent 上下文设置初始化冲突，回读既有配置: {Agent}", agentKey);
            return db.Queryable<AgentContextSetting>().First(s => s.AgentKey == agentKey) ?? created;
        }
        return created;
    }
}

/// <summary>
/// Agent 记忆 / 知识库 / 上下文设置的读写服务（供管理端点使用）。
/// 记忆删除采用软删（status=deleted），保留审计痕迹。
/// </summary>
public sealed class AgentMemoryService(
    ISqlSugarClient db,
    AgentCatalog catalog,
    ILogger<AgentMemoryService> logger)
{
    public sealed record MemoryConflictView(long Id, string Subject, string? Metric, string ValueText);

    public sealed record MemoryView(
        long Id, string Subject, string? Metric, string ValueText,
        decimal Confidence, string Status, string SourceType, string? VerifiedBy,
        DateTime UpdatedAt, string? Tags, DateTime? ExpiresAt, int HitCount,
        int? SampleCount, IReadOnlyList<string> SyncAgentKeys, string? SourceRef,
        MemoryConflictView? Conflict);

    public sealed record KnowledgeView(
        long Id, string Title, string? Tags, string Content, DateTime UpdatedAt, bool Enabled, int Chars);

    public sealed record SettingsView(int MaxMemoryChars, int MaxKnowledgeChars, bool EnableL1Extraction, DateTime UpdatedAt);

    public sealed record SnapshotView(int TotalChars, bool Truncated, int MemoryCount, int KnowledgeCount, DateTime CreatedAt);

    public sealed record MemoryBundle(
        IReadOnlyList<MemoryView> Memories,
        IReadOnlyList<KnowledgeView> Knowledge,
        SettingsView Settings,
        SnapshotView? LastSnapshot);

    public sealed record MemoryConfirmResult(MemoryView Memory, IReadOnlyList<long> ArchivedRuleIds);

    public sealed record MemoryLearnSource(string Source, int Count);

    public sealed record MemoryLearnResult(
        int Scanned, int Added, IReadOnlyList<MemoryView> Candidates, IReadOnlyList<MemoryLearnSource> Sources);

    public sealed record PreviewRule(
        long Id, string Subject, string? Metric, string ValueText,
        string? Tags, int HitCount, DateTime? ExpiresAt);

    public sealed record MemoryPreview(
        IReadOnlyList<PreviewRule> Rules,
        string LayerText,
        int MemoryChars,
        int MaxMemoryChars,
        int KnowledgeChars,
        int MaxKnowledgeChars,
        int TotalChars,
        bool Truncated,
        IReadOnlyList<string> Tags);

    public sealed record MemoryChannelOption(string Code, string Label);

    public sealed record MemoryScopes(
        IReadOnlyList<string> Categories,
        IReadOnlyList<MemoryChannelOption> Channels,
        IReadOnlyList<string> Tags);

    public sealed record TeamMemoryView(
        long Id, string AgentKey, string AgentName, string Subject, string? Metric,
        string ValueText, string? Tags, string Status,
        IReadOnlyList<string> SyncAgentKeys, DateTime UpdatedAt,
        int HitCount, string SourceType, string? SourceRef, DateTime? ExpiresAt);

    public sealed record TeamOverviewItem(
        string AgentKey, string AgentName, int SharedRules, int TotalRules, int HitCount, int Coverage);

    public MemoryBundle GetBundle(string agentKey)
    {
        RequireAgent(agentKey);
        var settings = db.Queryable<AgentContextSetting>().First(s => s.AgentKey == agentKey);
        var all = db.Queryable<AgentMemory>()
            .Where(m => m.AgentKey == agentKey)
            .ToList();
        var now = DateTime.Now;
        var active = all
            .Where(m => AgentContextComposer.IsInjectableStatus(m.Status))
            .Where(m => !MemoryTagFilter.IsExpired(m.ExpiresAt, now))
            .ToList();

        // 待确认规则排最前；归档/驳回记录保留在表里（状态筛选可见）
        var memories = all
            .Where(m => !string.Equals(m.Status, "deleted", StringComparison.OrdinalIgnoreCase))
            .OrderBy(m => string.Equals(m.Status, "pending", StringComparison.OrdinalIgnoreCase) ? 0 : 1)
            .ThenByDescending(m => m.UpdatedAt)
            .Select(m => ToView(m, ConflictFor(m, active)))
            .ToList();

        var knowledge = db.Queryable<AgentKnowledgeItem>()
            .Where(k => k.AgentKey == agentKey)
            .ToList()
            .OrderByDescending(k => k.UpdatedAt)
            .Select(k => new KnowledgeView(
                k.Id, k.Title ?? string.Empty, k.Tags, k.Content ?? string.Empty,
                k.UpdatedAt, k.Enabled != false, (k.Content ?? string.Empty).Length))
            .ToList();

        var snapshot = db.Queryable<AgentContextSnapshot>()
            .Where(s => s.AgentKey == agentKey)
            .OrderByDescending(s => s.Id)
            .First();

        return new MemoryBundle(
            memories,
            knowledge,
            new SettingsView(
                settings?.MaxMemoryChars ?? DbAgentContextProvider.DefaultMaxMemoryChars,
                settings?.MaxKnowledgeChars ?? DbAgentContextProvider.DefaultMaxKnowledgeChars,
                settings?.EnableL1Extraction ?? true,
                settings?.UpdatedAt ?? DateTime.MinValue),
            snapshot is null
                ? null
                : new SnapshotView(
                    snapshot.TotalChars, snapshot.Truncated,
                    CountIds(snapshot.InjectedMemoryIds), CountIds(snapshot.InjectedKnowledgeIds),
                    snapshot.CreatedAt));
    }

    public long AddMemory(
        string agentKey,
        string subject,
        string? metric,
        string valueText,
        decimal? confidence,
        string? actor,
        string? tags = null,
        DateTime? expiresAt = null,
        IReadOnlyList<string>? syncAgentKeys = null,
        bool confirmed = true)
    {
        RequireAgent(agentKey);
        if (string.IsNullOrWhiteSpace(subject))
        {
            throw ApiException.Validation("记忆主题 subject 不能为空");
        }
        if (string.IsNullOrWhiteSpace(valueText))
        {
            throw ApiException.Validation("记忆内容 valueText 不能为空");
        }

        var now = DateTime.Now;
        // 人工新增且直接确认时，同主题旧规则自动归档，避免双阈值同时注入
        if (confirmed)
        {
            var activeConflict = db.Queryable<AgentMemory>()
                .Where(m => m.AgentKey == agentKey)
                .ToList()
                .Where(m => AgentContextComposer.IsInjectableStatus(m.Status))
                .Where(m => !MemoryTagFilter.IsExpired(m.ExpiresAt, now))
                .Where(m => SubjectKey(m.Subject) == SubjectKey(subject))
                .OrderByDescending(m => m.UpdatedAt)
                .FirstOrDefault();
            if (activeConflict is not null)
            {
                db.Updateable<AgentMemory>()
                    .SetColumns(m => m.Status == "archived")
                    .SetColumns(m => m.UpdatedAt == now)
                    .Where(m => m.Id == activeConflict.Id)
                    .ExecuteCommand();
                logger.LogInformation("手动新增记忆自动归档同主题旧规则: agent={Agent} old={Old} subject={Subject}",
                    agentKey, activeConflict.Id, subject);
            }
        }

        var sync = NormalizeSyncKeys(agentKey, syncAgentKeys);
        var entity = new AgentMemory
        {
            AgentKey = agentKey,
            Subject = subject.Trim(),
            Metric = string.IsNullOrWhiteSpace(metric) ? null : metric.Trim(),
            ValueText = valueText.Trim(),
            Confidence = Math.Clamp(confidence ?? 1.0m, 0m, 1m),
            Status = confirmed ? "verified" : "pending",
            SourceType = "manual",
            VerifiedBy = confirmed && !string.IsNullOrWhiteSpace(actor) ? actor : null,
            VerifiedAt = confirmed ? now : null,
            Tags = NormalizeTags(tags),
            ExpiresAt = expiresAt?.ToLocalTime(),
            HitCount = 0,
            SyncAgentKeys = sync.Count == 0 ? null : string.Join(",", sync),
            CreatedAt = now,
            UpdatedAt = now,
        };
        var id = db.Insertable(entity).ExecuteReturnBigIdentity();
        logger.LogInformation("新增 Agent 记忆: agent={Agent} id={Id} subject={Subject} tags={Tags} confirmed={Confirmed}",
            agentKey, id, entity.Subject, entity.Tags, confirmed);
        return id;
    }

    /// <summary>编辑已有记忆规则（含人工确认 / 转待确认、同步范围、有效期）。</summary>
    public bool UpdateMemory(
        string agentKey,
        long id,
        string? subject,
        string? metric,
        string? valueText,
        decimal? confidence,
        string? tags,
        DateTime? expiresAt,
        IReadOnlyList<string>? syncAgentKeys,
        bool? confirmed,
        string? actor)
    {
        RequireAgent(agentKey);
        var row = db.Queryable<AgentMemory>().First(m => m.Id == id && m.AgentKey == agentKey);
        if (row is null)
        {
            return false;
        }
        if (string.IsNullOrWhiteSpace(subject) || string.IsNullOrWhiteSpace(valueText))
        {
            throw ApiException.Validation("记忆主题与内容不能为空");
        }

        var now = DateTime.Now;
        var verified = confirmed ?? string.Equals(row.Status, "verified", StringComparison.OrdinalIgnoreCase);
        if (verified)
        {
            var conflict = db.Queryable<AgentMemory>()
                .Where(m => m.AgentKey == agentKey)
                .ToList()
                .Where(m => m.Id != id && AgentContextComposer.IsInjectableStatus(m.Status))
                .Where(m => !MemoryTagFilter.IsExpired(m.ExpiresAt, now))
                .Where(m => SubjectKey(m.Subject) == SubjectKey(subject))
                .OrderByDescending(m => m.UpdatedAt)
                .FirstOrDefault();
            if (conflict is not null)
            {
                db.Updateable<AgentMemory>()
                    .SetColumns(m => m.Status == "archived")
                    .SetColumns(m => m.UpdatedAt == now)
                    .Where(m => m.Id == conflict.Id)
                    .ExecuteCommand();
            }
        }

        var sync = NormalizeSyncKeys(agentKey, syncAgentKeys);
        var verifier = verified && !string.IsNullOrWhiteSpace(actor) ? actor : null;
        var cleanSubject = subject!.Trim();
        var cleanMetric = string.IsNullOrWhiteSpace(metric) ? null : metric!.Trim();
        var cleanValue = valueText!.Trim();
        var finalConfidence = Math.Clamp(confidence ?? row.Confidence, 0m, 1m);
        var finalExpiry = expiresAt?.ToLocalTime();
        var verifiedAt = verified ? now : (DateTime?)null;
        db.Updateable<AgentMemory>()
            .SetColumns(m => m.Subject == cleanSubject)
            .SetColumns(m => m.Metric == cleanMetric)
            .SetColumns(m => m.ValueText == cleanValue)
            .SetColumns(m => m.Confidence == finalConfidence)
            .SetColumns(m => m.Status == (verified ? "verified" : "pending"))
            .SetColumns(m => m.VerifiedBy == verifier)
            .SetColumns(m => m.VerifiedAt == verifiedAt)
            .SetColumns(m => m.Tags == NormalizeTags(tags))
            .SetColumns(m => m.ExpiresAt == finalExpiry)
            .SetColumns(m => m.SyncAgentKeys == (sync.Count == 0 ? null : string.Join(",", sync)))
            .SetColumns(m => m.UpdatedAt == now)
            .Where(m => m.Id == id && m.AgentKey == agentKey)
            .ExecuteCommand();
        return true;
    }

    public bool DeleteMemory(string agentKey, long id)
    {
        RequireAgent(agentKey);
        var affected = db.Updateable<AgentMemory>()
            .SetColumns(m => m.Status == "deleted")
            .SetColumns(m => m.UpdatedAt == DateTime.Now)
            .Where(m => m.Id == id && m.AgentKey == agentKey)
            .ExecuteCommand();
        return affected > 0;
    }

    /// <summary>确认候选规则；replace=true 时自动归档同主题的旧生效规则，避免两条矛盾阈值同时注入。</summary>
    public MemoryConfirmResult ConfirmMemory(
        string agentKey, long id, bool replace, IReadOnlyList<string>? syncAgentKeys, string? actor)
    {
        RequireAgent(agentKey);
        var row = db.Queryable<AgentMemory>().First(m => m.Id == id && m.AgentKey == agentKey);
        if (row is null)
        {
            throw ApiException.Validation($"记忆不存在: {id}");
        }
        if (!string.Equals(row.Status, "pending", StringComparison.OrdinalIgnoreCase))
        {
            throw ApiException.Validation("只有待确认的候选规则可以确认");
        }

        var now = DateTime.Now;
        var active = db.Queryable<AgentMemory>()
            .Where(m => m.AgentKey == agentKey)
            .ToList()
            .Where(m => AgentContextComposer.IsInjectableStatus(m.Status))
            .Where(m => !MemoryTagFilter.IsExpired(m.ExpiresAt, now))
            .ToList();
        var conflict = ConflictFor(row, active);
        if (conflict is not null && !replace)
        {
            throw ApiException.Validation(
                $"存在冲突规则 #{conflict.Id}（{conflict.Subject}），请选择「确认并替换」或先归档旧规则");
        }

        var archived = new List<long>();
        if (conflict is not null)
        {
            db.Updateable<AgentMemory>()
                .SetColumns(m => m.Status == "archived")
                .SetColumns(m => m.UpdatedAt == now)
                .Where(m => m.Id == conflict.Id && m.AgentKey == agentKey)
                .ExecuteCommand();
            archived.Add(conflict.Id);
        }

        var sync = syncAgentKeys is null
            ? SplitSyncKeys(row.SyncAgentKeys)
            : NormalizeSyncKeys(agentKey, syncAgentKeys);
        var verifier = string.IsNullOrWhiteSpace(actor) ? null : actor;
        var syncText = sync.Count == 0 ? null : string.Join(",", sync);

        db.Updateable<AgentMemory>()
            .SetColumns(m => m.Status == "verified")
            .SetColumns(m => m.VerifiedBy == verifier)
            .SetColumns(m => m.VerifiedAt == now)
            .SetColumns(m => m.SyncAgentKeys == syncText)
            .SetColumns(m => m.Tags == NormalizeTags(row.Tags))
            .SetColumns(m => m.UpdatedAt == now)
            .Where(m => m.Id == id && m.AgentKey == agentKey)
            .ExecuteCommand();

        row.Status = "verified";
        row.VerifiedBy = verifier;
        row.VerifiedAt = now;
        row.SyncAgentKeys = syncText;
        row.Tags = NormalizeTags(row.Tags);
        row.UpdatedAt = now;

        logger.LogInformation(
            "确认记忆规则: agent={Agent} id={Id} replaced={Replaced} sync={Sync}",
            agentKey, id, string.Join(",", archived), syncText ?? "-");
        return new MemoryConfirmResult(ToView(row, null), archived);
    }

    public bool RejectMemory(string agentKey, long id)
    {
        RequireAgent(agentKey);
        return db.Updateable<AgentMemory>()
            .SetColumns(m => m.Status == "rejected")
            .SetColumns(m => m.UpdatedAt == DateTime.Now)
            .Where(m => m.Id == id && m.AgentKey == agentKey)
            .ExecuteCommand() > 0;
    }

    public bool ArchiveMemory(string agentKey, long id)
    {
        RequireAgent(agentKey);
        return db.Updateable<AgentMemory>()
            .SetColumns(m => m.Status == "archived")
            .SetColumns(m => m.UpdatedAt == DateTime.Now)
            .Where(m => m.Id == id && m.AgentKey == agentKey)
            .ExecuteCommand() > 0;
    }

    /// <summary>
    /// 自学习：扫描近 7 天人工驳回、微信小店审核驳回、高退货率商品，归纳 0~5 条待确认候选规则。
    /// 不编造：没有证据就不产出；同一 SourceRef 已存在（含已驳回）时不重复打扰。
    /// </summary>
    public MemoryLearnResult Learn(string agentKey, string? actor)
    {
        RequireAgent(agentKey);
        var now = DateTime.Now;
        var cutoff = now.AddDays(-7);
        var drafts = new List<CandidateDraft>();
        var sources = new List<MemoryLearnSource>();
        var scanned = 0;

        try
        {
            var rejects = db.Queryable<ApprovalRecord>()
                .Where(a => a.Status == 2 && a.DecidedAtUtc != null && a.DecidedAtUtc >= cutoff.ToUniversalTime())
                .ToList();
            scanned += rejects.Count;
            sources.Add(new MemoryLearnSource("人工驳回", rejects.Count));
            foreach (var group in rejects.GroupBy(a => (a.AgentKey, a.ToolName)))
            {
                if (string.IsNullOrWhiteSpace(group.Key.ToolName)) continue;
                var count = group.Count();
                var agentLabel = LabelOf(group.Key.AgentKey);
                var tool = Trim(group.Key.ToolName, 80);
                drafts.Add(new CandidateDraft(
                    $"写入审批 · {tool}",
                    $"近 7 天驳回 {count} 次",
                    $"近 7 天「{tool}」在 {agentLabel} 执行时被人工驳回 {count} 次；再次执行前必须补齐价格/资质/素材依据，并重新走人工审批，禁止自动重试。",
                    "#全局",
                    BuildSourceRef("approval", $"{group.Key.AgentKey}|{group.Key.ToolName}"),
                    count,
                    group.Key.AgentKey == agentKey ? [] : [group.Key.AgentKey],
                    0.72m));
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "自学习扫描人工驳回失败: agent={Agent}", agentKey);
        }

        try
        {
            var listings = db.Queryable<SkuChannelListing>()
                .ToList()
                .Where(l => IsWechatPlatform(l.Platform) && !string.IsNullOrWhiteSpace(l.AuditRejectReason))
                .Where(l => (l.LastSyncAt ?? l.PublishedAt ?? now) >= cutoff)
                .ToList();
            scanned += listings.Count;
            sources.Add(new MemoryLearnSource("微信小店审核", listings.Count));
            foreach (var group in listings.GroupBy(l => (l.AuditRejectReason ?? string.Empty).Trim()))
            {
                var reason = Trim(group.Key, 100);
                if (reason.Length == 0) continue;
                var count = group.Count();
                drafts.Add(new CandidateDraft(
                    "微信小店 · 审核驳回 · " + Trim(reason, 40),
                    reason,
                    $"近 7 天微信小店审核驳回「{reason}」{count} 次；上架前按该原因自检标题/资质/图片，命中则修改后重新提交。",
                    "#全局 #微信小店",
                    BuildSourceRef("wechat-audit", group.Key),
                    count,
                    catalog.Find("publisher") is null ? [] : ["publisher"],
                    0.75m));
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "自学习扫描微信小店审核失败: agent={Agent}", agentKey);
        }

        try
        {
            var orders = db.Queryable<EcomOrder>()
                .ToList()
                .Where(o => (o.PaidAt ?? o.CreatedAt) >= cutoff)
                .ToList();
            scanned += orders.Count;
            sources.Add(new MemoryLearnSource("订单退货", orders.Count));
            if (orders.Count >= 3)
            {
                var orderById = orders.ToDictionary(o => o.Id);
                var projects = db.Queryable<SkuProject>().ToList().ToDictionary(p => p.Id);
                var items = db.Queryable<EcomOrderItem>()
                    .Where(i => i.ProjectId != null)
                    .ToList()
                    .Where(i => orderById.ContainsKey(i.OrderId))
                    .ToList();

                var stats = items
                    .GroupBy(i => i.ProjectId!.Value)
                    .Select(g =>
                    {
                        var orderIds = g.Select(i => i.OrderId).Distinct().ToList();
                        var returns = orderIds.Count(id =>
                            !string.IsNullOrWhiteSpace(orderById[id].AftersaleStatus)
                            && !string.Equals(orderById[id].AftersaleStatus, "none", StringComparison.OrdinalIgnoreCase));
                        return new { ProjectId = g.Key, Orders = orderIds.Count, Returns = returns };
                    })
                    .Where(s => s.Orders >= 3 && s.Returns / (double)s.Orders >= 0.25)
                    .OrderByDescending(s => s.Returns / (double)s.Orders)
                    .Take(2)
                    .ToList();

                foreach (var stat in stats)
                {
                    if (!projects.TryGetValue(stat.ProjectId, out var project)) continue;
                    var rate = stat.Returns / (double)stat.Orders;
                    var category = (project.CategoryName ?? string.Empty).Trim();
                    var categoryTag = string.IsNullOrWhiteSpace(category)
                        ? string.Empty
                        : " #" + MemoryTagFilter.Split(category).FirstOrDefault()!;
                    drafts.Add(new CandidateDraft(
                        "选品 · 高退货率特征" + (category.Length == 0 ? string.Empty : " · " + category),
                        $"{project.Title} 退货率 {rate:P0}",
                        $"「{project.Title}」近 7 天退货率 {rate:P0}（{stat.Returns}/{stat.Orders} 单）；同类目选品需排查尺码/材质/描述不符风险，退货率超 25% 不立项。",
                        ("#全局 #高退货" + categoryTag).Trim(),
                        BuildSourceRef("return-rate", project.ProjectNo),
                        stat.Orders,
                        new[] { "scout", "publisher" }.Where(k => catalog.Find(k) is not null).ToList(),
                        0.68m));
                }
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "自学习扫描退货率失败: agent={Agent}", agentKey);
        }

        var existing = db.Queryable<AgentMemory>()
            .Where(m => m.AgentKey == agentKey)
            .ToList()
            .Where(m => !string.Equals(m.Status, "deleted", StringComparison.OrdinalIgnoreCase))
            .Select(m => m.SourceRef)
            .Where(r => !string.IsNullOrWhiteSpace(r))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var addedIds = new List<long>();
        foreach (var draft in drafts
                     .OrderByDescending(d => d.SampleCount)
                     .ThenByDescending(d => d.Confidence)
                     .Take(5))
        {
            if (string.IsNullOrWhiteSpace(draft.SourceRef) || existing.Contains(draft.SourceRef))
            {
                continue;
            }
            var entity = new AgentMemory
            {
                AgentKey = agentKey,
                Subject = draft.Subject,
                Metric = draft.Metric,
                ValueText = draft.ValueText,
                Confidence = draft.Confidence,
                Status = "pending",
                SourceType = "selflearn",
                SourceRef = draft.SourceRef,
                Tags = NormalizeTags(draft.Tags),
                ExpiresAt = now.AddDays(90),
                HitCount = 0,
                SampleCount = draft.SampleCount,
                SyncAgentKeys = draft.SyncAgentKeys.Count == 0 ? null : string.Join(",", draft.SyncAgentKeys),
                CreatedAt = now,
                UpdatedAt = now,
            };
            var id = db.Insertable(entity).ExecuteReturnBigIdentity();
            addedIds.Add(id);
            existing.Add(draft.SourceRef);
        }

        var bundle = GetBundle(agentKey);
        var candidates = bundle.Memories.Where(m => addedIds.Contains(m.Id)).ToList();
        logger.LogInformation("自学习完成: agent={Agent} scanned={Scanned} added={Added} actor={Actor}",
            agentKey, scanned, addedIds.Count, actor ?? "-");
        return new MemoryLearnResult(scanned, addedIds.Count, candidates, sources);
    }

    /// <summary>
    /// 对话未显式带 tags 时，从当前 Agent 已生效规则的标签里做一次轻量命中推断
    /// （例如消息提到「保温杯」→ 命中 #保温杯 规则）。显式 tags 优先，推断仅用于聊天兜底。
    /// </summary>
    public IReadOnlyList<string> InferTagsFromMessage(string agentKey, string? message)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            return [];
        }
        var now = DateTime.Now;
        return db.Queryable<AgentMemory>()
            .ToList()
            .Where(m => string.Equals(m.AgentKey, agentKey, StringComparison.OrdinalIgnoreCase)
                || MemoryTagFilter.SharedWith(m.SyncAgentKeys, agentKey))
            .Where(m => AgentContextComposer.IsInjectableStatus(m.Status))
            .Where(m => !MemoryTagFilter.IsExpired(m.ExpiresAt, now))
            .SelectMany(m => MemoryTagFilter.Split(m.Tags))
            .Where(t => !string.Equals(t, "全局", StringComparison.OrdinalIgnoreCase) && t.Length >= 2)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Where(t => message.Contains(t, StringComparison.OrdinalIgnoreCase))
            .Take(5)
            .ToList();
    }

    /// <summary>按场景标签模拟 System Prompt Layer 3 注入（不写命中计数）。</summary>
    public MemoryPreview Preview(string agentKey, IReadOnlyList<string>? tags)
    {
        RequireAgent(agentKey);
        var settings = db.Queryable<AgentContextSetting>().First(s => s.AgentKey == agentKey);
        var scopeTags = (tags ?? [])
            .SelectMany(MemoryTagFilter.Split)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        var now = DateTime.Now;

        var applicable = db.Queryable<AgentMemory>()
            .ToList()
            .Where(m => string.Equals(m.AgentKey, agentKey, StringComparison.OrdinalIgnoreCase)
                || MemoryTagFilter.SharedWith(m.SyncAgentKeys, agentKey))
            .Where(m => AgentContextComposer.IsInjectableStatus(m.Status))
            .Where(m => !MemoryTagFilter.IsExpired(m.ExpiresAt, now))
            .Where(m => MemoryTagFilter.MatchesTags(scopeTags, m.Tags))
            .OrderByDescending(m => m.Confidence)
            .ThenByDescending(m => m.UpdatedAt)
            .ToList();

        var facts = applicable
            .Select(m => new AgentContextComposer.MemoryFact(
                m.Id, m.Subject ?? string.Empty, m.Metric, m.ValueText ?? string.Empty,
                m.Confidence, m.Status ?? "pending", m.UpdatedAt))
            .ToList();
        var docs = db.Queryable<AgentKnowledgeItem>()
            .Where(k => k.AgentKey == agentKey)
            .ToList()
            .Where(k => k.Enabled != false)
            .OrderByDescending(k => k.UpdatedAt)
            .Select(k => new AgentContextComposer.KnowledgeDoc(
                k.Id, k.Title ?? string.Empty, k.Tags, k.Content ?? string.Empty, k.UpdatedAt))
            .ToList();

        var block = AgentContextComposer.Compose(
            facts, docs,
            settings?.MaxMemoryChars ?? DbAgentContextProvider.DefaultMaxMemoryChars,
            settings?.MaxKnowledgeChars ?? DbAgentContextProvider.DefaultMaxKnowledgeChars);

        var injected = applicable.Where(m => block.MemoryIds.Contains(m.Id)).ToList();
        var rules = injected.Select(m => new PreviewRule(
            m.Id, m.Subject ?? string.Empty, m.Metric, m.ValueText ?? string.Empty,
            NormalizeTags(m.Tags), m.HitCount ?? 0, m.ExpiresAt)).ToList();

        var layer = new System.Text.StringBuilder();
        layer.AppendLine("[Matched Rules] System Prompt Layer 3 (Active)");
        if (scopeTags.Count > 0)
        {
            layer.AppendLine("// Scope: " + string.Join(" ", scopeTags.Select(t => "#" + t)));
        }
        foreach (var rule in rules)
        {
            layer.AppendLine($"- memory#{rule.Id}: {rule.Subject}{(string.IsNullOrWhiteSpace(rule.Metric) ? string.Empty : " · " + rule.Metric)}")
                .AppendLine($"  [{rule.Tags ?? "#全局"}] {Trim(rule.ValueText, 220)}");
        }
        if (rules.Count == 0)
        {
            layer.AppendLine("（当前场景未命中任何规则；#全局 规则会始终注入）");
        }
        if (block.Truncated)
        {
            layer.AppendLine("（已达字符上限，部分规则被截断）");
        }

        return new MemoryPreview(
            rules,
            layer.ToString().TrimEnd(),
            block.MemoryText?.Length ?? 0,
            block.MaxMemoryChars,
            block.KnowledgeText?.Length ?? 0,
            block.MaxKnowledgeChars,
            block.TotalChars,
            block.Truncated,
            scopeTags);
    }

    /// <summary>模拟器可选项：真实任务类目 / 渠道 / 规则标签。</summary>
    public MemoryScopes Scopes(string agentKey)
    {
        RequireAgent(agentKey);
        var projects = db.Queryable<SkuProject>().ToList();
        var listings = db.Queryable<SkuChannelListing>().ToList();
        var orders = db.Queryable<EcomOrder>().ToList();
        var memories = db.Queryable<AgentMemory>()
            .Where(m => m.AgentKey == agentKey)
            .ToList()
            .Where(m => !string.Equals(m.Status, "deleted", StringComparison.OrdinalIgnoreCase))
            .ToList();

        var tags = memories
            .SelectMany(m => MemoryTagFilter.Split(m.Tags))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        var platformCodes = listings.Select(l => l.Platform)
            .Concat(orders.Select(o => o.Platform))
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        var channels = platformCodes
            .Select(code => new MemoryChannelOption(code, PlatformLabel(code)))
            .GroupBy(c => c.Label, StringComparer.OrdinalIgnoreCase)
            .Select(g => g.First())
            .ToList();
        foreach (var (code, label) in PlatformLabels)
        {
            if (tags.Any(t => string.Equals(t, label, StringComparison.OrdinalIgnoreCase))
                && channels.All(c => !string.Equals(c.Label, label, StringComparison.OrdinalIgnoreCase)))
            {
                channels.Add(new MemoryChannelOption(code, label));
            }
        }

        var channelLabels = channels.Select(c => c.Label).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var categories = projects
            .Select(p => (p.CategoryName ?? string.Empty).Trim())
            .Concat(tags.Where(t => !string.Equals(t, "全局", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(t, "高退货", StringComparison.OrdinalIgnoreCase)
                && !channelLabels.Contains(t)))
            .Where(t => t.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(t => t, StringComparer.OrdinalIgnoreCase)
            .ToList();

        return new MemoryScopes(categories, channels, tags);
    }

    /// <summary>团队共享规则：sync_agent_keys 非空且已生效的规则（含归属 Agent）。</summary>
    public IReadOnlyList<TeamMemoryView> TeamMemories(int take)
    {
        var now = DateTime.Now;
        return db.Queryable<AgentMemory>()
            .ToList()
            .Where(m => !string.IsNullOrWhiteSpace(m.SyncAgentKeys))
            .Where(m => AgentContextComposer.IsInjectableStatus(m.Status))
            .Where(m => !MemoryTagFilter.IsExpired(m.ExpiresAt, now))
            .OrderByDescending(m => m.UpdatedAt)
            .Take(Math.Clamp(take, 1, 200))
            .Select(ToTeamView)
            .ToList();
    }

    /// <summary>每个 Agent 对团队共享规则的注入覆盖率（含自己拥有的规则）。</summary>
    public IReadOnlyList<TeamOverviewItem> TeamOverview()
    {
        var rules = TeamMemories(200).ToList();
        return catalog.GetAll()
            .Where(p => p.Enabled)
            .Select(agent =>
            {
                var applicable = rules
                    .Where(r => string.Equals(r.AgentKey, agent.Key, StringComparison.OrdinalIgnoreCase)
                        || r.SyncAgentKeys.Any(k => string.Equals(k, agent.Key, StringComparison.OrdinalIgnoreCase)))
                    .ToList();
                var coverage = rules.Count == 0
                    ? 0
                    : (int)Math.Round(applicable.Count * 100d / rules.Count);
                return new TeamOverviewItem(
                    agent.Key,
                    agent.DisplayName,
                    applicable.Count,
                    rules.Count,
                    applicable.Sum(r => r.HitCount),
                    coverage);
            })
            .ToList();
    }

    /// <summary>一键广播：把当前 Agent 所有生效规则同步给其余全部启用 Agent。</summary>
    public int ShareAllToTeam(string agentKey)
    {
        RequireAgent(agentKey);
        var targets = catalog.GetAll()
            .Where(p => p.Enabled && !string.Equals(p.Key, agentKey, StringComparison.OrdinalIgnoreCase))
            .Select(p => p.Key)
            .ToList();
        if (targets.Count == 0)
        {
            return 0;
        }
        var now = DateTime.Now;
        var rows = db.Queryable<AgentMemory>()
            .Where(m => m.AgentKey == agentKey)
            .ToList()
            .Where(m => AgentContextComposer.IsInjectableStatus(m.Status))
            .Where(m => !MemoryTagFilter.IsExpired(m.ExpiresAt, now))
            .ToList();
        var sync = string.Join(",", targets);
        foreach (var row in rows)
        {
            db.Updateable<AgentMemory>()
                .SetColumns(m => m.SyncAgentKeys == sync)
                .SetColumns(m => m.UpdatedAt == now)
                .Where(m => m.Id == row.Id)
                .ExecuteCommand();
        }
        logger.LogInformation("团队规则广播: agent={Agent} rules={Count} targets={Targets}",
            agentKey, rows.Count, sync);
        return rows.Count;
    }

    /// <summary>下线共享：只清空同步范围，本 Agent 的规则保留。</summary>
    public bool UnshareTeamRule(long id)
    {
        var affected = db.Updateable<AgentMemory>()
            .SetColumns(m => m.SyncAgentKeys == null)
            .SetColumns(m => m.UpdatedAt == DateTime.Now)
            .Where(m => m.Id == id && m.SyncAgentKeys != null)
            .ExecuteCommand();
        return affected > 0;
    }

    /// <summary>编辑共享规则（指挥官可管理任意共享规则）。</summary>
    public TeamMemoryView? UpdateTeamRule(
        long id,
        string? subject,
        string? metric,
        string? valueText,
        string? tags,
        IReadOnlyList<string>? syncAgentKeys,
        DateTime? expiresAt)
    {
        var row = db.Queryable<AgentMemory>().First(m => m.Id == id);
        if (row is null)
        {
            return null;
        }
        if (string.IsNullOrWhiteSpace(subject) || string.IsNullOrWhiteSpace(valueText))
        {
            throw ApiException.Validation("共享规则的主题与内容不能为空");
        }

        var sync = NormalizeSyncKeys(row.AgentKey, syncAgentKeys);
        var now = DateTime.Now;
        var newExpiry = expiresAt?.ToLocalTime() ?? row.ExpiresAt;
        db.Updateable<AgentMemory>()
            .SetColumns(m => m.Subject == subject.Trim())
            .SetColumns(m => m.Metric == (string.IsNullOrWhiteSpace(metric) ? null : metric.Trim()))
            .SetColumns(m => m.ValueText == valueText.Trim())
            .SetColumns(m => m.Tags == NormalizeTags(tags))
            .SetColumns(m => m.SyncAgentKeys == (sync.Count == 0 ? null : string.Join(",", sync)))
            .SetColumns(m => m.ExpiresAt == newExpiry)
            .SetColumns(m => m.UpdatedAt == now)
            .Where(m => m.Id == id)
            .ExecuteCommand();

        row.Subject = subject.Trim();
        row.Metric = string.IsNullOrWhiteSpace(metric) ? null : metric.Trim();
        row.ValueText = valueText.Trim();
        row.Tags = NormalizeTags(tags);
        row.SyncAgentKeys = sync.Count == 0 ? null : string.Join(",", sync);
        if (expiresAt is not null) row.ExpiresAt = expiresAt.Value.ToLocalTime();
        row.UpdatedAt = now;
        return ToTeamView(row);
    }

    private TeamMemoryView ToTeamView(AgentMemory m) => new(
        m.Id,
        m.AgentKey ?? string.Empty,
        LabelOf(m.AgentKey ?? string.Empty),
        m.Subject ?? string.Empty,
        m.Metric,
        m.ValueText ?? string.Empty,
        NormalizeTags(m.Tags),
        m.Status ?? "verified",
        SplitSyncKeys(m.SyncAgentKeys),
        m.UpdatedAt,
        m.HitCount ?? 0,
        m.SourceType ?? "manual",
        m.SourceRef,
        m.ExpiresAt);

    public long AddKnowledge(string agentKey, string title, string? tags, string content)
    {
        RequireAgent(agentKey);
        if (string.IsNullOrWhiteSpace(title))
        {
            throw ApiException.Validation("知识标题 title 不能为空");
        }
        if (string.IsNullOrWhiteSpace(content))
        {
            throw ApiException.Validation("知识内容 content 不能为空");
        }

        var id = db.Insertable(new AgentKnowledgeItem
        {
            AgentKey = agentKey,
            Title = title.Trim(),
            Tags = string.IsNullOrWhiteSpace(tags) ? null : tags.Trim(),
            Content = content.Trim(),
            Enabled = true,
            CreatedAt = DateTime.Now,
            UpdatedAt = DateTime.Now,
        }).ExecuteReturnBigIdentity();
        logger.LogInformation("新增 Agent 知识: agent={Agent} id={Id} title={Title}", agentKey, id, title);
        return id;
    }

    public KnowledgeView? UpdateKnowledge(
        string agentKey, long id, string? title, string? tags, string? content, bool? enabled)
    {
        RequireAgent(agentKey);
        var row = db.Queryable<AgentKnowledgeItem>().First(k => k.Id == id && k.AgentKey == agentKey);
        if (row is null)
        {
            return null;
        }
        if (string.IsNullOrWhiteSpace(title) || string.IsNullOrWhiteSpace(content))
        {
            throw ApiException.Validation("知识标题与正文不能为空");
        }

        var finalEnabled = enabled ?? (row.Enabled != false);
        db.Updateable<AgentKnowledgeItem>()
            .SetColumns(k => k.Title == title.Trim())
            .SetColumns(k => k.Tags == (string.IsNullOrWhiteSpace(tags) ? null : tags.Trim()))
            .SetColumns(k => k.Content == content.Trim())
            .SetColumns(k => k.Enabled == finalEnabled)
            .SetColumns(k => k.UpdatedAt == DateTime.Now)
            .Where(k => k.Id == id && k.AgentKey == agentKey)
            .ExecuteCommand();

        return new KnowledgeView(
            id, title.Trim(), string.IsNullOrWhiteSpace(tags) ? null : tags.Trim(),
            content.Trim(), DateTime.Now, finalEnabled, content.Trim().Length);
    }

    public bool DeleteKnowledge(string agentKey, long id)
    {
        RequireAgent(agentKey);
        return db.Deleteable<AgentKnowledgeItem>()
            .Where(k => k.Id == id && k.AgentKey == agentKey)
            .ExecuteCommand() > 0;
    }

    public SettingsView UpdateSettings(string agentKey, int? maxMemoryChars, int? maxKnowledgeChars, bool? enableL1)
    {
        RequireAgent(agentKey);
        var existing = db.Queryable<AgentContextSetting>().First(s => s.AgentKey == agentKey);
        var memory = Math.Clamp(maxMemoryChars ?? existing?.MaxMemoryChars ?? DbAgentContextProvider.DefaultMaxMemoryChars, 200, 32_000);
        var knowledge = Math.Clamp(maxKnowledgeChars ?? existing?.MaxKnowledgeChars ?? DbAgentContextProvider.DefaultMaxKnowledgeChars, 200, 32_000);
        var l1 = enableL1 ?? existing?.EnableL1Extraction ?? true;

        if (existing is null)
        {
            db.Insertable(new AgentContextSetting
            {
                AgentKey = agentKey,
                MaxMemoryChars = memory,
                MaxKnowledgeChars = knowledge,
                EnableL1Extraction = l1,
                UpdatedAt = DateTime.Now,
            }).ExecuteCommand();
        }
        else
        {
            db.Updateable<AgentContextSetting>()
                .SetColumns(s => s.MaxMemoryChars == memory)
                .SetColumns(s => s.MaxKnowledgeChars == knowledge)
                .SetColumns(s => s.EnableL1Extraction == l1)
                .SetColumns(s => s.UpdatedAt == DateTime.Now)
                .Where(s => s.AgentKey == agentKey)
                .ExecuteCommand();
        }

        return new SettingsView(memory, knowledge, l1, DateTime.Now);
    }

    private void RequireAgent(string agentKey)
    {
        if (catalog.Find(agentKey) is null)
        {
            throw ApiException.Validation($"名册中不存在 Agent: {agentKey}");
        }
    }

    // ---------------------------------------------------------------- 内部映射

    private static readonly Dictionary<string, string> PlatformLabels = new(StringComparer.OrdinalIgnoreCase)
    {
        ["weixin_shop"] = "微信小店",
        ["wechat"] = "微信小店",
        ["douyin"] = "抖音小店",
        ["pinduoduo"] = "拼多多",
        ["taobao"] = "淘宝",
        ["jd"] = "京东",
        ["manual"] = "手工录入",
    };

    private sealed record CandidateDraft(
        string Subject,
        string? Metric,
        string ValueText,
        string Tags,
        string? SourceRef,
        int SampleCount,
        IReadOnlyList<string> SyncAgentKeys,
        decimal Confidence);

    private MemoryView ToView(AgentMemory m, MemoryConflictView? conflict) => new(
        m.Id,
        m.Subject ?? string.Empty,
        m.Metric,
        m.ValueText ?? string.Empty,
        m.Confidence,
        m.Status ?? "pending",
        m.SourceType ?? "manual",
        m.VerifiedBy,
        m.UpdatedAt,
        NormalizeTags(m.Tags),
        m.ExpiresAt,
        m.HitCount ?? 0,
        m.SampleCount,
        SplitSyncKeys(m.SyncAgentKeys),
        m.SourceRef,
        conflict);

    /// <summary>只有待确认规则需要展示冲突；同主题的旧「生效」规则即冲突对象。</summary>
    private static MemoryConflictView? ConflictFor(AgentMemory candidate, IReadOnlyList<AgentMemory> active)
    {
        if (!string.Equals(candidate.Status, "pending", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        var key = SubjectKey(candidate.Subject);
        var old = active
            .Where(a => a.Id != candidate.Id && SubjectKey(a.Subject) == key)
            .OrderByDescending(a => a.UpdatedAt)
            .FirstOrDefault();
        return old is null ? null : new MemoryConflictView(old.Id, old.Subject ?? string.Empty, old.Metric, old.ValueText ?? string.Empty);
    }

    private static string SubjectKey(string? subject) =>
        (subject ?? string.Empty).Trim().ToLowerInvariant().Replace(" ", string.Empty);

    private static string NormalizeTags(string? tags)
    {
        var parts = MemoryTagFilter.Split(tags);
        if (parts.Count == 0)
        {
            return "#全局";
        }
        // #全局 只表示不限 Agent；与具体标签共存时保留具体标签，避免误判为“全部任务”
        var specific = parts
            .Where(t => !string.Equals(t, "全局", StringComparison.OrdinalIgnoreCase))
            .ToList();
        var final = specific.Count > 0 ? specific : parts;
        return string.Join(" ", final.Select(t => t.StartsWith('#') ? t : "#" + t));
    }

    private static IReadOnlyList<string> SplitSyncKeys(string? syncAgentKeys) =>
        (syncAgentKeys ?? string.Empty)
            .Split([',', '，', ';', '；'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

    private IReadOnlyList<string> NormalizeSyncKeys(string owner, IReadOnlyList<string>? keys) =>
        (keys ?? [])
            .Select(k => (k ?? string.Empty).Trim().ToLowerInvariant())
            .Where(k => k.Length > 0
                && !string.Equals(k, owner, StringComparison.OrdinalIgnoreCase)
                && catalog.Find(k) is not null)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

    private string LabelOf(string agentKey) => catalog.Find(agentKey)?.DisplayName ?? agentKey;

    private static string BuildSourceRef(string kind, string key)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(kind + "|" + key));
        return $"selflearn:{kind}:{Convert.ToHexString(hash)[..16].ToLowerInvariant()}";
    }

    private static string Trim(string value, int max) =>
        value.Length <= max ? value : value[..max] + "…";

    private static bool IsWechatPlatform(string? platform) =>
        !string.IsNullOrWhiteSpace(platform)
        && (platform.Contains("weixin", StringComparison.OrdinalIgnoreCase)
            || platform.Contains("wechat", StringComparison.OrdinalIgnoreCase)
            || platform.Contains("微信", StringComparison.OrdinalIgnoreCase));

    private static string PlatformLabel(string? code) =>
        code is not null && PlatformLabels.TryGetValue(code, out var label) ? label : (code ?? "—");

    private static int CountIds(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return 0;
        }
        try
        {
            return JsonSerializer.Deserialize<List<long>>(json)?.Count ?? 0;
        }
        catch (JsonException)
        {
            return 0;
        }
    }
}
