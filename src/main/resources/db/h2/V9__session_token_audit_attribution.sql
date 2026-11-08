-- V9：token 审计新增两项「归因明细」列（框架 e9c6ec6 的 OtherTokens）。
--
-- 语义（务必与 TokenAuditReconciler / SessionTokenAudit 的注释保持一致）：
--   memory_tokens      记忆正文 token（不含标题与消息分帧），框架已并入 systemTokens；
--   attachment_tokens  用户消息里的非文本内容 token（不含消息分帧），框架已并入 userTokens。
-- 二者只是 system / user 两类合计的「归因明细」，**绝不允许累加进任何分类合计**，
-- 也不参与 requestOverhead 恒等式与 total = messages + requestOverhead。
--
-- 可空是硬要求：audit_state = FAILED 或框架未给出（元素缺失 / NO_DATA / FAILED）时写 NULL，
-- 用 0 冒充会让前端画出「记忆 / 附件零开销」的假柱子。
ALTER TABLE session_token_audit ADD COLUMN IF NOT EXISTS memory_tokens INTEGER NULL;
ALTER TABLE session_token_audit ADD COLUMN IF NOT EXISTS attachment_tokens INTEGER NULL;
