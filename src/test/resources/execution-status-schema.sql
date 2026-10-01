-- H2 schema for execution startup-reaper / query tests (mirrors init.sql's execution table).
-- 列名严格对齐 init.sql；本测试仅使用 status / 时间列与根执行归属，
-- 建表保留完整列形状，防止与 BaseMapper 生成 SQL 的列集合不一致。
--
-- 注意：模型与 token 列已从 execution 删除（权威在 chat_turn）——
-- InitSqlPoConsistencyTest 把 init.sql 当唯一事实来源，
-- 这里若多列会让「H2 通过、真库 500」的老问题换个方向复发。
DROP TABLE IF EXISTS execution;

CREATE TABLE execution (
    id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
    session_id          BIGINT       NOT NULL,
    root_execution_id   BIGINT       NULL,
    started_at          TIMESTAMP    NULL,
    completed_at        TIMESTAMP    NULL,
    status              TINYINT      NOT NULL DEFAULT 0,
    snapshot            CLOB         NULL,
    created_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);
