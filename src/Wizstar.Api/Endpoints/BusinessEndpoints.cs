using System.Globalization;
using Microsoft.AspNetCore.Mvc;
using SqlSugar;
using Wizstar.Agents.Governance;
using Wizstar.Contracts;
using Wizstar.Data.Entities.Business;

namespace Wizstar.Api.Endpoints;

/// <summary>
/// 业务域只读端点：商品 / 订单 / 店铺 / 工作台聚合。
///
/// 数据源全部是真实业务表（sku_project / sku_variant / sku_channel_listing /
/// ecom_order / ecom_order_item / store_instance），空表即返回空清单与全 0 统计——
/// 不做任何演示兜底，前端据此渲染真实空态。
/// </summary>
public static class BusinessEndpoints
{
    private static readonly Dictionary<string, (string Label, string Tone)> ProductStatus = new(StringComparer.OrdinalIgnoreCase)
    {
        ["scouted"] = ("待评估", "slate"),
        ["sourced"] = ("已寻源", "cyan"),
        ["creative_ready"] = ("素材就绪", "violet"),
        ["pending_review"] = ("待审核", "amber"),
        ["published"] = ("在售", "green"),
        ["error"] = ("异常", "rose"),
        ["archived"] = ("已归档", "slate"),
    };

    private static readonly Dictionary<string, (string Label, string Tone)> FulfillmentStatus = new(StringComparer.OrdinalIgnoreCase)
    {
        ["pending_purchase"] = ("待采购", "amber"),
        ["purchasing"] = ("采购中", "cyan"),
        ["awaiting_tracking"] = ("待发货", "amber"),
        ["shipped"] = ("已发货", "green"),
        ["refund_intercepted"] = ("退款拦截", "rose"),
        ["error"] = ("异常", "rose"),
    };

    private static readonly Dictionary<string, string> PlatformLabel = new(StringComparer.OrdinalIgnoreCase)
    {
        ["weixin_shop"] = "微信小店",
        ["douyin"] = "抖音小店",
        ["pinduoduo"] = "拼多多",
        ["taobao"] = "淘宝",
        ["jd"] = "京东",
        ["manual"] = "手工录入",
    };

    private static string Platform(string? code) =>
        code is not null && PlatformLabel.TryGetValue(code, out var label) ? label : (code ?? "—");

    /// <summary>金额按人民币两位小数展示（前端直接渲染字符串，避免二次格式化误差）。</summary>
    private static string Money(decimal amount) => "¥" + amount.ToString("N2", CultureInfo.InvariantCulture);

    /// <summary>计数固定走 InvariantCulture，避免服务器区域设置影响输出（CA1305）。</summary>
    private static string Num(int value) => value.ToString(CultureInfo.InvariantCulture);

    private static string Stamp(DateTime value) => value.ToString("MM-dd HH:mm", CultureInfo.InvariantCulture);

