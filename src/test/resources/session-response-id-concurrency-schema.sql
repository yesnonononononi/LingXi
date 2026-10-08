-- H2 schema for the responseId concurrency test (session + session_message only).
--
-- 只建两张与并发落库相关的表：session 是落库前要锁的行（SELECT ... FOR UPDATE），
-- session_message 承载 uk_session_response_id 唯一索引 —— 竞态存在时，唯一索引是最后一道防线，
-- 用例必须能观察到它被触发（而非被应用层拦掉却无人知道）。
DROP TABLE IF EXISTS session;
DROP TABLE IF EXISTS session_message;

CREATE TABLE session (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    root_session_id BIGINT DEFAULT 0,
    agent_id        BIGINT,
    name            VARCHAR(100),
    create_time     TIMESTAMP,
    update_time     TIMESTAMP
);

CREATE TABLE session_message (
    id             BIGINT      NOT NULL PRIMARY KEY,
    response_id    VARCHAR(36) NULL,
    session_id     BIGINT      NOT NULL,
    turn_id        BIGINT      NULL,
    response_order INT         NULL,
    type           VARCHAR(16) NOT NULL,
    content        CLOB        NOT NULL,
    create_time    TIMESTAMP(3) NULL,
    update_time    TIMESTAMP(3) NULL
);

-- 与 init.sql 一致：同一 (session_id, response_id) 只允许一行。
ALTER TABLE session_message ADD CONSTRAINT uk_session_response_id UNIQUE (session_id, response_id);
