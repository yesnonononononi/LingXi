-- H2 schema for email tests (mirrors init.sql's email / email_message tables).
-- H2 无 ENUM/ON UPDATE 语法：status 用 VARCHAR(16) 等价承载，update_at 由领域层维护。
-- 邮箱业务键 (workflow_execution_id, recipient_agent_id) 上的唯一约束与 MySQL 侧
-- uk_email_workflow_recipient 等价，用于验证并发首次建箱的竞争行为。
DROP TABLE IF EXISTS email_message;
DROP TABLE IF EXISTS email;

CREATE TABLE email (
    id                    BIGINT       PRIMARY KEY,
    workflow_execution_id BIGINT       NOT NULL,
    recipient_agent_id    BIGINT       NOT NULL,
    team_id               BIGINT,
    status                INT          DEFAULT 1,
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

CREATE INDEX idx_email_message_inbox ON email_message (email_id, status, create_at, id);
