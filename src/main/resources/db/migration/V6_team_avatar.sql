-- team 表补头像列。
--
-- 为什么必须有这个脚本：加列对「已有库」不能靠 init.sql（CREATE TABLE IF NOT EXISTS
-- 是空操作），必须显式 ALTER；是否执行由 H2SchemaInitializer 按 hasColumn 判定，天然幂等。
ALTER TABLE team ADD COLUMN avatar VARCHAR(255);