    private static string Day(DateTime? value) =>
        value?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) ?? "—";

    public static void MapBusinessEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/business").WithTags("Business");

        /* ------------------------------ 商品管理 ------------------------------ */
        group.MapGet("/products", (
            ISqlSugarClient db,
            [FromQuery] string? keyword,
            [FromQuery] string? status) =>
        {
            var projects = db.Queryable<SkuProject>().ToList();
            var variants = db.Queryable<SkuVariant>().ToList();
            var listings = db.Queryable<SkuChannelListing>().ToList();

            var stockByProject = variants
                .GroupBy(v => v.ProjectId)
                .ToDictionary(g => g.Key, g => g.Sum(v => v.StockQuantity));
            var priceByProject = variants
                .GroupBy(v => v.ProjectId)
                .ToDictionary(g => g.Key, g => g.Min(v => v.SellingPrice));
            var listingByProject = listings
                .GroupBy(l => l.ProjectId)
                .ToDictionary(g => g.Key, g => g.First());

            var rows = projects
                .OrderByDescending(p => p.UpdatedAt)
                .Select(p =>
                {
                    var meta = ProductStatus.TryGetValue(p.Status ?? string.Empty, out var m) ? m : ("未知状态", "slate");
                    var listing = listingByProject.GetValueOrDefault(p.Id);
                    var price = p.SuggestedPrice > 0
                        ? p.SuggestedPrice
                        : priceByProject.GetValueOrDefault(p.Id);
                    return new
                    {
                        id = p.ProjectNo,
                        name = p.Title,
                        price = Money(price),
                        stock = stockByProject.GetValueOrDefault(p.Id),
                        channel = listing is null || string.IsNullOrEmpty(listing.Platform)
                            ? "未上架"
                            : Platform(listing.Platform),
                        status = meta.Item1,
                        tone = meta.Item2,
                        rawStatus = p.Status,
                        category = p.CategoryName ?? string.Empty,
                        marginRate = p.AvgMarginRate,
                        updatedAt = p.UpdatedAt,
                    };
                })
                .ToList();

            if (!string.IsNullOrWhiteSpace(keyword))
            {
                var kw = keyword.Trim();
                rows = rows.Where(r =>
                        r.name.Contains(kw, StringComparison.OrdinalIgnoreCase) ||
                        r.id.Contains(kw, StringComparison.OrdinalIgnoreCase))
                    .ToList();
            }

            if (!string.IsNullOrWhiteSpace(status) && !string.Equals(status, "all", StringComparison.OrdinalIgnoreCase))
            {
                rows = rows.Where(r => string.Equals(r.rawStatus, status, StringComparison.OrdinalIgnoreCase)).ToList();
            }

            var today = DateTime.Today;
            var stats = new object[]
            {
                new { label = "在售商品", value = Num(projects.Count(p => p.Status == "published")), unit = "个" },
                new { label = "待上架", value = Num(projects.Count(p => p.Status is "pending_review" or "creative_ready")), unit = "个" },
                new { label = "今日新增", value = Num(projects.Count(p => p.CreatedAt >= today)), unit = "个" },
                new { label = "缺货预警", value = Num(projects.Count(p => stockByProject.GetValueOrDefault(p.Id) <= 0)), unit = "个" },
            };

            return Results.Ok(ApiEnvelope<object>.Ok(new { stats, rows, total = rows.Count }, string.Empty));
        });

        /* ------------------------------ 订单履约 ------------------------------ */
        group.MapGet("/orders", (
            ISqlSugarClient db,
            [FromQuery] string? keyword,
            [FromQuery] string? status) =>
        {
            var orders = db.Queryable<EcomOrder>().ToList();
            var items = db.Queryable<EcomOrderItem>().ToList();
            var shops = db.Queryable<StoreInstance>().ToList().ToDictionary(s => s.ShopId, s => s.ShopName);

            var itemsByOrder = items.GroupBy(i => i.OrderId).ToDictionary(g => g.Key, g => g.ToList());

            var rows = orders
                .OrderByDescending(o => o.PaidAt ?? o.CreatedAt)
                .Select(o =>
                {
                    var meta = FulfillmentStatus.TryGetValue(o.FulfillmentStatus ?? string.Empty, out var m) ? m : ("未知状态", "slate");
                    var aftersale = !string.IsNullOrEmpty(o.AftersaleStatus) && o.AftersaleStatus != "none";
                    var own = itemsByOrder.GetValueOrDefault(o.Id) ?? [];
                    var itemsText = own.Count == 0
                        ? "—"
                        : string.Join(" + ", own.Select(i =>
                            string.IsNullOrEmpty(i.SpecName)
                                ? $"{i.Title} ×{i.Quantity}"
                                : $"{i.Title}({i.SpecName}) ×{i.Quantity}"));

                    return new
                    {
                        id = o.PlatformOrderId,
                        shop = shops.GetValueOrDefault(o.ShopId) ?? o.ShopId,
                        amount = Money(o.OrderAmount),
                        items = itemsText,
                        status = aftersale ? "售后中" : meta.Item1,
                        tone = aftersale ? "rose" : meta.Item2,
                        rawStatus = o.FulfillmentStatus,
                        aftersale,
                        eta = Stamp(o.PaidAt ?? o.CreatedAt),
                        profit = Money(o.EstimatedProfit),
                    };
                })
                .ToList();

            if (!string.IsNullOrWhiteSpace(keyword))
            {
                var kw = keyword.Trim();
                rows = rows.Where(r =>
                        r.id.Contains(kw, StringComparison.OrdinalIgnoreCase) ||
                        r.shop.Contains(kw, StringComparison.OrdinalIgnoreCase) ||
                        r.items.Contains(kw, StringComparison.OrdinalIgnoreCase))
                    .ToList();
            }

            if (!string.IsNullOrWhiteSpace(status) && !string.Equals(status, "all", StringComparison.OrdinalIgnoreCase))
            {
                rows = string.Equals(status, "aftersale", StringComparison.OrdinalIgnoreCase)
                    ? rows.Where(r => r.aftersale).ToList()
                    : rows.Where(r => string.Equals(r.rawStatus, status, StringComparison.OrdinalIgnoreCase)).ToList();
            }

            var today = DateTime.Today;
            var todayOrders = orders.Where(o => (o.PaidAt ?? o.CreatedAt) >= today).ToList();
            var stats = new object[]
            {
                new { label = "今日订单", value = Num(todayOrders.Count), unit = "单" },
                new
                {
                    label = "已发货",
                    value = Num(orders.Count(o => o.FulfillmentStatus == "shipped")),
                    unit = "单"
                },
                new
                {
                    label = "待发货",
                    value = Num(orders.Count(o => o.FulfillmentStatus is "pending_purchase" or "purchasing" or "awaiting_tracking")),
                    unit = "单"
                },
                new
                {
                    label = "售后中",
                    value = Num(orders.Count(o => !string.IsNullOrEmpty(o.AftersaleStatus) && o.AftersaleStatus != "none")),
                    unit = "单"
                },
            };

            return Results.Ok(ApiEnvelope<object>.Ok(new { stats, rows, total = rows.Count }, string.Empty));
        });

        /* ------------------------------ 店铺管理 ------------------------------ */
        group.MapGet("/shops", (ISqlSugarClient db, [FromQuery] string? keyword) =>
        {
            var shops = db.Queryable<StoreInstance>().ToList();
            var orders = db.Queryable<EcomOrder>().ToList();
            var today = DateTime.Today;

            var gmvByShop = orders
                .Where(o => (o.PaidAt ?? o.CreatedAt) >= today)
                .GroupBy(o => o.ShopId)
                .ToDictionary(g => g.Key, g => g.Sum(o => o.OrderAmount));

            var rows = shops
                .OrderBy(s => s.ShopId)
                .Select(s =>
                {
                    var auth = (s.AuthStatus ?? string.Empty).ToLowerInvariant() switch
                    {
                        "valid" => ("授权正常", "green"),
                        "expiring" => ("即将到期", "amber"),
                        "expired" => ("已过期", "rose"),
                        _ => ("未授权", "slate"),
                    };
                    return new
                    {
                        id = s.ShopId,
                        name = s.ShopName,
                        platform = Platform(s.Platform),
                        auth = auth.Item1,
                        tone = auth.Item2,
                        rawAuth = s.AuthStatus,
                        expire = Day(s.LastSyncAt),
                        gmv = Money(gmvByShop.GetValueOrDefault(s.ShopId)),
                        listingLimit = s.DailyListingLimit,
                        dsr = s.DsrScore,
                    };
                })
                .ToList();

            if (!string.IsNullOrWhiteSpace(keyword))
            {
                var kw = keyword.Trim();
                rows = rows.Where(r =>
                        r.name.Contains(kw, StringComparison.OrdinalIgnoreCase) ||
                        r.platform.Contains(kw, StringComparison.OrdinalIgnoreCase) ||
                        r.id.Contains(kw, StringComparison.OrdinalIgnoreCase))
                    .ToList();
            }

            var stats = new object[]
            {
                new { label = "已绑定店铺", value = Num(shops.Count), unit = "家" },
                new { label = "授权正常", value = Num(shops.Count(s => string.Equals(s.AuthStatus, "valid", StringComparison.OrdinalIgnoreCase))), unit = "家" },
                new { label = "今日 GMV", value = Money(gmvByShop.Values.Sum()).Replace("¥", "¥"), unit = "" },
                new { label = "临期授权", value = Num(shops.Count(s => string.Equals(s.AuthStatus, "expired", StringComparison.OrdinalIgnoreCase))), unit = "家" },
            };

            return Results.Ok(ApiEnvelope<object>.Ok(new { stats, rows, total = rows.Count }, string.Empty));
        });

        /* ------------------------------ 工作台聚合 ------------------------------ */
        group.MapGet("/dashboard", (ISqlSugarClient db, IApprovalStore approvals) =>
        {
            var today = DateTime.Today;
            var orders = db.Queryable<EcomOrder>().ToList();
            var todayOrders = orders.Where(o => (o.PaidAt ?? o.CreatedAt) >= today).ToList();
            var projects = db.Queryable<SkuProject>().ToList();
            var pending = approvals.List(ApprovalStatus.Pending, 100);

            var sales = todayOrders.Sum(o => o.OrderAmount);
            var profit = todayOrders.Sum(o => o.EstimatedProfit);
            var margin = sales > 0 ? profit / sales * 100m : 0m;

            var kpis = new object[]
            {
                new
                {
                    id = "sales",
                    label = "今日总销售额",
                    prefix = "¥",
                    value = sales.ToString("N2", CultureInfo.InvariantCulture),
                    unit = "",
                    delta = "",
                    deltaTone = "up",
                    meta = $"来自 {todayOrders.Count} 笔已付款订单（真实业务表）",
                    warn = false,
                },
                new
                {
                    id = "orders",
                    label = "今日订单量",
                    prefix = "",
                    value = Num(todayOrders.Count),
                    unit = "单",
                    delta = "",
                    deltaTone = "up",
                    meta = $"待发货 {orders.Count(o => o.FulfillmentStatus is "pending_purchase" or "purchasing" or "awaiting_tracking")} 单 · 已发货 {orders.Count(o => o.FulfillmentStatus == "shipped")} 单",
                    warn = false,
                },
                new
                {
                    id = "profit",
                    label = "今日预估毛利",
                    prefix = "¥",
                    value = profit.ToString("N2", CultureInfo.InvariantCulture),
                    unit = "",
                    delta = "",
                    deltaTone = "up",
                    meta = $"毛利率 {margin.ToString("N1", CultureInfo.InvariantCulture)}%",
                    warn = false,
                },
                new
                {
                    id = "hitl",
                    label = "待我审批（HITL）",
                    prefix = "",
                    value = Num(pending.Count),
                    unit = "项",
                    warn = pending.Count > 0,
                    delta = "",
                    deltaTone = "up",
                    meta = pending.Count > 0
                        ? $"最早 {pending.Min(p => p.CreatedAt).ToLocalTime():HH:mm} 提交"
                        : "暂无待审批事项",
                },
            };

            var pipeline = new object[]
            {
                new { label = "选品中", count = projects.Count(p => p.Status == "scouted"), tone = "amber" },
                new { label = "寻源比价", count = projects.Count(p => p.Status == "sourced"), tone = "cyan" },
                new { label = "素材制作", count = projects.Count(p => p.Status == "creative_ready"), tone = "green" },
                new { label = "待质检审核", count = projects.Count(p => p.Status == "pending_review"), tone = "violet" },
                new { label = "今日已上架", count = projects.Count(p => p.Status == "published" && p.UpdatedAt >= today), tone = "slate" },
            };

            return Results.Ok(ApiEnvelope<object>.Ok(new { kpis, pipeline }, string.Empty));
        });
    }
}
