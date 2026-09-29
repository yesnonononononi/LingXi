-- H2 schema for execution startup-reaper tests (mirrors init.sql's execution table).
-- 列名严格对齐 init.sql；本测试仅使用 status / 时间列，但建表保留完整列形状，
-- 防止与 BaseMapper 生成 SQL 的列集合不一致。
DROP TABLE IF EXISTS execution;

CREATE TABLE execution (
    id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
    session_id          BIGINT       NOT NULL,
    workspace_id        BIGINT       NULL,
    model_config_id     BIGINT       NULL,
    agent_id            BIGINT       NULL,
    root_execution_id   BIGINT       NULL,
    worker_id           VARCHAR(128) NULL,
    system_prompt       CLOB         NULL,
    task                CLOB         NULL,
    tool_list           CLOB         NULL,
    attrs               CLOB         NULL,
    allow_out_workspace TINYINT      NOT NULL DEFAULT 0,
    model_provider      VARCHAR(100) NULL,
    status              TINYINT      NOT NULL DEFAULT 0,
    desired_action      TINYINT      NOT NULL DEFAULT 0,
    lease_until         TIMESTAMP    NULL,
    version             BIGINT       NOT NULL DEFAULT 0,
    max_steps           INT          NOT NULL DEFAULT 0,
    snapshot            CLOB         NULL,
    error_message       VARCHAR(1000) NULL,
    created_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    started_at          TIMESTAMP    NULL,
    completed_at        TIMESTAMP    NULL
);
