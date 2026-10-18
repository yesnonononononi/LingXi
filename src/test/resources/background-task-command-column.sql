-- 老库形状：列名还是 command（改名前的形状），并带一行存量数据，用于验证改名迁移不丢数据。
DROP TABLE task;
CREATE TABLE task (
    id BIGINT PRIMARY KEY, session_id BIGINT NOT NULL, turn_id BIGINT NOT NULL,
    command LONGTEXT NOT NULL, intention VARCHAR(500), output LONGTEXT, status VARCHAR(32) NOT NULL,
    exit_code INTEGER, truncated BOOLEAN NOT NULL DEFAULT FALSE,
    create_at TIMESTAMP NOT NULL, complete_at TIMESTAMP
);
INSERT INTO task (id, session_id, turn_id, command, status, truncated, create_at)
VALUES (10, 10, 20, '原始命令', 'SUCCESS', FALSE, CURRENT_TIMESTAMP);
