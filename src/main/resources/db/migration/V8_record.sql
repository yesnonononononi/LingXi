INSERT INTO lingxi_schema_version (version)
SELECT 8 WHERE NOT EXISTS (SELECT 1 FROM lingxi_schema_version WHERE version = 8);
