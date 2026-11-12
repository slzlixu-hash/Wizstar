#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///MCP服务绑定与工具缓存表
    ///</summary>
    [SugarTable("mcp_server_binding")]
    public partial class McpServerBinding
    {
           public McpServerBinding(){


           }
           /// <summary>
           /// Desc:如 supplier-1688 | weixin-shop-openapi
           /// Default:
           /// Nullable:False
           /// </summary>           
           [SugarColumn(IsPrimaryKey=true,ColumnName="server_id")]
           public string ServerId {get;set;}

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
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="description")]           
           public string Description {get;set;}

           /// <summary>
           /// Desc:http|stdio|stub
           /// Default:http
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="transport")]           
           public string Transport {get;set;}

           /// <summary>
           /// Desc:如 http://127.0.0.1:5207
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="endpoint")]           
           public string Endpoint {get;set;}

           /// <summary>
           /// Desc:AES-256-GCM 加密的 HMAC Secret
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="api_key_cipher")]           
           public byte[] ApiKeyCipher {get;set;}

           /// <summary>
           /// Desc:read|write|irreversible
           /// Default:read
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="risk_level")]           
           public string RiskLevel {get;set;}

           /// <summary>
           /// Desc:授权调用的 agent_key 数组
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(IsJson=true)]           
           public string AuthorizedAgentsJson {get;set;} // JSON 文本

           /// <summary>
           /// Desc:握手缓存的工具 Schema 列表
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="tools_json")]           
           public string ToolsJson {get;set;}

           /// <summary>
           /// Desc:
           /// Default:0
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="tools_count")]           
           public int ToolsCount {get;set;}

           /// <summary>
           /// Desc:connected|pending|error
           /// Default:pending
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="connection_state")]           
           public string ConnectionState {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="last_connected_at")]           
           public DateTime? LastConnectedAt {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="last_connect_error")]           
           public string LastConnectError {get;set;}

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
