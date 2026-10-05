-- H2 schema for execution_resume_task（执行恢复意图表）持久化测试。
-- 列名与约束严格对齐 init.sql 的 execution_resume_task；
-- H2 不支持 MySQL 的 ON UPDATE CURRENT_TIMESTAMP，故 updated_at 只声明默认值。
--
-- 这里若少列会让「H2 通过、真库 500」的老问题换个方向复发：
-- 仓储的条件更新会带上每一列，少一列就是运行期 SQL 错误。
DROP TABLE IF EXISTS execution_resume_task;

CREATE TABLE execution_resume_task (
    id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    execution_id    BIGINT       NOT NULL,
    generation      BIGINT       NOT NULL,
    state           VARCHAR(16)  NOT NULL,
    attempts        INT          NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMP(3) NULL,
    error_reason    VARCHAR(500) NULL,
    version         BIGINT       NOT NULL DEFAULT 1,
    created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

-- 与 init.sql 的 uk_resume_task_generation 一致：
-- 同一执行同一可恢复代际最多一条任务，enqueue 的幂等由它保证。
ALTER TABLE execution_resume_task ADD CONSTRAINT uk_resume_task_generation UNIQUE (execution_id, generation);
