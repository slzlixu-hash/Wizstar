#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///流水线与质检审计表
    ///</summary>
    [SugarTable("sku_pipeline_audit")]
    public partial class SkuPipelineAudit
    {
           public SkuPipelineAudit(){


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
           [SugarColumn(ColumnName="project_id")]           
           public long ProjectId {get;set;}

           /// <summary>
           /// Desc:scout|sourcing|creative|publisher|analyst|human
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="agent_key")]           
           public string AgentKey {get;set;}

           /// <summary>
           /// Desc:trend_score|1688_match|image_blend|hitl_review|publish_execute
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="step_code")]           
           public string StepCode {get;set;}

           /// <summary>
           /// Desc:started|success|failed|pending_approval|approved|rejected
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="status")]           
           public string Status {get;set;}

           /// <summary>
           /// Desc:操作员账号 (人工审批时必填)
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="operator")]           
           public string Operator {get;set;}

           /// <summary>
           /// Desc:执行说明或驳回原因
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="notes")]           
           public string Notes {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="elapsed_ms")]           
           public int? ElapsedMs {get;set;}

           /// <summary>
           /// Desc:
           /// Default:CURRENT_TIMESTAMP
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="created_at")]           
           public DateTime CreatedAt {get;set;}

    }
}
