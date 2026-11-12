#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///全渠道聚合订单主表
    ///</summary>
    [SugarTable("ecom_order")]
    public partial class EcomOrder
    {
           public EcomOrder(){


           }
           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>           
           [SugarColumn(IsPrimaryKey=true,IsIdentity=true,ColumnName="id")]
           public long Id {get;set;}

           /// <summary>
           /// Desc:微信小店/抖店原始订单号
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="platform_order_id")]           
           public string PlatformOrderId {get;set;}

           /// <summary>
           /// Desc:所属店铺 ID
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
           /// Desc:脱敏收件人 (如 王**)
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="buyer_name_masked")]           
           public string BuyerNameMasked {get;set;}

           /// <summary>
           /// Desc:脱敏手机 (如 138****8888)
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="buyer_phone_masked")]           
           public string BuyerPhoneMasked {get;set;}

           /// <summary>
           /// Desc:省市区地址摘要
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="receiver_region")]           
           public string ReceiverRegion {get;set;}

           /// <summary>
           /// Desc:AES-256-GCM 加密的完整收件地址/电话
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="receiver_cipher")]           
           public byte[] ReceiverCipher {get;set;}

           /// <summary>
           /// Desc:买家实付金额
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="order_amount")]           
           public decimal OrderAmount {get;set;}

           /// <summary>
           /// Desc:1688 采购总成本 (含采购运费)
           /// Default:0.00
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="total_cost")]           
           public decimal TotalCost {get;set;}

           /// <summary>
           /// Desc:预估单笔净利润
           /// Default:0.00
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="estimated_profit")]           
           public decimal EstimatedProfit {get;set;}

           /// <summary>
           /// Desc:pending_purchase|purchasing|awaiting_tracking|shipped|refund_intercepted|error
           /// Default:pending_purchase
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="fulfillment_status")]           
           public string FulfillmentStatus {get;set;}

           /// <summary>
           /// Desc:none|refund_requested|intercepted|closed
           /// Default:none
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="aftersale_status")]           
           public string AftersaleStatus {get;set;}

           /// <summary>
           /// Desc:买家付款时间
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="paid_at")]           
           public DateTime? PaidAt {get;set;}

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
