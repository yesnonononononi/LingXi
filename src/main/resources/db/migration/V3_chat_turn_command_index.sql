-- commandId 可空：历史轮次没有命令身份；唯一索引允许多行 NULL，不会因存量数据而建不上。
CREATE UNIQUE INDEX uk_chat_turn_command ON chat_turn (command_id);
