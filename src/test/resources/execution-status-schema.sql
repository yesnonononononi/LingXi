-- H2 schema for execution startup-reaper / query tests (mirrors init.sql's execution table).
-- 列名严格对齐 init.sql；本测试仅使用 status / 时间列与摘要列，
-- 建表保留完整列形状，防止与 BaseMapper 生成 SQL 的列集合不一致。
--
-- 注意：摘要列（root_execution_id / model_* / *_token_count / started_at / completed_at）
-- 必须与 init.sql 一致 —— InitSqlPoConsistencyTest 把 init.sql 当唯一事实来源，
-- 这里若少列会让「H2 通过、真库 500」的老问题换个方向复发。
DROP TABLE IF EXISTS execution;

CREATE TABLE execution (
    id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
    session_id          BIGINT       NOT NULL,
    root_execution_id   BIGINT       NULL,
    model_name          VARCHAR(128) NULL,
    model_provider      VARCHAR(100) NULL,
    input_token_count   BIGINT       NULL,
    output_token_count  BIGINT       NULL,
    total_token_count   BIGINT       NULL,
    started_at          TIMESTAMP    NULL,
    completed_at        TIMESTAMP    NULL,
    status              TINYINT      NOT NULL DEFAULT 0,
    snapshot            CLOB         NULL,
    created_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);
