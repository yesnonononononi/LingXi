-- MCP 服务的认证方式（JSON 对象字符串，如 {"mode":"oauth","clientId":null,...}）。
-- 允许 NULL：NULL = 未配置，等价于 mode=none，凭据仍只来自 headers。
ALTER TABLE mcp ADD COLUMN IF NOT EXISTS auth VARCHAR(4096) NULL;
