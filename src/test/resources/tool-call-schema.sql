-- H2 schema for tool_call persistence tests (mirrors init.sql's tool_call table).
DROP TABLE IF EXISTS tool_call;

CREATE TABLE tool_call (
    id                VARCHAR(64)  NOT NULL PRIMARY KEY,
    conversation_id   BIGINT       NOT NULL,
    session_message_id BIGINT,
    execution_id      BIGINT,
    tool_name         VARCHAR(100) NOT NULL,
    type              VARCHAR(16)  NOT NULL,
    status            VARCHAR(16)  NOT NULL,
    title             VARCHAR(500),
    content           CLOB,
    raw_input         CLOB,
    raw_output        CLOB,
    meta_data         CLOB,
    decision_command_id VARCHAR(64),
    decision_digest    VARCHAR(64),
    version           BIGINT NOT NULL DEFAULT 1,
    created_at        TIMESTAMP,
    updated_at        TIMESTAMP
);
