ALTER TABLE session_message ADD COLUMN response_id VARCHAR(36) NULL;
ALTER TABLE session_message DROP COLUMN IF EXISTS stream_key;
