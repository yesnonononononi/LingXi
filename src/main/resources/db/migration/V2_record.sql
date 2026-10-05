INSERT INTO lingxi_schema_version (version)
SELECT 2 WHERE NOT EXISTS (SELECT 1 FROM lingxi_schema_version WHERE version = 2);
