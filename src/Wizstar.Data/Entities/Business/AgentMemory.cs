#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///Agent长期规则记忆表
    ///</summary>
    [SugarTable("agent_memory")]
    public partial class AgentMemory
    {
           public AgentMemory(){


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
           /// Desc:规则主题 (如 微信小店类目)
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="subject")]
           public string Subject {get;set;}

           /// <summary>
           /// Desc:指标/条件 (如 标题敏感词)
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="metric")]
           public string Metric {get;set;}

           /// <summary>
           /// Desc:规则事实正文
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="value_text")]
           public string ValueText {get;set;}

           /// <summary>
           /// Desc:置信度 (0.00-1.00)
           /// Default:0.90
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="confidence")]
           public decimal Confidence {get;set;}

           /// <summary>
           /// Desc:pending|confirmed|archived
           /// Default:pending
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="status")]
           public string Status {get;set;}

           /// <summary>
           /// Desc:manual|rule|reflection
           /// Default:manual
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="source_type")]
           public string SourceType {get;set;}

           /// <summary>
           /// Desc:来源追溯 (如 sku_project:1024)
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="source_ref")]
           public string SourceRef {get;set;}

           /// <summary>
           /// Desc:人工确认操作员
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="verified_by")]
           public string VerifiedBy {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="verified_at")]
           public DateTime? VerifiedAt {get;set;}

           /// <summary>
           /// Desc:适用标签（如 #保温杯 #冬季 / #全局）
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="tags", IsNullable=true, Length=256)]
           public string Tags {get;set;}

           /// <summary>
           /// Desc:有效期截止（空=永久）
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="expires_at", IsNullable=true)]
           public DateTime? ExpiresAt {get;set;}

           /// <summary>
           /// Desc:被注入 System Prompt 的累计次数
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="hit_count", IsNullable=true)]
           public int? HitCount {get;set;}

           /// <summary>
           /// Desc:归纳样本量（款/单）
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="sample_count", IsNullable=true)]
           public int? SampleCount {get;set;}

           /// <summary>
           /// Desc:同步到的 Agent（逗号分隔，如 scout,sourcing）
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="sync_agent_keys", IsNullable=true, Length=256)]
           public string SyncAgentKeys {get;set;}

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
