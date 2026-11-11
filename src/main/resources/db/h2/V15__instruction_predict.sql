-- ------------------------------------------------------------
-- V15：指令预测（下一句用户指令）与其模型设置
--
-- 为什么是 V15 不是 V14：main 上 V14 已被「会话上下文外置」占用，
--   两个脚本抢同一个版本号会让建库器命中「已登记指纹不一致」直接拒绝启动。
--
-- 为什么单独一张表：预测结果是「某一轮的衍生结论」，既不属于对话消息
--   （不该混进 transcript 时间轴），也不是配置（要按轮次复用、避免重复调用模型）。
--   唯一键放在 (session_id, turn_id)：一轮只该有一份预测，重测覆盖即可。
--
-- 为什么 user_configs 要加列：预测模型是用户可选设置，与 compact_model_id 同口径，
--   但必须独立成列 —— 共用一列会让「改压缩模型」顺带改掉预测结果。
--   设置本身存 JSON，这一列只用于 MyBatis 全字段 SQL 与老库兼容。
-- ------------------------------------------------------------
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS predicate_model_id BIGINT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS instruction_predict (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    session_id       BIGINT NOT NULL,
    turn_id          BIGINT NOT NULL,
    model_id         BIGINT DEFAULT NULL,
    next_instruction CLOB DEFAULT NULL,
    create_time      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_instruction_predict_turn
    ON instruction_predict (session_id, turn_id);
