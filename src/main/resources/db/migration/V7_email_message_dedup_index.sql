-- dedup_key 的唯一索引：它是「子执行终结提醒只投一次」的真正裁决点。
--
-- EmailServiceImpl#sendMailOnce 插入后靠 DuplicateKeyException 判定「已投递过」并回查旧消息；
-- 少了这个索引，去重逻辑会静默退化成「每次都投」，重复提醒会直接进收件箱。
-- 所以 V7 必须「列 + 索引」一起补，只补列等于把去重关掉。
--
-- 普通邮件没有去重键（dedup_key 为 NULL），H2 唯一索引允许多行 NULL，不会挡住它们。
CREATE UNIQUE INDEX uk_email_message_dedup ON email_message (dedup_key);
