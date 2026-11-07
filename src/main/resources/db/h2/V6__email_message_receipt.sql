-- ------------------------------------------------------------
-- V6：邮件投递回执（全局消费归属）
--
-- 为什么需要它：「这封邮件已投递进模型上下文」原来是执行私有属性（游标），
-- 而信箱是会话级共享资源（键＝根会话＋收件 Agent），执行每轮新建 —— 新执行没有该属性，
-- 于是历史邮件被整段重放；同时 id 高水位并不能代表提交顺序。
-- 回执把「已投递」记在库里的逐条事实上：与执行、与 id 大小、与消息 status 都无关。
--
-- 边界：邮件行只改 status（展示态），不删除；回执才是权威判据。
-- message_id 唯一：同一封邮件只能被认领一次，重试/并发由唯一索引兜底。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_message_receipt (
    id                  BIGINT PRIMARY KEY,
    message_id          BIGINT NOT NULL,
    email_id            BIGINT NOT NULL,
    consumer_session_id BIGINT NULL,
    delivered_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_email_message_receipt_message ON email_message_receipt (message_id);
CREATE INDEX IF NOT EXISTS idx_email_message_receipt_email ON email_message_receipt (email_id);
