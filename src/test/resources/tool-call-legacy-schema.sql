CREATE TABLE tool_call (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    conversation_id BIGINT NOT NULL,
    session_message_id BIGINT,
    execution_id BIGINT,
    tool_name VARCHAR(100) NOT NULL,
    type VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL,
    title VARCHAR(500),
    content CLOB,
    raw_input CLOB,
    raw_output CLOB,
    meta_data CLOB,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

-- 恢复请求表的「旧形状」：带 attempts / next_attempt_at（旧的重试退避语义）。
-- 迁移必须把它整体重建，否则死列留下、且下面这条 EXHAUSTED 旧状态行会被新的
-- 收口逻辑（只认 READY / CLAIMED）漏掉。
CREATE TABLE execution_resume_task (
    id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    execution_id    BIGINT       NOT NULL,
    generation      BIGINT       NOT NULL,
    state           VARCHAR(16)  NOT NULL,
    attempts        INT          NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMP    NULL,
    error_reason    VARCHAR(500) NULL,
    version         BIGINT       NOT NULL DEFAULT 1,
    created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_resume_task_generation (execution_id, generation)
);

INSERT INTO execution_resume_task (execution_id, generation, state, attempts, error_reason)
VALUES (77, 1, 'EXHAUSTED', 3, '旧语义：重试已达上限');
