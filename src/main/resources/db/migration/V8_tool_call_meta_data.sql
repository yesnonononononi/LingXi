-- tool_call.meta_data：扩展元数据 _meta。
--
-- 为什么必须有这个脚本：该列 2026-10-05 才补进 init.sql，而加列对「已有库」不能靠 init.sql
-- （CREATE TABLE IF NOT EXISTS 是空操作），必须显式 ALTER；是否执行由 H2SchemaInitializer
-- 按 hasColumn 逐列判定，天然幂等（旧库缺列则补、新库已有则跳过）。
--
-- 缺列的后果是**运行期** MyBatis 生成的全字段 SQL 报 Column "META_DATA" not found，
-- 新库与单测全绿、看不出来 —— 只能靠这条迁移兜住。
ALTER TABLE tool_call ADD COLUMN meta_data CLOB;
