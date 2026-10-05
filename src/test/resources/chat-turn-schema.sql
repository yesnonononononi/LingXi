-- H2 schema for chat_turn（业务轮次）单元/集成测试。
-- 列名与约束严格对齐 init.sql 的 chat_turn；H2 不支持 MySQL 的
-- ON UPDATE CURRENT_TIMESTAMP，故 updated_at 只声明默认值（测试不依赖自动更新）。
--
-- 注意：InitSqlPoConsistencyTest 把 init.sql 当唯一事实来源，断言 PO 字段 ⊆ init.sql 列。
-- 这里若少列会让「H2 通过、真库 500」的老问题换个方向复发。
DROP TABLE IF EXISTS chat_turn;

CREATE TABLE chat_turn (
    version BIGINT NOT NULL DEFAULT 1,
    id                 BIGINT       NOT NULL PRIMARY KEY,
    session_id         BIGINT       NOT NULL,
    parent_turn_id     BIGINT       NULL,
    execution_id       BIGINT       NULL,
    status             VARCHAR(16)  NOT NULL DEFAULT 'ACCEPTED',
    model_name         VARCHAR(128) NULL,
    model_provider     VARCHAR(100) NULL,
    input_token_count  BIGINT       NULL,
    output_token_count BIGINT       NULL,
    total_token_count  BIGINT       NULL,
    started_at         TIMESTAMP(3) NULL,
    completed_at       TIMESTAMP(3) NULL,
    error_reason       VARCHAR(1000) NULL,
    command_id         VARCHAR(64)  NULL,
    command_digest     VARCHAR(64)  NULL,
    created_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

-- 与 init.sql 的 uk_chat_turn_execution 一致：一轮一次执行。
-- H2 的唯一约束允许多个 NULL，与 MySQL 行为一致（未关联执行的轮次可以共存）。
ALTER TABLE chat_turn ADD CONSTRAINT uk_chat_turn_execution UNIQUE (execution_id);

-- 与 init.sql 的 uk_chat_turn_command 一致：同一命令只能落一行，
-- 重试据此查回首次受理结果而不是新开一轮。
ALTER TABLE chat_turn ADD CONSTRAINT uk_chat_turn_command UNIQUE (command_id);
