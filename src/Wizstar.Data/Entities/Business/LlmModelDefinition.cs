#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///模型定义表
    ///</summary>
    [SugarTable("llm_model_definition")]
    public partial class LlmModelDefinition
    {
           public LlmModelDefinition(){


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
           [SugarColumn(ColumnName="provider_code")]           
           public string ProviderCode {get;set;}

           /// <summary>
           /// Desc:如 deepseek-chat | deepseek-reasoner
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="model_id")]           
           public string ModelId {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="display_name")]           
           public string DisplayName {get;set;}

           /// <summary>
           /// Desc:是否全局默认主力模型
           /// Default:true
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="is_default_global")]           
           public bool IsDefaultGlobal {get;set;}

           /// <summary>
           /// Desc:
           /// Default:true
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="enabled")]           
           public bool Enabled {get;set;}

    }
}
