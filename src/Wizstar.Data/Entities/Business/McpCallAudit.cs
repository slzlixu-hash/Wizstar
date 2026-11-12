#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///MCP工具调用与HITL审批审计表
    ///</summary>
    [SugarTable("mcp_call_audit")]
    public partial class McpCallAudit
    {
           public McpCallAudit(){


           }
           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>           
           [SugarColumn(IsPrimaryKey=true,IsIdentity=true,ColumnName="id")]
           public long Id {get;set;}

           /// <summary>
           /// Desc:全局幂等流水号 (op-{taskId}-{step}-{hash16})
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="operation_id")]           
           public string OperationId {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="server_id")]           
           public string ServerId {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="tool_name")]           
           public string ToolName {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="agent_key")]           
           public string AgentKey {get;set;}

           /// <summary>
           /// Desc:关联的商品 ID (若有)
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="project_id")]           
           public long? ProjectId {get;set;}

           /// <summary>
           /// Desc:dry_run|live
           /// Default:dry_run
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="mode")]           
           public string Mode {get;set;}

           /// <summary>
           /// Desc:
           /// Default:read
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="risk_level")]           
           public string RiskLevel {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(IsJson=true)]           
           public string ArgsJson {get;set;} // JSON 文本

           /// <summary>
           /// Desc:入参 SHA-256 指纹 (防止审批后参数被篡改)
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="args_digest")]           
           public string ArgsDigest {get;set;}

           /// <summary>
           /// Desc:pending_approval|executed|rejected|failed
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="status")]           
           public string Status {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="approved_by")]           
           public string ApprovedBy {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="approved_at")]           
           public DateTime? ApprovedAt {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="response_envelope_json")]           
           public string ResponseEnvelopeJson {get;set;}

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
