#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///测款批次任务表
    ///</summary>
    [SugarTable("selection_batch")]
    public partial class SelectionBatch
    {
           public SelectionBatch(){


           }
           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>           
           [SugarColumn(IsPrimaryKey=true,IsIdentity=true,ColumnName="id")]
           public long Id {get;set;}

           /// <summary>
           /// Desc:批次唯一号 (如 batch_20261111_01)
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="batch_id")]           
           public string BatchId {get;set;}

           /// <summary>
           /// Desc:批次名称 (如 冬季家居保温杯测款)
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="batch_name")]           
           public string BatchName {get;set;}

           /// <summary>
           /// Desc:主要选品来源: douyin_compass|jushuitan|ai_autonomous
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="selection_source")]           
           public string SelectionSource {get;set;}

           /// <summary>
           /// Desc:目标类目
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="target_category")]           
           public string TargetCategory {get;set;}

           /// <summary>
           /// Desc:计划测款数量
           /// Default:20
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="target_count")]           
           public int TargetCount {get;set;}

           /// <summary>
           /// Desc:已完成数
           /// Default:0
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="completed_count")]           
           public int CompletedCount {get;set;}

           /// <summary>
           /// Desc:running|paused|completed|failed
           /// Default:running
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="status")]           
           public string Status {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="created_by")]           
           public string CreatedBy {get;set;}

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
