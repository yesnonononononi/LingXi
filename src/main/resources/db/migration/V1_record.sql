CREATE TABLE IF NOT EXISTS lingxi_schema_version (
    version INT NOT NULL PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO lingxi_schema_version (version)
SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM lingxi_schema_version WHERE version = 1);
