#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///订单商品明细表
    ///</summary>
    [SugarTable("ecom_order_item")]
    public partial class EcomOrderItem
    {
           public EcomOrderItem(){


           }
           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>           
           [SugarColumn(IsPrimaryKey=true,IsIdentity=true,ColumnName="id")]
           public long Id {get;set;}

           /// <summary>
           /// Desc:关联 ecom_order.id
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="order_id")]           
           public long OrderId {get;set;}

           /// <summary>
           /// Desc:关联 sku_project.id
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="project_id")]           
           public long? ProjectId {get;set;}

           /// <summary>
           /// Desc:关联 sku_variant.id
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="variant_id")]           
           public long? VariantId {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="online_product_id")]           
           public string OnlineProductId {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="title")]           
           public string Title {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="spec_name")]           
           public string SpecName {get;set;}

           /// <summary>
           /// Desc:
           /// Default:1
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="quantity")]           
           public int Quantity {get;set;}

           /// <summary>
           /// Desc:买家购买单价
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="unit_price")]           
           public decimal UnitPrice {get;set;}

           /// <summary>
           /// Desc:对应 1688 采购单价
           /// Default:0.00
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="unit_cost")]           
           public decimal UnitCost {get;set;}

    }
}
