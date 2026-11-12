#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///商品多媒体资源维表
    ///</summary>
    [SugarTable("sku_media")]
    public partial class SkuMedia
    {
           public SkuMedia(){


           }
           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>           
           [SugarColumn(IsPrimaryKey=true,IsIdentity=true,ColumnName="id")]
           public long Id {get;set;}

           /// <summary>
           /// Desc:关联 sku_project.id
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="project_id")]           
           public long ProjectId {get;set;}

           /// <summary>
           /// Desc:image_main|image_detail|video_source|video_generated
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="media_type")]           
           public string MediaType {get;set;}

           /// <summary>
           /// Desc:raw_1688|ai_generated|manual
           /// Default:ai_generated
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="source_type")]           
           public string SourceType {get;set;}

           /// <summary>
           /// Desc:OSS/CDN 文件访问 URL
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="url")]           
           public string Url {get;set;}

           /// <summary>
           /// Desc:封面缩略图 URL
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="thumbnail_url")]           
           public string ThumbnailUrl {get;set;}

           /// <summary>
           /// Desc:排序权重 (升序)
           /// Default:0
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="sort_order")]           
           public int SortOrder {get;set;}

           /// <summary>
           /// Desc:是否封面图
           /// Default:true
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="is_cover")]           
           public bool IsCover {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="width")]           
           public int? Width {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="height")]           
           public int? Height {get;set;}

           /// <summary>
           /// Desc:视频时长 (秒)
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="duration_sec")]           
           public int? DurationSec {get;set;}

           /// <summary>
           /// Desc:
           /// Default:CURRENT_TIMESTAMP
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="created_at")]           
           public DateTime CreatedAt {get;set;}

    }
}
