#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///1688代发采购与物流回填表
    ///</summary>
    [SugarTable("fulfillment_procurement")]
    public partial class FulfillmentProcurement
    {
           public FulfillmentProcurement(){


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
           /// Desc:
           /// Default:1688
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="source_platform")]           
           public string SourcePlatform {get;set;}

           /// <summary>
           /// Desc:1688 生成的真实采购单号
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="source_order_id")]           
           public string SourceOrderId {get;set;}

           /// <summary>
           /// Desc:实际 1688 采购付款金额
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="procurement_amount")]           
           public decimal? ProcurementAmount {get;set;}

           /// <summary>
           /// Desc:created|paid|shipped|cancelled|failed
           /// Default:created
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="procurement_status")]           
           public string ProcurementStatus {get;set;}

           /// <summary>
           /// Desc:快递公司 (如 中通快递)
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="express_company")]           
           public string ExpressCompany {get;set;}

           /// <summary>
           /// Desc:快递运单号
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="tracking_number")]           
           public string TrackingNumber {get;set;}

           /// <summary>
           /// Desc:是否已回填至微信小店/抖店
           /// Default:true
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="synced_to_shop")]           
           public bool SyncedToShop {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="synced_at")]           
           public DateTime? SyncedAt {get;set;}

           /// <summary>
           /// Desc:关联 mcp_call_audit 幂等流水号
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="operation_id")]           
           public string OperationId {get;set;}

           /// <summary>
           /// Desc:
           /// Default:CURRENT_TIMESTAMP
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="created_at")]           
           public DateTime CreatedAt {get;set;}

           /// <summary>
           /// Desc:
           /// Default:CURRENT_TIMESTAMP
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="updated_at")]           
           public DateTime UpdatedAt {get;set;}

    }
}
