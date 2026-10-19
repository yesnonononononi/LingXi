CREATE TABLE model_config (
 id BIGINT PRIMARY KEY, base_url VARCHAR(500), api_key VARCHAR(500), model_name VARCHAR(100),
 provider VARCHAR(50), create_time TIMESTAMP, update_time TIMESTAMP
);
INSERT INTO model_config (id, base_url, api_key, model_name) VALUES (42, 'https://example.invalid', 'existing-key', 'custom-name');
