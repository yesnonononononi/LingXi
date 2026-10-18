DROP TABLE task;
CREATE TABLE task (
    id BIGINT PRIMARY KEY, session_id BIGINT NOT NULL, turn_id BIGINT NOT NULL,
    command_text LONGTEXT NOT NULL, output LONGTEXT, status VARCHAR(32) NOT NULL,
    exit_code INTEGER, truncated BOOLEAN NOT NULL DEFAULT FALSE,
    create_at TIMESTAMP NOT NULL, complete_at TIMESTAMP
);
