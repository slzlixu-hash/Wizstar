-- =============================================================================
-- AgentWorkBench 多智能体电商协同平台 · 完整数据库结构 v2.0
-- 引擎：MySQL 8.4 (InnoDB, utf8mb4_0900_ai_ci)
-- 说明：全部 CREATE TABLE IF NOT EXISTS，可重复执行（幂等，只建不改）
-- 6 大域 23 张表：商品供应链(7) / 店铺风控(2) / 订单履约(3) /
--                  MAF 智能体(5) / MCP 网关(2) / 系统底座(4)
-- 来源：agentworkbench_database_schema.md（用户提供的设计规范 v2.0）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 一、商品与供应链域 (7)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `selection_batch` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `batch_id` VARCHAR(64) NOT NULL COMMENT '批次唯一号 (如 batch_20261111_01)',
  `batch_name` VARCHAR(128) NOT NULL COMMENT '批次名称 (如 冬季家居保温杯测款)',
  `selection_source` VARCHAR(32) NOT NULL COMMENT '主要选品来源: douyin_compass|jushuitan|ai_autonomous',
  `target_category` VARCHAR(64) DEFAULT NULL COMMENT '目标类目',
  `target_count` INT NOT NULL DEFAULT 20 COMMENT '计划测款数量',
  `completed_count` INT NOT NULL DEFAULT 0 COMMENT '已完成数',
  `status` VARCHAR(32) NOT NULL DEFAULT 'running' COMMENT 'running|paused|completed|failed',
  `created_by` VARCHAR(64) DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_batch_id` (`batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='测款批次任务表';

