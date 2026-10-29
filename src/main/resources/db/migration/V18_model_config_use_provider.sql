-- 旧模型保留独立密钥语义，避免自动切换到不同提供方的凭据。
ALTER TABLE model_config ADD COLUMN IF NOT EXISTS use_provider BOOLEAN NOT NULL DEFAULT FALSE;
