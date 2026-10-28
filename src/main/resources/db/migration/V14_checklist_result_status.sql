-- 旧 COMPLETED 只表示结案；保留步骤、版本与时间，按真实结果修正汇总态。
UPDATE checklist
SET status = CASE
    WHEN NOT EXISTS (SELECT 1 FROM checklist_step s WHERE s.checklist_id = checklist.id)
      OR EXISTS (SELECT 1 FROM checklist_step s WHERE s.checklist_id = checklist.id AND s.status IN ('PENDING', 'IN_PROGRESS'))
        THEN 'UNFINISHED'
    WHEN EXISTS (SELECT 1 FROM checklist_step s WHERE s.checklist_id = checklist.id AND s.status = 'FAILED')
        THEN 'FAILED'
    ELSE 'CLOSED'
END
WHERE status = 'COMPLETED'
  AND (NOT EXISTS (SELECT 1 FROM checklist_step s WHERE s.checklist_id = checklist.id)
       OR EXISTS (SELECT 1 FROM checklist_step s WHERE s.checklist_id = checklist.id AND s.status <> 'COMPLETED'));
