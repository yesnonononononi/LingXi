CREATE UNIQUE INDEX uk_session_response_id ON session_message (session_id, response_id);
DROP INDEX IF EXISTS uk_session_stream_key;
