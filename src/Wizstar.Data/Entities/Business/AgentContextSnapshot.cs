#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///上下文注入白盒审计快照表
    ///</summary>
    [SugarTable("agent_context_snapshot")]
    public partial class AgentContextSnapshot
    {
           public AgentContextSnapshot(){


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
           [SugarColumn(ColumnName="agent_key")]           
           public string AgentKey {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="session_id")]           
           public string SessionId {get;set;}

           /// <summary>
           /// Desc:本次实际注入的 memory#id 列表
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(IsJson=true)]           
           public string InjectedMemoryIds {get;set;} // JSON 文本

           /// <summary>
           /// Desc:本次实际注入的 knowledge#id 列表
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(IsJson=true)]           
           public string InjectedKnowledgeIds {get;set;} // JSON 文本

           /// <summary>
           /// Desc:
           /// Default:0
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="total_chars")]           
           public int TotalChars {get;set;}

           /// <summary>
           /// Desc:是否触发字符预算截断
           /// Default:true
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="truncated")]           
           public bool Truncated {get;set;}

           /// <summary>
           /// Desc:
           /// Default:CURRENT_TIMESTAMP
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="created_at")]           
           public DateTime CreatedAt {get;set;}

    }
}
