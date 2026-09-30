-- ---------------------------------------------------------------------------
-- 2026-09-30: 会话轮次关联改造 —— session_message 归属执行 + execution 查询摘要
--
-- 背景：token 用量 / 使用模型 / 耗时 / 状态此前只活在「执行快照(snapshot) + 一次性 SSE 事件」里：
--       (a) 前端只在 EXECUTION_COMPLETED 那一刻拿到用量，刷新或重新订阅后统计消失；
--       (b) session_message 没有执行归属，历史接口只能按「页内 USER 消息」划轮，
--           分页切在 AI/TOOL/ERROR 中间时会造出孤行容器；
--       (c) 会话级累计 token 被回填到最后一条回答上，与单次执行统计混淆。
--       本次把「一次执行」的查询摘要落到 execution 的独立列上，并让每条 session_message
--       显式归属到产生它的执行。
--
-- 说明：
--   1) 新库直接跑 init.sql 即可（已含全部新列），**勿重复执行本脚本**。
--   2) 既有库执行本脚本；MySQL 8 不支持 ADD COLUMN IF NOT EXISTS，重复执行会报
--      "Duplicate column name" / "Duplicate key name"，属预期，可忽略。
--   3) 存量数据不回填：旧 session_message.execution_id 保持 NULL，旧 execution 行的新列保持 NULL。
--      不按消息位置或时间戳猜测归属 —— 猜测出来的归属比「未知」更糟。
--      NULL 语义 = 「未知」，与「已知为 0」严格区分：前端对 NULL 显示「暂无统计」，
--      绝不把未知渲染成零消耗。
--   4) token 列用 BIGINT NULL，而不是沿用 session 表的 INT NOT NULL DEFAULT 0：
--      total_tokens 是「该执行所有轮次的计费累加」（每轮 input 都要重算整段上下文，
--      单次 run 百万级很正常），INT 有溢出风险；NULL 表示未采集到，0 表示确实为 0。
--   5) completed_at 只在进入终态（完成 / 失败 / 取消）时写入，未结束执行保持 NULL。
--      **不用 updated_at 代替**：那是「任意列发生变更」的副作用，暂停、恢复、甚至一次
--      无关的检查点都会刷新它，拿它当结束时间会把「还在等审批」显示成「已结束」。
--   6) model_name / model_provider 是执行开始时「实际解析出的模型配置」快照，
--      只存名称与提供方；**不存 baseUrl / apiKey / timeout 等连接凭据**。
--      快照的意义：模型配置事后被改名或换提供方，历史执行仍显示当时的真实值。
--   7) 本脚本不新增按 execution_id / root_execution_id 的查询索引 —— 首版没有
--      「按执行反查消息」或「按根执行汇总用量」的查询，加了就是无用索引。
--      这两项属「核心功能稳定后再做」的优化项，届时一并补索引。
-- ---------------------------------------------------------------------------

-- ------------------------------------------------------------
-- 1. 消息归属：一次执行对应若干条消息（USER / AI / TOOL / ERROR）
-- ------------------------------------------------------------
ALTER TABLE session_message
    ADD COLUMN execution_id BIGINT NULL COMMENT '产生该消息的执行ID(关联execution.id); 旧数据为NULL表示归属未知'
    AFTER session_id;

-- ------------------------------------------------------------
-- 2. 执行查询摘要列
-- ------------------------------------------------------------

-- 子执行 → 发起委派的主执行；主执行自身为 NULL（不写自身 id，避免与「未知」混淆）
ALTER TABLE execution
    ADD COLUMN root_execution_id BIGINT NULL COMMENT '所属根执行ID; 主执行为NULL, 子执行指向发起委派的主执行'
    AFTER session_id;

ALTER TABLE execution
    ADD COLUMN model_name VARCHAR(128) NULL COMMENT '执行开始时实际解析出的模型名称快照';

ALTER TABLE execution
    ADD COLUMN model_provider VARCHAR(100) NULL COMMENT '执行开始时实际解析出的模型提供方快照';

ALTER TABLE execution
    ADD COLUMN input_token_count BIGINT NULL COMMENT '本执行累计已采集输入token; NULL=未知(区别于已知的0)';

ALTER TABLE execution
    ADD COLUMN output_token_count BIGINT NULL COMMENT '本执行累计已采集输出token; NULL=未知(区别于已知的0)';

ALTER TABLE execution
    ADD COLUMN total_token_count BIGINT NULL COMMENT '本执行累计已采集总token; NULL=未知(区别于已知的0)';

ALTER TABLE execution
    ADD COLUMN started_at DATETIME(3) NULL COMMENT '执行首次开始时间; 暂停后恢复不重置';

ALTER TABLE execution
    ADD COLUMN completed_at DATETIME(3) NULL COMMENT '进入完成/失败/取消终态的时间; 未结束为NULL';

-- ------------------------------------------------------------
-- 3. 清理未使用的 request 表草稿
-- ------------------------------------------------------------
-- init.sql 里曾有一张 `request` 表草稿（id/session_id/三列 token/status/create_at/finish_at），
-- 全仓 Java / XML / 前端均无任何引用，真库也不存在该表。本脚本**不对既有库执行 DROP**
-- （破坏性操作，且无收益）；只从 init.sql 的新库初始化定义中移除。如需彻底清理既有库，
-- 由运维确认后手工执行：DROP TABLE IF EXISTS `request`;
