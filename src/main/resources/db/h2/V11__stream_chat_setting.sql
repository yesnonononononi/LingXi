-- 普通模型请求的流式输出开关：空值表示未设置（读取归一为 true，即保持历史流式行为）。
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS stream_chat BOOLEAN DEFAULT TRUE;
