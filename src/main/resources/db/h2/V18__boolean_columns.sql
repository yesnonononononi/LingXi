-- V18：将历史从 SQLite 沿用的 INTEGER 布尔列统一改为 H2 原生 BOOLEAN。
--
-- H2 2.5.252 默认 MODE=REGULAR 下，BOOLEAN 参数与 INTEGER 列不可比较：
-- 首次 prepare 时参数类型未知会放行，一旦中间发生任意 DDL 抬高元数据版本、
-- 触发语句重编译（recompileIfRequired），已绑定的 BOOLEAN 参数就会正面撞上 INTEGER 列
-- 抛出 90110（Cannot compare values of types "INTEGER" and "BOOLEAN"）。
--
-- 本脚本把所有 PO 为 boolean/Boolean、但建表时写成 INTEGER 的列一次性根治为 BOOLEAN，
-- 并显式重申 DEFAULT 与 NULL/NOT NULL 约束，保证脚本可重入。

-- 1. session.is_read（原 INTEGER NOT NULL DEFAULT 1）
ALTER TABLE session ALTER COLUMN is_read SET DATA TYPE BOOLEAN;
ALTER TABLE session ALTER COLUMN is_read SET DEFAULT TRUE;
ALTER TABLE session ALTER COLUMN is_read SET NOT NULL;

-- 2. model_config.vision / use_provider（原 INTEGER NOT NULL DEFAULT 0）
ALTER TABLE model_config ALTER COLUMN vision SET DATA TYPE BOOLEAN;
ALTER TABLE model_config ALTER COLUMN vision SET DEFAULT FALSE;
ALTER TABLE model_config ALTER COLUMN vision SET NOT NULL;

ALTER TABLE model_config ALTER COLUMN use_provider SET DATA TYPE BOOLEAN;
ALTER TABLE model_config ALTER COLUMN use_provider SET DEFAULT FALSE;
ALTER TABLE model_config ALTER COLUMN use_provider SET NOT NULL;

-- 3. mcp.auto_health_check（原 INTEGER NULL）
ALTER TABLE mcp ALTER COLUMN auto_health_check SET DATA TYPE BOOLEAN;
ALTER TABLE mcp ALTER COLUMN auto_health_check SET NULL;

-- 4. task.truncated（原 INTEGER NOT NULL DEFAULT 0）
ALTER TABLE task ALTER COLUMN truncated SET DATA TYPE BOOLEAN;
ALTER TABLE task ALTER COLUMN truncated SET DEFAULT FALSE;
ALTER TABLE task ALTER COLUMN truncated SET NOT NULL;

-- 5. checklist.remind_status（原 INTEGER NOT NULL DEFAULT 0）
ALTER TABLE checklist ALTER COLUMN remind_status SET DATA TYPE BOOLEAN;
ALTER TABLE checklist ALTER COLUMN remind_status SET DEFAULT FALSE;
ALTER TABLE checklist ALTER COLUMN remind_status SET NOT NULL;
