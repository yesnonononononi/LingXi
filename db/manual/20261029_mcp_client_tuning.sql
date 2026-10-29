-- ============================================================================
-- 手工迁移（非 Flyway 自动执行）：mcp 表补客户端容错参数
-- ----------------------------------------------------------------------------
-- 供内网 MySQL 环境手工执行；桌面端（H2）由 H2SchemaInitializer 自动执行
-- db/migration/V19_mcp_client_tuning.sql，无需手工介入。
--
-- 四列均可空，NULL 语义 = 沿用 MCP 客户端库默认值，因此存量行行为与改造前完全一致：
--   protocol_version      显式协议版本，如 2025-11-25；NULL 表示走协议探测
--   auto_health_check     自动健康检查开关；NULL 表示库默认（开启）
--   health_check_interval 健康检查间隔（毫秒）；NULL 表示库默认
--   reconnect_interval    重连间隔（毫秒）；NULL 表示库默认
--
-- 幂等：执行前先查 information_schema，列已存在则跳过，可重复执行。
-- ============================================================================

SET @schema_name = DATABASE();

SET @has_protocol_version = (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @schema_name AND TABLE_NAME = 'mcp' AND COLUMN_NAME = 'protocol_version');
SET @sql = IF(@has_protocol_version = 0,
    'ALTER TABLE mcp ADD COLUMN protocol_version VARCHAR(32) NULL COMMENT ''显式协议版本，如 2025-11-25；NULL 表示走协议探测''',
    'SELECT ''protocol_version already exists''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_auto_health_check = (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @schema_name AND TABLE_NAME = 'mcp' AND COLUMN_NAME = 'auto_health_check');
SET @sql = IF(@has_auto_health_check = 0,
    'ALTER TABLE mcp ADD COLUMN auto_health_check TINYINT NULL COMMENT ''自动健康检查开关；NULL 表示库默认(开启)''',
    'SELECT ''auto_health_check already exists''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_health_check_interval = (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @schema_name AND TABLE_NAME = 'mcp' AND COLUMN_NAME = 'health_check_interval');
SET @sql = IF(@has_health_check_interval = 0,
    'ALTER TABLE mcp ADD COLUMN health_check_interval BIGINT NULL COMMENT ''健康检查间隔(毫秒)；NULL 表示库默认''',
    'SELECT ''health_check_interval already exists''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_reconnect_interval = (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @schema_name AND TABLE_NAME = 'mcp' AND COLUMN_NAME = 'reconnect_interval');
SET @sql = IF(@has_reconnect_interval = 0,
    'ALTER TABLE mcp ADD COLUMN reconnect_interval BIGINT NULL COMMENT ''重连间隔(毫秒)；NULL 表示库默认''',
    'SELECT ''reconnect_interval already exists''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
