#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///商品货源供应链维表
    ///</summary>
    [SugarTable("sku_sourcing")]
    public partial class SkuSourcing
    {
           public SkuSourcing(){


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
           /// Desc:供货平台: 1688|pinduoduo|jushuitan_erp
           /// Default:1688
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="supplier_platform")]           
           public string SupplierPlatform {get;set;}

           /// <summary>
           /// Desc:供应商店铺/工厂名称
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="supplier_shop_name")]           
           public string SupplierShopName {get;set;}

           /// <summary>
           /// Desc:1688 供应商店铺主页直达链接
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="supplier_shop_url")]           
           public string SupplierShopUrl {get;set;}

           /// <summary>
           /// Desc:货源商品唯一 Offer ID
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="supplier_offer_id")]           
           public string SupplierOfferId {get;set;}

           /// <summary>
           /// Desc:1688 货源商品详情页链接
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="supplier_offer_url")]           
           public string SupplierOfferUrl {get;set;}

           /// <summary>
           /// Desc:工厂综合评分
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="factory_score")]           
           public decimal? FactoryScore {get;set;}

           /// <summary>
           /// Desc:起订量
           /// Default:1
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="min_order_quantity")]           
           public int MinOrderQuantity {get;set;}

           /// <summary>
           /// Desc:首件采购运费
           /// Default:0.00
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="shipping_fee")]           
           public decimal ShippingFee {get;set;}

           /// <summary>
           /// Desc:工厂发货地
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="dispatch_address")]           
           public string DispatchAddress {get;set;}

           /// <summary>
           /// Desc:是否为当前选定的主供应商
           /// Default:true
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="is_primary")]           
           public bool IsPrimary {get;set;}

           /// <summary>
           /// Desc:抓取的原始响应快照
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(IsJson=true)]           
           public string RawPayloadJson {get;set;} // JSON 文本

           /// <summary>
           /// Desc:
           /// Default:CURRENT_TIMESTAMP
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="created_at")]           
           public DateTime CreatedAt {get;set;}

    }
}
