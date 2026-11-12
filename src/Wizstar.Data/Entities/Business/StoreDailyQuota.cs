#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///店铺每日刊登配额水线表
    ///</summary>
    [SugarTable("store_daily_quota")]
    public partial class StoreDailyQuota
    {
           public StoreDailyQuota(){


           }
           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>           
           [SugarColumn(IsPrimaryKey=true,IsIdentity=true,ColumnName="id")]
           public long Id {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="shop_id")]           
           public string ShopId {get;set;}

           /// <summary>
           /// Desc:统计日期 (YYYY-MM-DD)
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="quota_date")]           
           public DateTime QuotaDate {get;set;}

           /// <summary>
           /// Desc:当日已成功刊登数
           /// Default:0
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="listed_count")]           
           public int ListedCount {get;set;}

           /// <summary>
           /// Desc:当日安全上限快照
           /// Default:30
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="limit_snapshot")]           
           public int LimitSnapshot {get;set;}

           /// <summary>
           /// Desc:
           /// Default:CURRENT_TIMESTAMP
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="updated_at")]           
           public DateTime UpdatedAt {get;set;}

    }
}
