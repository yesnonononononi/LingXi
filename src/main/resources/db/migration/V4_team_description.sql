-- 团队描述上限 500 → 1000。
--
-- 与后端 Team.MAX_DESCRIPTION_LENGTH 及设置页校验对齐（此前三处不一致：前端 500、
-- 后端 1000、列宽 500，于是「前端放行 → 后端也放行 → 在 DB 列宽上炸掉」）。
--
-- 为什么必须有这个脚本：加宽列不是「缺列」，init.sql 里改成 VARCHAR(1000) 对**已有库完全无效**
-- （CREATE TABLE IF NOT EXISTS 不会改已存在列的宽度），必须显式 ALTER。
ALTER TABLE team ALTER COLUMN description VARCHAR(1000);
