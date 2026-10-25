CREATE TABLE IF NOT EXISTS runtime_config_revision (
    id BIGINT PRIMARY KEY,
    kind VARCHAR(16) NOT NULL,
    config_id BIGINT NOT NULL,
    revision INTEGER NOT NULL,
    fingerprint VARCHAR(64) NOT NULL,
    payload LONGTEXT NOT NULL,
    created_at TIMESTAMP NOT NULL,
    UNIQUE (kind, config_id, revision),
    UNIQUE (kind, config_id, fingerprint)
);
