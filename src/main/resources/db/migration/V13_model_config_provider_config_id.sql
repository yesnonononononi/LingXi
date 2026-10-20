-- 模型归属提供商预设：老库的 model_config 建于该列之前，缺列会让模型列表查询直接报
-- Column "PROVIDER_CONFIG_ID" not found（新库由 init.sql 建表时自带，本条对它是空操作）。
ALTER TABLE model_config ADD COLUMN IF NOT EXISTS provider_config_id BIGINT DEFAULT NULL;

-- 聚合查询按提供商分组，非唯一索引足够；索引名与 init.sql 保持一致，已存在则跳过。
CREATE INDEX IF NOT EXISTS idx_model_config_provider ON model_config (provider_config_id);
