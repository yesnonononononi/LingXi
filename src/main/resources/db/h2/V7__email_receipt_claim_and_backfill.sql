-- ------------------------------------------------------------
-- V7：邮件回执的投递归属（租约）与历史回填
--
-- 一、为「已认领未交付」与「已交付」留出区分：
--     delivered_at 允许为空（空 = 已认领未交付），claim_execution_id / claimed_at 记录租约持有者与时刻。
--     持有者崩溃或冷启动后，租约过期即可被其他执行重新认领 —— 否则就是永久丢输入。
--
-- 二、历史回填：迁移这一刻已经存在的 status='CONSUMED' 邮件，视为旧版已消费事实。
--     依据只有这一条持久事实（旧版的消费动作就是把 status 置为 CONSUMED）；
--     不按时间戳猜、不读正文 CLOB、不依赖任何上游游标。
--
-- 只覆盖「迁移时已有历史」的前提：schema_version 每版本只登记一次，本脚本只执行一遍，
-- 因此之后新置为 CONSUMED 的行不会被回填 —— 那正是「清理先于检查点失败」的窗口，
-- 必须仍然被投递一次（判据是 delivered_at 为空）。
--
-- 幂等：id 取 message.id（消息 id 全局唯一），并带 NOT EXISTS 守卫；重跑不会重复插入。
-- ------------------------------------------------------------
ALTER TABLE email_message_receipt ALTER COLUMN delivered_at SET NULL;
ALTER TABLE email_message_receipt ALTER COLUMN delivered_at DROP DEFAULT;
ALTER TABLE email_message_receipt ADD COLUMN IF NOT EXISTS claim_execution_id VARCHAR(64) NULL;
ALTER TABLE email_message_receipt ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP(3) NULL;

INSERT INTO email_message_receipt
    (id, message_id, email_id, consumer_session_id, delivered_at, claim_execution_id, claimed_at)
SELECT m.id, m.id, m.email_id, NULL, m.create_at, NULL, NULL
FROM email_message m
WHERE m.status = 'CONSUMED'
  AND NOT EXISTS (SELECT 1 FROM email_message_receipt r WHERE r.message_id = m.id);
