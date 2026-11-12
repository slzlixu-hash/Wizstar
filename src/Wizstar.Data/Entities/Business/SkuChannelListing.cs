#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///商品多店铺刊登维表
    ///</summary>
    [SugarTable("sku_channel_listing")]
    public partial class SkuChannelListing
    {
           public SkuChannelListing(){


           }
           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>           
           [SugarColumn(IsPrimaryKey=true,IsIdentity=true,ColumnName="id")]
           public long Id {get;set;}

           /// <summary>
           /// Desc:关联 sku_project.id
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="project_id")]           
           public long ProjectId {get;set;}

           /// <summary>
           /// Desc:目标店铺 ID (关联 store_instance.shop_id)
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="shop_id")]           
           public string ShopId {get;set;}

           /// <summary>
           /// Desc:weixin_shop|douyin|pinduoduo
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="platform")]           
           public string Platform {get;set;}

           /// <summary>
           /// Desc:平台返回的真实商品 ID
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="online_product_id")]           
           public string OnlineProductId {get;set;}

           /// <summary>
           /// Desc:平台绑定类目 ID
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="channel_category_id")]           
           public string ChannelCategoryId {get;set;}

           /// <summary>
           /// Desc:针对该店铺排重优化后的标题
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="channel_title")]           
           public string ChannelTitle {get;set;}

           /// <summary>
           /// Desc:pending|auditing|online|rejected|delisted
           /// Default:pending
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="channel_status")]           
           public string ChannelStatus {get;set;}

           /// <summary>
           /// Desc:该店铺实际线上标价
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="online_price")]           
           public decimal? OnlinePrice {get;set;}

           /// <summary>
           /// Desc:平台驳回原因
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="audit_reject_reason")]           
           public string AuditRejectReason {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="published_at")]           
           public DateTime? PublishedAt {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="last_sync_at")]           
           public DateTime? LastSyncAt {get;set;}

    }
}
