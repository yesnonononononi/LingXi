ALTER TABLE task ADD COLUMN IF NOT EXISTS execution_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_task_execution ON task (session_id, execution_id, id);
