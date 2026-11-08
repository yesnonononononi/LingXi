-- 保存框架审计原值，展示比例不再按业务父级重算。
ALTER TABLE session_token_audit ADD COLUMN IF NOT EXISTS framework_document CLOB;
