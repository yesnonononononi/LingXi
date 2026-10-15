-- email / email_message 的「旧形状」：email_message 缺 dedup_key 列与 uk_email_message_dedup 唯一索引。
--
-- 为什么必须有这条：去重键是「子执行终结提醒只投一次」的裁决点，加列在 init.sql 里对
-- 已有库完全无效（CREATE TABLE IF NOT EXISTS 是空操作），只能靠迁移显式 ALTER + CREATE INDEX。
-- 少了迁移，症状是「主对话正常、一发生协作委派就报 Column "DEDUP_KEY" not found」。
CREATE TABLE email (
    id                    BIGINT   PRIMARY KEY,
    workflow_execution_id BIGINT   NOT NULL,
    recipient_agent_id    BIGINT   NOT NULL,
    team_id               BIGINT,
    status                INT      DEFAULT 1,
    create_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_email_workflow_recipient UNIQUE (workflow_execution_id, recipient_agent_id)
);

CREATE TABLE email_message (
    id        BIGINT      PRIMARY KEY,
    email_id  BIGINT      NOT NULL,
    sender_id BIGINT      NOT NULL,
    content   CLOB        NOT NULL,
    status    VARCHAR(16),
    create_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO email (id, workflow_execution_id, recipient_agent_id, team_id)
VALUES (8001, 7001, 10, 5);

INSERT INTO email_message (id, email_id, sender_id, content, status)
VALUES (9001, 8001, 10, '旧消息：补列不得丢数据', 'PENDING');
