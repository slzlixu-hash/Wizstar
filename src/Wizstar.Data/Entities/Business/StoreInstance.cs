#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///店铺矩阵管理表
    ///</summary>
    [SugarTable("store_instance")]
    public partial class StoreInstance
    {
           public StoreInstance(){


           }
           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>           
           [SugarColumn(IsPrimaryKey=true,IsIdentity=true,ColumnName="id")]
           public long Id {get;set;}

           /// <summary>
           /// Desc:系统内店铺唯一标识
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="shop_id")]           
           public string ShopId {get;set;}

           /// <summary>
           /// Desc:店铺显示名 (如 微信小店·旗舰店)
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="shop_name")]           
           public string ShopName {get;set;}

           /// <summary>
           /// Desc:weixin_shop|douyin|pinduoduo
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="platform")]           
           public string Platform {get;set;}

           /// <summary>
           /// Desc:valid|expiring|expired
           /// Default:valid
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="auth_status")]           
           public string AuthStatus {get;set;}

           /// <summary>
           /// Desc:开放平台 AppID
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="app_id")]           
           public string AppId {get;set;}

           /// <summary>
           /// Desc:AES-256-GCM 密文存储的 AppSecret
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="app_secret_cipher")]           
           public byte[] AppSecretCipher {get;set;}

           /// <summary>
           /// Desc:绑定的比特浏览器环境编号
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="browser_env_id")]           
           public string BrowserEnvId {get;set;}

           /// <summary>
           /// Desc:单日刊登安全上限
           /// Default:30
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="daily_listing_limit")]           
           public int DailyListingLimit {get;set;}

           /// <summary>
           /// Desc:店铺综合评分
           /// Default:4.80
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="dsr_score")]           
           public decimal DsrScore {get;set;}

           /// <summary>
           /// Desc:店铺默认加价公式、运费模板、退货地址
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(IsJson=true)]           
           public string SettingsJson {get;set;} // JSON 文本

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="last_sync_at")]           
           public DateTime? LastSyncAt {get;set;}

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
