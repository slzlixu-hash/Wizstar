#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///MAF智能体团队注册表
    ///</summary>
    [SugarTable("agent_registry")]
    public partial class AgentRegistry
    {
           public AgentRegistry(){


           }
           /// <summary>
           /// Desc:commander|selection|sourcing|creative|publisher|analyst
           /// Default:
           /// Nullable:False
           /// </summary>           
           [SugarColumn(IsPrimaryKey=true,ColumnName="agent_key")]
           public string AgentKey {get;set;}

           /// <summary>
           /// Desc:中文名称 (如 选品专员)
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="display_name")]           
           public string DisplayName {get;set;}

           /// <summary>
           /// Desc:核心业务职责
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="role_summary")]           
           public string RoleSummary {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="avatar")]           
           public string Avatar {get;set;}

           /// <summary>
           /// Desc:idle|working|error
           /// Default:idle
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="runtime_status")]           
           public string RuntimeStatus {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="status_source")]           
           public string StatusSource {get;set;}

           /// <summary>
           /// Desc:绑定的专属默认模型 (如 deepseek-chat)
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="default_model_id")]           
           public string DefaultModelId {get;set;}

           /// <summary>
           /// Desc:能力标签列表
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(IsJson=true)]           
           public string CapabilitiesJson {get;set;} // JSON 文本

           /// <summary>
           /// Desc:
           /// Default:true
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="is_enabled")]           
           public bool IsEnabled {get;set;}

           /// <summary>
           /// Desc:
           /// Default:CURRENT_TIMESTAMP
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="updated_at")]           
           public DateTime UpdatedAt {get;set;}

    }
}
