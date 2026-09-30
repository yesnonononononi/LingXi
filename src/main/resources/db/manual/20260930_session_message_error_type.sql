-- ---------------------------------------------------------------------------
-- 2026-09-30: session_message 新增 ERROR 消息类型（仅列注释变更，无结构/数据变更）
--
-- 背景：执行抛异常时此前只在 SSE 事件里下发一次失败文案，前端流一结束就与后端做消息级
--       对账并用落库行重建列表，内存态错误随即被抹掉（错误提示一闪即逝、刷新会话后无痕）。
--       现改为失败时追加一行 type='ERROR' 的 session_message（content 为纯文本失败文案），
--       错误因此有权威来源，可被重新读取。
--
-- 说明：
--   1) 类型列本身是 VARCHAR(16)、无 CHECK/ENUM 约束，**新增取值不需要改结构**，本脚本只同步
--      列注释（注释是「type 有哪些合法值」的权威说明，不更新会让线上的 ERROR 显得来路不明）。
--   2) 新库直接跑 init.sql 即可（已含新注释），勿重复执行本脚本。
--   3) 重复执行本脚本无副作用（MODIFY COLUMN 幂等）。
--   4) 存量数据无需回填：改动前发生的失败没有 ERROR 行，属历史事实，不回造。
-- ---------------------------------------------------------------------------

ALTER TABLE session_message
    MODIFY COLUMN type VARCHAR(16) NOT NULL COMMENT '消息类型: USER/AI/TOOL/SYSTEM/ERROR';

ALTER TABLE session_message
    MODIFY COLUMN content LONGTEXT NOT NULL COMMENT '消息内容: USER/SYSTEM 存正文原文; AI 存 JSON {thinking,text,toolCalls}; TOOL 只存 call_id(call_xxx); ERROR 存纯文本失败文案';
