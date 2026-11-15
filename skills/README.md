# Skill SOP（技能）配置

每个技能一个 YAML 文件：`skills/<code>.yaml`。保存后 `SkillCatalog` 热加载，下一次 Agent 运行立即生效。

```yaml
code: price-negotiation-sop   # 唯一标识，小写字母/数字/-/_
name: 寻源议价
description: 1688 以图搜同款、多供应商比价与阶梯价谈判
agent: sourcing               # 授权执行 Agent（agents.yaml key）
enabled: true
trigger_mode: chat            # chat | auto | both（both = Chat 与自动管线都支持）
allowed_tools:                # 精确切片：serverId.tool / serverId.* / *
  - mcp-1688.search_products
  - mcp-1688.get_offer
prompt: |                     # SOP，运行时拼进该 Agent 的 System Prompt
  ...
temperature: 0.3
max_output_tokens: 3000
retry: 2
```

约束：

- `allowed_tools` 与 Agent 名册的 `allowedTools` 取交集；技能不能提权。
- 未指定 `allowed_tools` 时该技能不获得任何工具（只做纯 Prompt SOP）。
- 保存/删除/启停都会写文件并 `ReloadNow()`，无需重启 API。
- 管理界面：指挥官 → 左轨「Skill 技能」。
