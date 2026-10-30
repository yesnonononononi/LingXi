-- user_configs.font_scale：界面全局字号档位。
--
-- 四档 SMALL/MEDIUM/LARGE/X_LARGE 对应前端 4 个字号档位；NULL 表示未设置，
-- 读取时归一为 MEDIUM（领域层兜底，不让前端各自猜默认值）。
-- 加列必须走迁移：init.sql 的 CREATE TABLE IF NOT EXISTS 对已有库是空操作。
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS font_scale VARCHAR(16) DEFAULT NULL COMMENT '界面全局字号档位: SMALL/MEDIUM/LARGE/X_LARGE; 空表示未设置(读取归一为 MEDIUM)';
