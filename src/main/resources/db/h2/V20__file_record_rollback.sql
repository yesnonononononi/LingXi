-- 回滚标记：该文件在这次执行里的最后一条记录一旦被按基线回填，就在这里留时间戳。
-- 只标记「最后一条」：回滚的判定与展示都以末态记录为准，标记整段历史没有意义。
ALTER TABLE file_record ADD COLUMN rolled_back_at TIMESTAMP(3) NULL;
