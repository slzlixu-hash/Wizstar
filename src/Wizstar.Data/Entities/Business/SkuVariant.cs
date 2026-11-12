#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///商品规格变体维表
    ///</summary>
    [SugarTable("sku_variant")]
    public partial class SkuVariant
    {
           public SkuVariant(){


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
           /// Desc:规格名称 (如 颜色:曜石黑;容量:500ml)
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="spec_name")]           
           public string SpecName {get;set;}

           /// <summary>
           /// Desc:内部自编 SKU 编码
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="sku_code")]           
           public string SkuCode {get;set;}

           /// <summary>
           /// Desc:1688 源头对应规格 ID
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="source_sku_id")]           
           public string SourceSkuId {get;set;}

           /// <summary>
           /// Desc:该规格采购成本
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="cost_price")]           
           public decimal CostPrice {get;set;}

           /// <summary>
           /// Desc:该规格建议/执行售价
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="selling_price")]           
           public decimal SellingPrice {get;set;}

           /// <summary>
           /// Desc:该规格毛利率 (%)
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="margin_rate")]           
           public decimal MarginRate {get;set;}

           /// <summary>
           /// Desc:可用同步库存
           /// Default:999
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="stock_quantity")]           
           public int StockQuantity {get;set;}

           /// <summary>
           /// Desc:规格 SKU 小图
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="spec_image_url")]           
           public string SpecImageUrl {get;set;}

           /// <summary>
           /// Desc:
           /// Default:CURRENT_TIMESTAMP
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="created_at")]           
           public DateTime CreatedAt {get;set;}

    }
}
