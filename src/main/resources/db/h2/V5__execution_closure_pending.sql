-- ------------------------------------------------------------
-- V5：执行收口的待办事实（不加表，只加一列）
--
-- 为什么需要它：终态提交之后的业务收口（卡片、子执行、轮次、取消广播）在 afterCommit 里执行，
-- 进程崩在「状态已提交」与「收口完成」之间时，内存里什么都留不下。既然终态与「还要收口」
-- 是同一条 UPDATE 写的原子事实，巡检就能用一条窄查询把它们捞出来重做 —— 不再依赖任何
-- 检查点属性标记，也不再依赖遗留恢复请求（那两者恰好在这个窗口里都不存在）。
--
-- 索引只为这一条查询服务（WHERE closure_pending = 1），不参与任何业务读路径。
-- ------------------------------------------------------------
ALTER TABLE execution ADD COLUMN IF NOT EXISTS closure_pending TINYINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_execution_closure_pending ON execution (closure_pending);
