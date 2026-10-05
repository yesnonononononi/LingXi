CREATE TABLE IF NOT EXISTS execution_resume_task (
    id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    execution_id    BIGINT       NOT NULL,
    generation      BIGINT       NOT NULL,
    state           VARCHAR(16)  NOT NULL,
    attempts        INT          NOT NULL DEFAULT 0,
    next_attempt_at DATETIME(3)  NULL,
    error_reason    VARCHAR(500) NULL,
    version         BIGINT       NOT NULL DEFAULT 1,
    created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_resume_task_generation (execution_id, generation),
    KEY idx_resume_task_state (state, next_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