CREATE TABLE IF NOT EXISTS `sku_project` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `project_no` VARCHAR(64) NOT NULL COMMENT '业务流水号 (如 SP20261111-0001)',
  `batch_id` VARCHAR(64) DEFAULT NULL COMMENT '所属测款批次号',
  `title` VARCHAR(255) NOT NULL COMMENT '商品基准标题',
  `category_name` VARCHAR(64) DEFAULT NULL COMMENT '标准类目名称',
  `selection_source` VARCHAR(32) NOT NULL DEFAULT 'ai_autonomous' COMMENT '选品来源: douyin_compass|jushuitan|ai_autonomous|manual',
  `status` VARCHAR(32) NOT NULL DEFAULT 'scouted' COMMENT 'scouted|sourced|creative_ready|pending_review|published|error|archived',
  `min_cost` DECIMAL(10, 2) NOT NULL DEFAULT 0.00 COMMENT '最低 1688 采购成本',
  `suggested_price` DECIMAL(10, 2) NOT NULL DEFAULT 0.00 COMMENT '建议零售基准价',
  `avg_margin_rate` DECIMAL(5, 2) NOT NULL DEFAULT 0.00 COMMENT '预估平均毛利率 (%)',
  `cover_image_url` VARCHAR(512) DEFAULT NULL COMMENT '封面主图缩略图 URL',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_project_no` (`project_no`),
  KEY `idx_status_batch` (`status`, `batch_id`),
  KEY `idx_selection_source` (`selection_source`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='商品立项主表';

CREATE TABLE IF NOT EXISTS `sku_sourcing` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `project_id` BIGINT NOT NULL COMMENT '关联 sku_project.id',
  `supplier_platform` VARCHAR(32) NOT NULL DEFAULT '1688' COMMENT '供货平台: 1688|pinduoduo|jushuitan_erp',
  `supplier_shop_name` VARCHAR(128) NOT NULL COMMENT '供应商店铺/工厂名称',
  `supplier_shop_url` VARCHAR(512) DEFAULT NULL COMMENT '1688 供应商店铺主页直达链接',
  `supplier_offer_id` VARCHAR(64) NOT NULL COMMENT '货源商品唯一 Offer ID',
  `supplier_offer_url` VARCHAR(512) DEFAULT NULL COMMENT '1688 货源商品详情页链接',
  `factory_score` DECIMAL(3, 2) DEFAULT NULL COMMENT '工厂综合评分',
  `min_order_quantity` INT NOT NULL DEFAULT 1 COMMENT '起订量',
  `shipping_fee` DECIMAL(10, 2) NOT NULL DEFAULT 0.00 COMMENT '首件采购运费',
  `dispatch_address` VARCHAR(128) DEFAULT NULL COMMENT '工厂发货地',
  `is_primary` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否为当前选定的主供应商',
  `raw_payload_json` JSON DEFAULT NULL COMMENT '抓取的原始响应快照',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_project_id` (`project_id`),
  KEY `idx_offer_id` (`supplier_offer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='商品货源供应链维表';

CREATE TABLE IF NOT EXISTS `sku_media` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `project_id` BIGINT NOT NULL COMMENT '关联 sku_project.id',
  `media_type` VARCHAR(32) NOT NULL COMMENT 'image_main|image_detail|video_source|video_generated',
  `source_type` VARCHAR(32) NOT NULL DEFAULT 'ai_generated' COMMENT 'raw_1688|ai_generated|manual',
  `url` VARCHAR(512) NOT NULL COMMENT 'OSS/CDN 文件访问 URL',
  `thumbnail_url` VARCHAR(512) DEFAULT NULL COMMENT '封面缩略图 URL',
  `sort_order` INT NOT NULL DEFAULT 0 COMMENT '排序权重 (升序)',
  `is_cover` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否封面图',
  `width` INT DEFAULT NULL,
  `height` INT DEFAULT NULL,
  `duration_sec` INT DEFAULT NULL COMMENT '视频时长 (秒)',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_project_media` (`project_id`, `media_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='商品多媒体资源维表';

CREATE TABLE IF NOT EXISTS `sku_variant` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `project_id` BIGINT NOT NULL COMMENT '关联 sku_project.id',
  `spec_name` VARCHAR(128) NOT NULL COMMENT '规格名称 (如 颜色:曜石黑;容量:500ml)',
  `sku_code` VARCHAR(64) DEFAULT NULL COMMENT '内部自编 SKU 编码',
  `source_sku_id` VARCHAR(64) DEFAULT NULL COMMENT '1688 源头对应规格 ID',
  `cost_price` DECIMAL(10, 2) NOT NULL COMMENT '该规格采购成本',
  `selling_price` DECIMAL(10, 2) NOT NULL COMMENT '该规格建议/执行售价',
  `margin_rate` DECIMAL(5, 2) NOT NULL COMMENT '该规格毛利率 (%)',
  `stock_quantity` INT NOT NULL DEFAULT 999 COMMENT '可用同步库存',
  `spec_image_url` VARCHAR(512) DEFAULT NULL COMMENT '规格 SKU 小图',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_project_id` (`project_id`),
  KEY `idx_sku_code` (`sku_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='商品规格变体维表';

CREATE TABLE IF NOT EXISTS `sku_channel_listing` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `project_id` BIGINT NOT NULL COMMENT '关联 sku_project.id',
  `shop_id` VARCHAR(64) NOT NULL COMMENT '目标店铺 ID (关联 store_instance.shop_id)',
  `platform` VARCHAR(32) NOT NULL COMMENT 'weixin_shop|douyin|pinduoduo',
  `online_product_id` VARCHAR(128) DEFAULT NULL COMMENT '平台返回的真实商品 ID',
  `channel_category_id` VARCHAR(64) DEFAULT NULL COMMENT '平台绑定类目 ID',
  `channel_title` VARCHAR(255) DEFAULT NULL COMMENT '针对该店铺排重优化后的标题',
  `channel_status` VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT 'pending|auditing|online|rejected|delisted',
  `online_price` DECIMAL(10, 2) DEFAULT NULL COMMENT '该店铺实际线上标价',
  `audit_reject_reason` VARCHAR(255) DEFAULT NULL COMMENT '平台驳回原因',
  `published_at` DATETIME DEFAULT NULL,
  `last_sync_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_shop_project` (`shop_id`, `project_id`),
  KEY `idx_online_product` (`online_product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='商品多店铺刊登维表';

CREATE TABLE IF NOT EXISTS `sku_pipeline_audit` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `project_id` BIGINT NOT NULL,
  `agent_key` VARCHAR(32) NOT NULL COMMENT 'scout|sourcing|creative|publisher|analyst|human',
  `step_code` VARCHAR(64) NOT NULL COMMENT 'trend_score|1688_match|image_blend|hitl_review|publish_execute',
  `status` VARCHAR(32) NOT NULL COMMENT 'started|success|failed|pending_approval|approved|rejected',
  `operator` VARCHAR(64) DEFAULT NULL COMMENT '操作员账号 (人工审批时必填)',
  `notes` VARCHAR(512) DEFAULT NULL COMMENT '执行说明或驳回原因',
  `elapsed_ms` INT DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_project_step` (`project_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='流水线与质检审计表';

-- -----------------------------------------------------------------------------
-- 二、店铺矩阵与防封风控域 (2)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `store_instance` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `shop_id` VARCHAR(64) NOT NULL COMMENT '系统内店铺唯一标识',
  `shop_name` VARCHAR(64) NOT NULL COMMENT '店铺显示名 (如 微信小店·旗舰店)',
  `platform` VARCHAR(32) NOT NULL COMMENT 'weixin_shop|douyin|pinduoduo',
  `auth_status` VARCHAR(32) NOT NULL DEFAULT 'valid' COMMENT 'valid|expiring|expired',
  `app_id` VARCHAR(128) NOT NULL COMMENT '开放平台 AppID',
  `app_secret_cipher` VARBINARY(512) DEFAULT NULL COMMENT 'AES-256-GCM 密文存储的 AppSecret',
  `browser_env_id` VARCHAR(64) DEFAULT NULL COMMENT '绑定的比特浏览器环境编号',
  `daily_listing_limit` INT NOT NULL DEFAULT 30 COMMENT '单日刊登安全上限',
  `dsr_score` DECIMAL(3, 2) NOT NULL DEFAULT 4.80 COMMENT '店铺综合评分',
  `settings_json` JSON DEFAULT NULL COMMENT '店铺默认加价公式、运费模板、退货地址',
  `last_sync_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_shop_id` (`shop_id`),
  KEY `idx_platform` (`platform`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='店铺矩阵管理表';

CREATE TABLE IF NOT EXISTS `store_daily_quota` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `shop_id` VARCHAR(64) NOT NULL,
  `quota_date` DATE NOT NULL COMMENT '统计日期 (YYYY-MM-DD)',
  `listed_count` INT NOT NULL DEFAULT 0 COMMENT '当日已成功刊登数',
  `limit_snapshot` INT NOT NULL DEFAULT 30 COMMENT '当日安全上限快照',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_shop_date` (`shop_id`, `quota_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='店铺每日刊登配额水线表';

-- -----------------------------------------------------------------------------
-- 三、订单与代发履约域 (3)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `ecom_order` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `platform_order_id` VARCHAR(128) NOT NULL COMMENT '微信小店/抖店原始订单号',
  `shop_id` VARCHAR(64) NOT NULL COMMENT '所属店铺 ID',
  `platform` VARCHAR(32) NOT NULL COMMENT 'weixin_shop|douyin|pinduoduo',
  `buyer_name_masked` VARCHAR(64) DEFAULT NULL COMMENT '脱敏收件人 (如 王**)',
  `buyer_phone_masked` VARCHAR(32) DEFAULT NULL COMMENT '脱敏手机 (如 138****8888)',
  `receiver_region` VARCHAR(128) DEFAULT NULL COMMENT '省市区地址摘要',
  `receiver_cipher` VARBINARY(1024) DEFAULT NULL COMMENT 'AES-256-GCM 加密的完整收件地址/电话',
  `order_amount` DECIMAL(10, 2) NOT NULL COMMENT '买家实付金额',
  `total_cost` DECIMAL(10, 2) NOT NULL DEFAULT 0.00 COMMENT '1688 采购总成本 (含采购运费)',
  `estimated_profit` DECIMAL(10, 2) NOT NULL DEFAULT 0.00 COMMENT '预估单笔净利润',
  `fulfillment_status` VARCHAR(32) NOT NULL DEFAULT 'pending_purchase' COMMENT 'pending_purchase|purchasing|awaiting_tracking|shipped|refund_intercepted|error',
  `aftersale_status` VARCHAR(32) NOT NULL DEFAULT 'none' COMMENT 'none|refund_requested|intercepted|closed',
  `paid_at` DATETIME DEFAULT NULL COMMENT '买家付款时间',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_shop_order` (`shop_id`, `platform_order_id`),
  KEY `idx_fulfillment_status` (`fulfillment_status`, `paid_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='全渠道聚合订单主表';

CREATE TABLE IF NOT EXISTS `ecom_order_item` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `order_id` BIGINT NOT NULL COMMENT '关联 ecom_order.id',
  `project_id` BIGINT DEFAULT NULL COMMENT '关联 sku_project.id',
  `variant_id` BIGINT DEFAULT NULL COMMENT '关联 sku_variant.id',
  `online_product_id` VARCHAR(128) DEFAULT NULL,
  `title` VARCHAR(255) NOT NULL,
  `spec_name` VARCHAR(128) DEFAULT NULL,
  `quantity` INT NOT NULL DEFAULT 1,
  `unit_price` DECIMAL(10, 2) NOT NULL COMMENT '买家购买单价',
  `unit_cost` DECIMAL(10, 2) NOT NULL DEFAULT 0.00 COMMENT '对应 1688 采购单价',
  PRIMARY KEY (`id`),
  KEY `idx_order_id` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='订单商品明细表';

CREATE TABLE IF NOT EXISTS `fulfillment_procurement` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `order_id` BIGINT NOT NULL COMMENT '关联 ecom_order.id',
  `source_platform` VARCHAR(32) NOT NULL DEFAULT '1688',
  `source_order_id` VARCHAR(128) DEFAULT NULL COMMENT '1688 生成的真实采购单号',
  `procurement_amount` DECIMAL(10, 2) DEFAULT NULL COMMENT '实际 1688 采购付款金额',
  `procurement_status` VARCHAR(32) NOT NULL DEFAULT 'created' COMMENT 'created|paid|shipped|cancelled|failed',
  `express_company` VARCHAR(64) DEFAULT NULL COMMENT '快递公司 (如 中通快递)',
  `tracking_number` VARCHAR(128) DEFAULT NULL COMMENT '快递运单号',
  `synced_to_shop` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已回填至微信小店/抖店',
  `synced_at` DATETIME DEFAULT NULL,
  `operation_id` VARCHAR(128) DEFAULT NULL COMMENT '关联 mcp_call_audit 幂等流水号',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_order_id` (`order_id`),
  KEY `idx_source_order` (`source_order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='1688代发采购与物流回填表';

-- -----------------------------------------------------------------------------
-- 四、MAF 智能体与记忆自学习域 (5)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `agent_registry` (
  `agent_key` VARCHAR(32) NOT NULL COMMENT 'commander|selection|sourcing|creative|publisher|analyst',
  `display_name` VARCHAR(64) NOT NULL COMMENT '中文名称 (如 选品专员)',
  `role_summary` VARCHAR(255) NOT NULL COMMENT '核心业务职责',
  `avatar` VARCHAR(255) DEFAULT NULL,
  `runtime_status` VARCHAR(16) NOT NULL DEFAULT 'idle' COMMENT 'idle|working|error',
  `status_source` VARCHAR(64) DEFAULT NULL,
  `default_model_id` VARCHAR(64) DEFAULT NULL COMMENT '绑定的专属默认模型 (如 deepseek-chat)',
  `capabilities_json` JSON DEFAULT NULL COMMENT '能力标签列表',
  `is_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`agent_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='MAF智能体团队注册表';

CREATE TABLE IF NOT EXISTS `agent_context_setting` (
  `agent_key` VARCHAR(32) NOT NULL,
  `max_memory_chars` INT NOT NULL DEFAULT 4000 COMMENT '长期规则注入字符上限',
  `max_knowledge_chars` INT NOT NULL DEFAULT 4000 COMMENT '知识库注入字符上限',
  `enable_l1_extraction` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否开启显式记忆提取',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`agent_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Agent上下文设置表';

CREATE TABLE IF NOT EXISTS `agent_memory` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `agent_key` VARCHAR(32) NOT NULL,
  `subject` VARCHAR(128) NOT NULL COMMENT '规则主题 (如 微信小店类目)',
  `metric` VARCHAR(128) DEFAULT NULL COMMENT '指标/条件 (如 标题敏感词)',
  `value_text` TEXT NOT NULL COMMENT '规则事实正文',
  `confidence` DECIMAL(3, 2) NOT NULL DEFAULT 0.90 COMMENT '置信度 (0.00-1.00)',
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending|confirmed|archived',
  `source_type` VARCHAR(32) NOT NULL DEFAULT 'manual' COMMENT 'manual|rule|reflection',
  `source_ref` VARCHAR(128) DEFAULT NULL COMMENT '来源追溯 (如 sku_project:1024)',
  `verified_by` VARCHAR(64) DEFAULT NULL COMMENT '人工确认操作员',
  `verified_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_agent_status` (`agent_key`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Agent长期规则记忆表';

CREATE TABLE IF NOT EXISTS `agent_knowledge_item` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `agent_key` VARCHAR(32) NOT NULL,
  `title` VARCHAR(128) NOT NULL,
  `tags` VARCHAR(255) DEFAULT NULL COMMENT '逗号分隔检索标签',
  `content` TEXT NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_agent_key` (`agent_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Agent本地知识库表';

CREATE TABLE IF NOT EXISTS `agent_context_snapshot` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `agent_key` VARCHAR(32) NOT NULL,
  `session_id` VARCHAR(64) NOT NULL,
  `injected_memory_ids` JSON DEFAULT NULL COMMENT '本次实际注入的 memory#id 列表',
  `injected_knowledge_ids` JSON DEFAULT NULL COMMENT '本次实际注入的 knowledge#id 列表',
  `total_chars` INT NOT NULL DEFAULT 0,
  `truncated` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否触发字符预算截断',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_agent_session` (`agent_key`, `session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='上下文注入白盒审计快照表';

-- -----------------------------------------------------------------------------
-- 五、MCP 服务网关与审批审计域 (2)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `mcp_server_binding` (
  `server_id` VARCHAR(64) NOT NULL COMMENT '如 supplier-1688 | weixin-shop-openapi',
  `display_name` VARCHAR(128) NOT NULL,
  `description` VARCHAR(255) DEFAULT NULL,
  `transport` VARCHAR(16) NOT NULL DEFAULT 'http' COMMENT 'http|stdio|stub',
  `endpoint` VARCHAR(255) DEFAULT NULL COMMENT '如 http://127.0.0.1:5207',
  `api_key_cipher` VARBINARY(512) DEFAULT NULL COMMENT 'AES-256-GCM 加密的 HMAC Secret',
  `risk_level` VARCHAR(16) NOT NULL DEFAULT 'read' COMMENT 'read|write|irreversible',
  `authorized_agents_json` JSON DEFAULT NULL COMMENT '授权调用的 agent_key 数组',
  `tools_json` LONGTEXT DEFAULT NULL COMMENT '握手缓存的工具 Schema 列表',
  `tools_count` INT NOT NULL DEFAULT 0,
  `connection_state` VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT 'connected|pending|error',
  `last_connected_at` DATETIME DEFAULT NULL,
  `last_connect_error` VARCHAR(512) DEFAULT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`server_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='MCP服务绑定与工具缓存表';

CREATE TABLE IF NOT EXISTS `mcp_call_audit` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `operation_id` VARCHAR(128) NOT NULL COMMENT '全局幂等流水号 (op-{taskId}-{step}-{hash16})',
  `server_id` VARCHAR(64) NOT NULL,
  `tool_name` VARCHAR(128) NOT NULL,
  `agent_key` VARCHAR(32) NOT NULL,
  `project_id` BIGINT DEFAULT NULL COMMENT '关联的商品 ID (若有)',
  `mode` VARCHAR(16) NOT NULL DEFAULT 'dry_run' COMMENT 'dry_run|live',
  `risk_level` VARCHAR(16) NOT NULL DEFAULT 'read',
  `args_json` JSON DEFAULT NULL,
  `args_digest` VARCHAR(64) NOT NULL COMMENT '入参 SHA-256 指纹 (防止审批后参数被篡改)',
  `status` VARCHAR(32) NOT NULL COMMENT 'pending_approval|executed|rejected|failed',
  `approved_by` VARCHAR(64) DEFAULT NULL,
  `approved_at` DATETIME DEFAULT NULL,
  `response_envelope_json` LONGTEXT DEFAULT NULL,
  `elapsed_ms` INT DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_operation_id` (`operation_id`),
  KEY `idx_status_created` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='MCP工具调用与HITL审批审计表';

-- -----------------------------------------------------------------------------
-- 六、系统底座与模型风控域 (4)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `sys_user` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(64) NOT NULL COMMENT '账号 / 手机号',
  `password_hash` VARCHAR(255) NOT NULL COMMENT 'PBKDF2 / BCrypt 哈希',
  `display_name` VARCHAR(64) NOT NULL,
  `role` VARCHAR(32) NOT NULL DEFAULT 'operator' COMMENT 'admin|operator|viewer',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `last_login_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='系统操作员账号表';

CREATE TABLE IF NOT EXISTS `llm_provider` (
  `provider_code` VARCHAR(32) NOT NULL COMMENT 'deepseek|ollama|custom_xxx',
  `display_name` VARCHAR(64) NOT NULL,
  `base_url` VARCHAR(255) NOT NULL,
  `api_key_cipher` VARBINARY(512) DEFAULT NULL COMMENT 'AES-256-GCM 密文',
  `api_key_hint` VARCHAR(32) DEFAULT NULL COMMENT '掩码回显 (如 sk-****7a9c)',
  `is_seed` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '内置种子禁删标记',
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`provider_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='大模型供应商配置表';

CREATE TABLE IF NOT EXISTS `llm_model_definition` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `provider_code` VARCHAR(32) NOT NULL,
  `model_id` VARCHAR(64) NOT NULL COMMENT '如 deepseek-chat | deepseek-reasoner',
  `display_name` VARCHAR(64) NOT NULL,
  `is_default_global` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否全局默认主力模型',
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_provider_model` (`provider_code`, `model_id`),
  CONSTRAINT `fk_model_provider` FOREIGN KEY (`provider_code`) REFERENCES `llm_provider` (`provider_code`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='模型定义表';

CREATE TABLE IF NOT EXISTS `sys_risk_policy` (
  `policy_key` VARCHAR(64) NOT NULL COMMENT '如 min_margin_threshold | daily_media_budget_cents',
  `policy_name` VARCHAR(128) NOT NULL,
  `policy_value` VARCHAR(128) NOT NULL,
  `description` VARCHAR(255) DEFAULT NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`policy_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='全局风控与预算策略表';
