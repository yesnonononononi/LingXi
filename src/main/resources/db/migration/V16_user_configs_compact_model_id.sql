-- user_configs.compact_model_id：专用压缩模型。
--
-- 为空表示沿用对话模型做摘要（框架 reuseModelForCompaction=true 的既有行为）；
-- 指向 model_config.id 时，聊天请求带上独立的 compactModel，摘要不再复用对话模型。
-- 加列必须走迁移：init.sql 的 CREATE TABLE IF NOT EXISTS 对已有库是空操作。
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS compact_model_id BIGINT DEFAULT NULL;
