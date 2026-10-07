-- H2 schema for session_message（受理事务原子性测试用）。
-- 列名严格对齐 init.sql 的 session_message；H2 不支持 MySQL 的
-- ON UPDATE CURRENT_TIMESTAMP，故 update_time 只声明默认值（测试不依赖自动更新）。
--
-- 注意：InitSqlPoConsistencyTest 把 init.sql 当唯一事实来源，断言 PO 字段 ⊆ init.sql 列。
-- 这里若少列会让「H2 通过、真库 500」的老问题换个方向复发。
DROP TABLE IF EXISTS session_message;

CREATE TABLE session_message (
    id          BIGINT       NOT NULL PRIMARY KEY,
    stream_key  VARCHAR(160) NULL,
    session_id  BIGINT       NOT NULL,
    turn_id     BIGINT       NULL,
    type        VARCHAR(16)  NOT NULL,
    content     CLOB         NOT NULL,
    create_time TIMESTAMP(3) NULL,
    update_time TIMESTAMP(3) NULL
);

-- 与 init.sql 的 uk_session_stream_key 一致：同一响应身份只落一行（重复落库由它拦住）。
ALTER TABLE session_message ADD CONSTRAINT uk_session_stream_key UNIQUE (session_id, stream_key);
