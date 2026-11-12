#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///Agent上下文设置表
    ///</summary>
    [SugarTable("agent_context_setting")]
    public partial class AgentContextSetting
    {
           public AgentContextSetting(){


           }
           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>           
           [SugarColumn(IsPrimaryKey=true,ColumnName="agent_key")]
           public string AgentKey {get;set;}

           /// <summary>
           /// Desc:长期规则注入字符上限
           /// Default:4000
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="max_memory_chars")]           
           public int MaxMemoryChars {get;set;}

           /// <summary>
           /// Desc:知识库注入字符上限
           /// Default:4000
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="max_knowledge_chars")]           
           public int MaxKnowledgeChars {get;set;}

           /// <summary>
           /// Desc:是否开启显式记忆提取
           /// Default:true
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="enable_l1_extraction")]           
           public bool EnableL1Extraction {get;set;}

           /// <summary>
           /// Desc:
           /// Default:CURRENT_TIMESTAMP
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="updated_at")]           
           public DateTime UpdatedAt {get;set;}

    }
}
