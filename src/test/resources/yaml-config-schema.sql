CREATE TABLE mcp (
 id BIGINT PRIMARY KEY, name VARCHAR(64), transport VARCHAR(32), url VARCHAR(1024),
 headers TEXT, command TEXT, env TEXT, description VARCHAR(200),
 initialization_timeout BIGINT, execution_timeout BIGINT, max_output INT, status INT,
 create_time TIMESTAMP, update_time TIMESTAMP
);
CREATE TABLE model_config (
 id BIGINT PRIMARY KEY, base_url VARCHAR(500), api_key VARCHAR(500), model_name VARCHAR(100),
 provider VARCHAR(50), create_time TIMESTAMP, update_time TIMESTAMP
);
CREATE TABLE user_configs (
 id BIGINT PRIMARY KEY, workspace_type VARCHAR(20), command_approval_policy VARCHAR(30),
 access_mode VARCHAR(30), plan_max_reminders INT, agent_id BIGINT, model_id BIGINT,
 max_tokens INT, reasoning_effort VARCHAR(50), render_theme VARCHAR(10),
 status INT, create_time TIMESTAMP, update_time TIMESTAMP
);
