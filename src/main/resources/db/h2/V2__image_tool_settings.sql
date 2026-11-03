ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS image_model_id BIGINT;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS image_generation_max_calls INTEGER DEFAULT 3;
