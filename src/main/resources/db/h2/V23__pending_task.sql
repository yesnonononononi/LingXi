-- ------------------------------------------------------------
-- V23：待发送队列持久化（pending_task）
--
-- 为什么搬进库：原队列是进程内 Map，崩溃/重启即丢；且它只持有文本，
--   图片必须提前落盘、只在内存里留路径，否则 dispatch 时 MultipartFile 早已失效。
--
-- 为什么带 model/agent/workspace/require_plan：恢复时若只剩文本，
--   RequestPreparer 会静默回落单例设置 —— 用户选的 Agent 丢失是小事，
--   require_plan 丢失等于「用户明明排的是先出方案，接力后直接开始改文件」。
--
-- 为什么有 status：进程重启后库里留下的行必须与「本进程刚入队」区分开，
--   否则崩溃后会自动续跑一段上下文可能已经变了的输入。
--   判据只认这一列，不拿 created_at 和进程启动时间比较（时钟回拨/慢启动都会误判）。
--
-- 为什么排序按 id 不按 created_at：同毫秒连发两条时时间戳并列，
--   顺序就成了未定义；雪花 id 单调，直接 order by id。
--
-- 为什么 attachments 用 JSON CLOB 不建子表：附件只随任务整存整取，
--   永远没有「按附件查询」的需求；子表只带来一次 N+1 读取和一份级联删除责任。
--
-- 为什么单列索引 (session_id, id)：所有查询都是「某会话按顺序取」，索引即结果顺序。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_task (
    id             BIGINT       NOT NULL PRIMARY KEY,
    session_id     BIGINT       NOT NULL,
    input_text     CLOB         NOT NULL,
    attachments    CLOB         NOT NULL,
    model_id       BIGINT       NULL,
    agent_id       BIGINT       NULL,
    workspace_id   BIGINT       NULL,
    require_plan   BOOLEAN      NOT NULL DEFAULT FALSE,
    status         VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
    failure        VARCHAR(512) NULL,
    created_at     TIMESTAMP(3) NOT NULL,
    updated_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pending_task_session ON pending_task (session_id, id);
