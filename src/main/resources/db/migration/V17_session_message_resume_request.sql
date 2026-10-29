ALTER TABLE session_message ADD COLUMN IF NOT EXISTS resume_request_id VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS uk_session_resume_request ON session_message(session_id, resume_request_id);
