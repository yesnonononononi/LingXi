-- 合并工作区访问边界与命令审批策略为单一总权限档位 permission_mode
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS permission_mode VARCHAR(64);
