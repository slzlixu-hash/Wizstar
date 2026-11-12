#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///大模型供应商配置表
    ///</summary>
    [SugarTable("llm_provider")]
    public partial class LlmProvider
    {
           public LlmProvider(){


           }
           /// <summary>
           /// Desc:deepseek|ollama|custom_xxx
           /// Default:
           /// Nullable:False
           /// </summary>           
           [SugarColumn(IsPrimaryKey=true,ColumnName="provider_code")]
           public string ProviderCode {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="display_name")]           
           public string DisplayName {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="base_url")]           
           public string BaseUrl {get;set;}

           /// <summary>
           /// Desc:AES-256-GCM 密文
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="api_key_cipher")]           
           public byte[] ApiKeyCipher {get;set;}

           /// <summary>
           /// Desc:掩码回显 (如 sk-****7a9c)
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="api_key_hint")]           
           public string ApiKeyHint {get;set;}

           /// <summary>
           /// Desc:内置种子禁删标记
           /// Default:true
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="is_seed")]           
           public bool IsSeed {get;set;}

           /// <summary>
           /// Desc:
           /// Default:true
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="enabled")]           
           public bool Enabled {get;set;}

           /// <summary>
           /// Desc:
           /// Default:CURRENT_TIMESTAMP
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="updated_at")]           
           public DateTime UpdatedAt {get;set;}

    }
}
