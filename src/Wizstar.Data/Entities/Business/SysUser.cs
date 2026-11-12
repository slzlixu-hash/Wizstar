#nullable disable
using System;
using System.Linq;
using System.Text;
using SqlSugar;

namespace Wizstar.Data.Entities.Business
{
    ///<summary>
    ///系统操作员账号表
    ///</summary>
    [SugarTable("sys_user")]
    public partial class SysUser
    {
           public SysUser(){


           }
           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>           
           [SugarColumn(IsPrimaryKey=true,IsIdentity=true,ColumnName="id")]
           public long Id {get;set;}

           /// <summary>
           /// Desc:账号 / 手机号
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="username")]           
           public string Username {get;set;}

           /// <summary>
           /// Desc:PBKDF2 / BCrypt 哈希
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="password_hash")]           
           public string PasswordHash {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="display_name")]           
           public string DisplayName {get;set;}

           /// <summary>
           /// Desc:admin|operator|viewer
           /// Default:operator
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="role")]           
           public string Role {get;set;}

           /// <summary>
           /// Desc:
           /// Default:true
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="is_active")]           
           public bool IsActive {get;set;}

           /// <summary>
           /// Desc:
           /// Default:
           /// Nullable:True
           /// </summary>
           [SugarColumn(ColumnName="last_login_at")]           
           public DateTime? LastLoginAt {get;set;}

           /// <summary>
           /// Desc:
           /// Default:CURRENT_TIMESTAMP
           /// Nullable:False
           /// </summary>
           [SugarColumn(ColumnName="created_at")]           
           public DateTime CreatedAt {get;set;}

    }
}
