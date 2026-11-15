# 工作流配方（pipelines/）

把「选品来源 → 工序顺序」从代码里移到 YAML。C# 里**没有任何 `if (source == ...)` 分支**：
指挥官只做两件事——按 `trigger_source` 找到配方、按 `next` 指针推进状态机。

## 一份配方长什么样

```yaml
pipeline_id: douyin_compass_flow      # 唯一 ID，写进 sku_project.pipeline_id
name: 抖音罗盘爆款截流标准流
trigger_source: douyin_compass        # 与 sku_project.selection_source 对齐
description: 可选说明
stages:
  - code: scout_ingest                # 工序代号（执行器按它注册）
    name: 选品落库                     # 展示名
    type: auto                        # auto | hitl_gate
    agent: selection                  # 负责 Agent（agents.yaml 的 key）
    skill: compass_fetch_skill        # 绑定的技能/MCP 能力
    next: sourcing_1688               # 下一个工序；null 表示终点
  - code: qualification_gate
    name: 资格 / 毛利审核
    type: hitl_gate                   # 人机闸口：挂起等待人工通过/驳回
    panel: qualification              # 右侧抽屉展示哪种面板
    auto_rule: "margin_rate >= 0.35"  # 审核口径（展示给人工，引擎不解析表达式）
    require_human: true
    next: creative_media
```

字段速查：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `pipeline_id` / `name` / `trigger_source` | 是 | ID 唯一；来源全局唯一（冲突时先加载者生效） |
| `enabled` | 否 | 默认 true；停用后不参与「按来源解析」，仍可在编辑器查看/修改 |
| `stages[].code` | 是 | 同一配方内唯一；执行器按 code 命中 |
| `stages[].type` | 否 | `auto`（默认）或 `hitl_gate` |
| `stages[].agent` / `skill` | 否 | 执行与展示用；都没有的自动工序只能人工完成 |
| `stages[].mode` | 否 | 透传执行器的模式提示：`direct_publish` / `listing_0` / `update_and_list` |
| `stages[].panel` | 否 | 抽屉面板：`qualification` / `media_compare` |
| `stages[].auto_rule` | 否 | 审核口径文案（闸口建议必填） |
| `stages[].require_human` | 否 | 默认 true（执行时挂起等人工审批）；false 时闸口自动放行（auto_rule 仅作展示口径，引擎不解析表达式） |
| `stages[].next` | 否 | 必须指向存在的 code；`null` = 终点 |

## 新增一个选品渠道（不改 C#）

1. 写一个 MCP 插件（如 `tools/mcp-xiaohongshu`），产出 `selection_source: xiaohongshu` 的商品；
2. 在本目录新增 `xhs_flow.yaml`，声明 `trigger_source: xiaohongshu` 和工序顺序；
3. 如需自动执行，实现 `IPipelineStageExecutor` 并在 DI 注册（`Code` = 工序 code）。

配方目录热加载：改 YAML 后无需重启，下一次请求即生效。目录可用 `Pipelines:ConfigPath` 覆盖
（默认相对 ContentRoot 的 `../../pipelines`）。

## 界面写入（指挥官 → 工作流管理）

编排器直接读写本目录的 YAML（保存后热加载，运行台立即生效）：

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `POST` | `/api/pipelines` | 新建配方（写入 `<pipeline_id>.yaml`，`stages` 顺序即链路，`next` 由服务端生成） |
| `PUT` | `/api/pipelines/{id}` | 更新配方（顺序 / 闸口开关 / 名称等） |
| `DELETE` | `/api/pipelines/{id}` | 删除配方（仍被 `sku_project` 引用时拒绝） |
| `GET` | `/api/pipelines/{id}/yaml` | 导出 YAML 文本 |
| `POST` | `/api/pipelines/preview` | 预览草稿生成的 YAML（不落盘） |
| `POST` | `/api/pipelines/import` | 导入 YAML（同 ID 覆盖） |

## 校验与排错

`GET /api/pipelines` 同时返回 `issues`：配方解析失败、`next` 悬空、环形链路、来源冲突、
闸口缺 `auto_rule`、自动工序缺 agent/skill 都会在这里如实列出，不会静默丢弃。
