-- ---------------------------------------------------------------------------
-- 2026-09-30: session 表新增 agent_id 列 + (root_session_id, agent_id) 联合索引
--
-- 背景：主理人委派子 Agent 时改为「优先查 (root_session_id, agent_id) 复用已有子会话，
--       而非无脑派生」。此前子会话与 Agent 的绑定只活在 SSE 事件与内存里，重启即失，
--       无法按 Agent 反查，故需要把绑定落到 session 表。
--
-- 说明：
--   1) 新库直接跑 init.sql 即可（已含该列与索引），**勿重复执行本脚本**。
--   2) 既有库执行本脚本；MySQL 8 不支持 ADD COLUMN IF NOT EXISTS，重复执行会报
--      "Duplicate column name"，属预期，可忽略。
--   3) 历史子会话行的 agent_id 为 NULL —— 它们建行于本次改动之前，无法回溯其 Agent。
--      影响：这类子会话不会被复用命中（复用键要求 agent_id 非空），会另派生一个新子会话；
--      如需回溯，可按 session.name（子会话名由 Agent 名生成）人工补值，属可选项。
-- ---------------------------------------------------------------------------

ALTER TABLE session
    ADD COLUMN agent_id BIGINT NULL COMMENT '会话归属的AgentID(关联agent.id); 根会话/非Agent会话为NULL; 子会话落为其子Agent, 支撑(root_session_id,agent_id)复用同一子会话'
    AFTER root_session_id;

ALTER TABLE session
    ADD KEY idx_root_agent (root_session_id, agent_id);
