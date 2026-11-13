-- V17：放宽 session_token_audit_item.category 到 VARCHAR(32)。
--
-- V8 给的是 VARCHAR(16)，而现有最长取值 DYNAMIC_CONTEXT 已经占 15 个字符 —— 只余 1 字节。
-- 再加一个更长的类别名（或给现有类别加前缀后缀）就会在入库时截断/报错，而单测跑的是内存假仓储，
-- 不会红。这里把余量一次放到 32，给「消息分项」这一层的命名留出空间。
--
-- 只改宽度：历史数据无需回填。NOT NULL 再显式声明一次，避免 H2 在 SET DATA TYPE 时
-- 对约束的保留行为随版本变化。
ALTER TABLE session_token_audit_item ALTER COLUMN category SET DATA TYPE VARCHAR(32);
ALTER TABLE session_token_audit_item ALTER COLUMN category SET NOT NULL;
