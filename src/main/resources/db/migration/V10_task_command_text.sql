-- task.command 更名为 command_text，数据保留。
--
-- 为什么必须有这个脚本：早期建库时该列叫 command，后来 init.sql 与 TaskPO 一起统一成
-- command_text，但 CREATE TABLE IF NOT EXISTS 对已有表是空操作 ⇒ 老库永远缺新列。
-- 症状是启动即挂：恢复未完成任务的查询报 Column "COMMAND_TEXT" not found，进程退出码 1。
ALTER TABLE task ALTER COLUMN command RENAME TO command_text;
