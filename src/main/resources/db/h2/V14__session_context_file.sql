-- 模型上下文正文外置：正文改存 <数据目录>/session-context/<session_id>/<正文标识>.jsonl，库里只留正文标识。
-- 起因：content 是整段上下文 CLOB，每轮整笔替换都让 H2 重新追加一份 LOB，
-- 两天实测把库撑到 6.8 GB（活数据仅 40 MB）。正文搬出库后这条增长链才会断掉。
ALTER TABLE session_context ADD COLUMN IF NOT EXISTS snapshot_file VARCHAR(64);

-- content 保留但改为可空：迁移期还要读它一次（启动时把旧行搬成文件），搬完即置 NULL。
-- 之所以不直接 DROP：无内容可回退的迁移是不可逆的，而 H2 删列也不会回收已占的块。
ALTER TABLE session_context ALTER COLUMN content SET NULL;
