#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///商品立项主表
    ///</summary>
    [SugarTable("sku_project")]
    public partial class SkuProject
    {
           public SkuProject(){


           }
           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>           
           [SugarColumn(IsPrimaryKey=true,IsIdentity=true,ColumnName="id")]
           public long Id {get;set;}

           /// <summary>
           /// Desc:业务流水号 (如 SP20261111-0001)
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="project_no")]           
           public string ProjectNo {get;set;}

           /// <summary>
           /// Desc:所属测款批次号
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="batch_id")]           
           public string BatchId {get;set;}

           /// <summary>
           /// Desc:商品基准标题
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="title")]           
           public string Title {get;set;}

           /// <summary>
           /// Desc:标准类目名称
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="category_name")]           
           public string CategoryName {get;set;}

           /// <summary>
           /// Desc:选品来源: douyin_compass|jushuitan|ai_autonomous|manual
           /// Default:ai_autonomous
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="selection_source")]           
           public string SelectionSource {get;set;}

           /// <summary>
           /// Desc:scouted|sourced|creative_ready|pending_review|published|error|archived
           /// Default:scouted
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="status")]           
           public string Status {get;set;}

           /// <summary>
           /// Desc:最低 1688 采购成本
           /// Default:0.00
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="min_cost")]           
           public decimal MinCost {get;set;}

           /// <summary>
           /// Desc:建议零售基准价
           /// Default:0.00
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="suggested_price")]           
           public decimal SuggestedPrice {get;set;}

           /// <summary>
           /// Desc:预估平均毛利率 (%)
           /// Default:0.00
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="avg_margin_rate")]           
           public decimal AvgMarginRate {get;set;}

           /// <summary>
           /// Desc:封面主图缩略图 URL
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="cover_image_url")]           
           public string CoverImageUrl {get;set;}

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
