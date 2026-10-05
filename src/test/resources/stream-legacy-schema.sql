CREATE TABLE session (id BIGINT AUTO_INCREMENT PRIMARY KEY, root_session_id BIGINT DEFAULT 0,
 agent_id BIGINT, name VARCHAR(100) DEFAULT '旧会话', workspace_id BIGINT, team_id BIGINT,
 context_token_count BIGINT, context_max_tokens INT, context_ratio DECIMAL(10,6), create_time TIMESTAMP, update_time TIMESTAMP);
CREATE TABLE chat_turn (id BIGINT PRIMARY KEY, session_id BIGINT, parent_turn_id BIGINT, execution_id BIGINT,
 status VARCHAR(16), model_name VARCHAR(128), model_provider VARCHAR(100), input_token_count BIGINT,
 output_token_count BIGINT, total_token_count BIGINT, started_at TIMESTAMP, completed_at TIMESTAMP,
 error_reason VARCHAR(1000), created_at TIMESTAMP, updated_at TIMESTAMP);
CREATE TABLE execution (id BIGINT PRIMARY KEY, session_id BIGINT, root_execution_id BIGINT, started_at TIMESTAMP,
 completed_at TIMESTAMP, status INT, snapshot CLOB, created_at TIMESTAMP, updated_at TIMESTAMP);
CREATE TABLE session_message (id BIGINT PRIMARY KEY, session_id BIGINT, turn_id BIGINT, type VARCHAR(16),
 content CLOB, create_time TIMESTAMP, update_time TIMESTAMP);
INSERT INTO session(id,name) VALUES(1,'升级前的会话');
INSERT INTO chat_turn(id,session_id,status) VALUES(7,1,'WAITING');
INSERT INTO execution(id,session_id,status,snapshot) VALUES(11,1,2,'保留检查点');
INSERT INTO session_message(id,session_id,turn_id,type,content) VALUES(90,1,7,'USER','保留历史');
