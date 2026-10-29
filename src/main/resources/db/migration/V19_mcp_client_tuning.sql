-- ============================================================================
-- V19：mcp 表补客户端容错参数（协议版本 / 自动健康检查 / 健康检查间隔 / 重连间隔）
-- ----------------------------------------------------------------------------
--   背景：这些参数此前在框架侧没有任何落点，客户端库只能按默认行为先发协议探测，
--         被 server 以 400 拒绝后无限重连，日志被 health-checker 刷屏。
--
--   四列全部可空，NULL 的语义是「沿用客户端库默认」，因此老数据行为与改造前完全一致。
--   IF NOT EXISTS 保证幂等：新库在 init.sql 已带列时本脚本是空操作。
-- ============================================================================

ALTER TABLE mcp ADD COLUMN IF NOT EXISTS protocol_version      VARCHAR(32) NULL COMMENT '显式协议版本，如 2025-11-25；NULL 表示走协议探测';
ALTER TABLE mcp ADD COLUMN IF NOT EXISTS auto_health_check     TINYINT     NULL COMMENT '自动健康检查开关；NULL 表示库默认(开启)';
ALTER TABLE mcp ADD COLUMN IF NOT EXISTS health_check_interval BIGINT      NULL COMMENT '健康检查间隔(毫秒)；NULL 表示库默认';
ALTER TABLE mcp ADD COLUMN IF NOT EXISTS reconnect_interval    BIGINT      NULL COMMENT '重连间隔(毫秒)；NULL 表示库默认';
