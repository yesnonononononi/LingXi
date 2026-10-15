-- email_message 补「通知业务去重键」列。
--
-- 为什么必须有这个脚本：加列对「已有库」不能靠 init.sql（CREATE TABLE IF NOT EXISTS
-- 对已存在的表是空操作），必须显式 ALTER；是否执行由 H2SchemaInitializer 按 hasColumn 判定，天然幂等。
--
-- 旧库的 email_message 建于加列之前，缺这一列会让「查询待消费消息 / 插入通知邮件」整条
-- 链路报 Column "DEDUP_KEY" not found —— 通知投递发生在协作委派的子执行终结时，
-- 所以症状是「主对话正常、一委派就炸」。
ALTER TABLE email_message ADD COLUMN dedup_key VARCHAR(160) NULL;
