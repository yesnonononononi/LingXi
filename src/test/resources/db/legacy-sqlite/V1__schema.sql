-- 仅用于旧数据迁移演练，不进入运行包。
-- =====================================================================
-- LingXi SQLite 建库脚本 V1（唯一 DDL 真源）
--
-- 只有纯 SQLite 语法：无 COMMENT / ENGINE / AUTO_INCREMENT / 内联 KEY。
-- 列类型刻意收敛为 INTEGER / TEXT / NUMERIC：
--   * 所有 id、计数、布尔（0/1）、枚举（存字符串）→ INTEGER / TEXT
--   * 时间列一律 TEXT，格式 yyyy-MM-dd HH:mm:ss.SSS（UTC），由 TimeTypeHandlers 读写，
--     与 strftime('%Y-%m-%d %H:%M:%f','now') 的默认值同形，故字典序 == 时间序。
--   * 原来 MySQL 的 ON UPDATE CURRENT_TIMESTAMP 用 AFTER UPDATE 触发器还原（见文件末尾），
--     触发条件是「本行 update_time 没被显式改写」，语义与 MySQL 一致。
--
-- 主键：应用生成雪花 ID 的表用普通 INTEGER PRIMARY KEY；
-- 需要库侧自增的表必须是 INTEGER PRIMARY KEY AUTOINCREMENT（SQLite 只认这个写法）。
-- =====================================================================

-- ------------------------------------------------------------
-- 1. MCP 服务配置（对齐框架侧 McpConfig.MCP）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mcp (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    name                   TEXT    NOT NULL,
    description            TEXT    NULL,
    transport              TEXT    NOT NULL DEFAULT 'streamable-http',
    url                    TEXT    NULL,
    headers                TEXT    NULL,
    command                TEXT    NULL,
    env                    TEXT    NULL,
    initialization_timeout INTEGER NULL,
    execution_timeout      INTEGER NULL,
    protocol_version       TEXT    NULL,
    auto_health_check      INTEGER NULL,
    health_check_interval  INTEGER NULL,
    reconnect_interval     INTEGER NULL,
    max_output             INTEGER NULL,
    status                 INTEGER NOT NULL DEFAULT 1,
    create_time            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    update_time            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_mcp_name ON mcp (name);
CREATE INDEX IF NOT EXISTS idx_mcp_status ON mcp (status);

-- ------------------------------------------------------------
-- 2. 模型提供商预设（运行期真源是 providers.json，本表只承担首次导入）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_config (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    icon        TEXT    NULL,
    base_url    TEXT    NULL,
    api_key     TEXT    NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    create_time TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    update_time TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_provider_config_name ON provider_config (name);

-- ------------------------------------------------------------
-- 3. 模型配置（运行期真源是 models.json）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS model_config (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    model_name         TEXT    NOT NULL,
    base_url           TEXT    NOT NULL,
    api_key            TEXT    NULL,
    provider           TEXT    NULL,
    provider_config_id INTEGER NULL,
    vision             INTEGER NOT NULL DEFAULT 0,
    use_provider       INTEGER NOT NULL DEFAULT 0,
    create_time        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    update_time        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_model_name_base_url ON model_config (model_name, base_url);
CREATE INDEX IF NOT EXISTS idx_model_config_provider ON model_config (provider_config_id);

-- ------------------------------------------------------------
-- 4. 工作空间
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL DEFAULT '工作空间',
    host_dir    TEXT    NOT NULL,
    create_time TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    update_time TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

-- ------------------------------------------------------------
-- 5. 会话（一条记录 = 一个会话聚合）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    is_read             INTEGER NOT NULL DEFAULT 1,
    history_revision    INTEGER NOT NULL DEFAULT 1,
    version             INTEGER NOT NULL DEFAULT 1,
    root_session_id     INTEGER NOT NULL DEFAULT 0,
    agent_id            INTEGER NULL,
    name                TEXT    NOT NULL DEFAULT '新对话',
    workspace_id        INTEGER NULL,
    team_id             INTEGER NULL,
    context_token_count INTEGER NULL,
    context_max_tokens  INTEGER NULL,
    context_ratio       NUMERIC NULL,
    create_time         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    update_time         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_id ON session (workspace_id);
CREATE INDEX IF NOT EXISTS idx_create_time ON session (create_time);
CREATE INDEX IF NOT EXISTS idx_root_session_id ON session (root_session_id);
CREATE INDEX IF NOT EXISTS idx_root_agent ON session (root_session_id, agent_id);

-- ------------------------------------------------------------
-- 6. 会话消息（List<Message> 拆表存储；卡片载荷在 tool_call）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_message (
    id                INTEGER PRIMARY KEY,
    response_id       TEXT    NULL,
    resume_request_id TEXT    NULL,
    session_id        INTEGER NOT NULL,
    turn_id           INTEGER NULL,
    type              TEXT    NOT NULL,
    content           TEXT    NOT NULL,
    create_time       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    update_time       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_session_resume_request ON session_message (session_id, resume_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS uk_session_response_id ON session_message (session_id, response_id);
CREATE INDEX IF NOT EXISTS idx_session_msg ON session_message (session_id, id);

-- 模型推理上下文快照（允许压缩替换）
CREATE TABLE IF NOT EXISTS session_context (
    session_id  INTEGER PRIMARY KEY,
    content     TEXT    NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    create_time TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    update_time TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

-- ------------------------------------------------------------
-- 7. 通用配置（单例行，主键固定 1）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_configs (
    id                      INTEGER PRIMARY KEY,
    workspace_type          TEXT    DEFAULT 'sandbox',
    command_approval_policy TEXT    DEFAULT NULL,
    access_mode             TEXT    DEFAULT 'IN_WORKSPACE',
    plan_max_reminders      INTEGER DEFAULT 3,
    agent_id                INTEGER DEFAULT NULL,
    model_id                INTEGER DEFAULT NULL,
    max_tokens              INTEGER DEFAULT NULL,
    reasoning_effort        TEXT    DEFAULT NULL,
    render_theme            TEXT    NOT NULL DEFAULT 'LIGHT',
    data_dir                TEXT    DEFAULT NULL,
    skill_dir               TEXT    DEFAULT NULL,
    team_size               INTEGER DEFAULT NULL,
    compact_model_id        INTEGER DEFAULT NULL,
    font_scale              TEXT    DEFAULT NULL,
    status                  INTEGER DEFAULT 1,
    create_time             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    update_time             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    CONSTRAINT chk_user_configs_singleton CHECK (id = 1)
);

-- ------------------------------------------------------------
-- 8. Agent 配置
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NULL,
    model_id    INTEGER NULL,
    tool_list   TEXT    NULL,
    prompt      TEXT    NULL,
    description TEXT    NULL,
    avatar      TEXT    NULL,
    status      INTEGER DEFAULT 1,
    create_time TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    update_time TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

-- ------------------------------------------------------------
-- 9. Agent 团队（一个指挥者 + 若干成员）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS team (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT    NULL,
    commander_agent_id INTEGER NULL,
    agent_ids          TEXT    NULL,
    description        TEXT    NULL,
    avatar             TEXT    NULL,
    status             INTEGER DEFAULT 1,
    create_time        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    update_time        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

-- ------------------------------------------------------------
-- 10. 执行状态与恢复快照（框架运行记录）
--     status: 0 CREATED / 1 RUNNING / 2 SUSPENDED / 3 COMPLETED / 4 FAILED / 5 CANCELLED
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS execution (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    version           INTEGER NOT NULL DEFAULT 1,
    session_id        INTEGER NOT NULL,
    started_at        TEXT    NULL,
    completed_at      TEXT    NULL,
    status            INTEGER NOT NULL DEFAULT 0,
    resume_generation INTEGER NOT NULL DEFAULT 0,
    -- 检查点正文在文件里（<数据目录>/checkpoints/<executionId>/<fileId>.json），
    -- 这里只存文件标识。列名必须说清「这是文件名」，不能叫 snapshot 让人以为存正文。
    snapshot_file     TEXT    NULL,
    created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

CREATE INDEX IF NOT EXISTS idx_execution_session_recent ON execution (session_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_execution_session_status ON execution (session_id, status);

-- ------------------------------------------------------------
-- 11. 业务轮次（chat_turn）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_turn (
    id                INTEGER NOT NULL PRIMARY KEY,
    version           INTEGER NOT NULL DEFAULT 1,
    session_id        INTEGER NOT NULL,
    parent_turn_id    INTEGER NULL,
    execution_id      INTEGER NULL,
    status            TEXT    NOT NULL DEFAULT 'ACCEPTED',
    model_name        TEXT    NULL,
    model_provider    TEXT    NULL,
    input_token_count INTEGER NULL,
    output_token_count INTEGER NULL,
    total_token_count INTEGER NULL,
    cache_tokens      INTEGER NULL,
    reasoning_tokens  INTEGER NULL,
    started_at        TEXT    NULL,
    completed_at      TEXT    NULL,
    error_reason      TEXT    NULL,
    command_id        TEXT    NULL,
    command_digest    TEXT    NULL,
    created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_chat_turn_execution ON chat_turn (execution_id);
CREATE UNIQUE INDEX IF NOT EXISTS uk_chat_turn_command ON chat_turn (command_id);
CREATE INDEX IF NOT EXISTS idx_chat_turn_session_recent ON chat_turn (session_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_chat_turn_session_status ON chat_turn (session_id, status);
CREATE INDEX IF NOT EXISTS idx_chat_turn_parent ON chat_turn (parent_turn_id);

-- ------------------------------------------------------------
-- 12. 工具调用（状态与卡片载荷的唯一权威源）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tool_call (
    id                  TEXT    NOT NULL PRIMARY KEY,
    conversation_id     INTEGER NOT NULL,
    session_message_id  INTEGER NULL,
    execution_id        INTEGER NULL,
    tool_name           TEXT    NOT NULL,
    type                TEXT    NOT NULL,
    status              TEXT    NOT NULL,
    title               TEXT    NULL,
    content             TEXT    NULL,
    raw_input           TEXT    NULL,
    raw_output          TEXT    NULL,
    meta_data           TEXT    NULL,
    decision_command_id TEXT    NULL,
    decision_digest     TEXT    NULL,
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

CREATE INDEX IF NOT EXISTS idx_message ON tool_call (session_message_id);
CREATE INDEX IF NOT EXISTS idx_conv_status ON tool_call (conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_execution ON tool_call (execution_id);

-- ------------------------------------------------------------
-- 13. 执行恢复请求（只存请求，不存事件）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS execution_resume_task (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id INTEGER NOT NULL,
    generation   INTEGER NOT NULL,
    state        TEXT    NOT NULL,
    error_reason TEXT    NULL,
    version      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_resume_task_generation ON execution_resume_task (execution_id, generation);

-- ------------------------------------------------------------
-- 14. Agent 邮箱与消息
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email (
    id                    INTEGER NOT NULL PRIMARY KEY,
    workflow_execution_id INTEGER NOT NULL,
    recipient_agent_id    INTEGER NOT NULL,
    team_id               INTEGER NULL,
    status                INTEGER NOT NULL DEFAULT 1,
    create_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    update_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_email_workflow_recipient ON email (workflow_execution_id, recipient_agent_id);
CREATE INDEX IF NOT EXISTS idx_email_recipient_agent_id ON email (recipient_agent_id);
CREATE INDEX IF NOT EXISTS idx_email_team_id ON email (team_id);

CREATE TABLE IF NOT EXISTS email_message (
    id        INTEGER NOT NULL PRIMARY KEY,
    email_id  INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    dedup_key TEXT    NULL,
    content   TEXT    NOT NULL,
    status    TEXT    NOT NULL DEFAULT 'PENDING',
    create_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    update_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);

CREATE INDEX IF NOT EXISTS idx_email_message_inbox ON email_message (email_id, status, create_at, id);
CREATE INDEX IF NOT EXISTS idx_email_message_sender_id ON email_message (sender_id);
CREATE UNIQUE INDEX IF NOT EXISTS uk_email_message_dedup ON email_message (dedup_key);

-- ------------------------------------------------------------
-- 15. 运行配置历史版本
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runtime_config_revision (
    id          INTEGER NOT NULL PRIMARY KEY,
    kind        TEXT    NOT NULL,
    config_id   INTEGER NOT NULL,
    revision    INTEGER NOT NULL,
    fingerprint TEXT    NOT NULL,
    payload     TEXT    NOT NULL,
    created_at  TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_runtime_config_revision ON runtime_config_revision (kind, config_id, revision);
CREATE UNIQUE INDEX IF NOT EXISTS uk_runtime_config_fingerprint ON runtime_config_revision (kind, config_id, fingerprint);

-- ------------------------------------------------------------
-- 16. 后台命令任务
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task (
    id           INTEGER NOT NULL PRIMARY KEY,
    session_id   INTEGER NOT NULL,
    turn_id      INTEGER NOT NULL,
    execution_id INTEGER NULL,
    command_text TEXT    NOT NULL,
    intention    TEXT    NULL,
    output       TEXT    NULL,
    status       TEXT    NOT NULL,
    exit_code    INTEGER NULL,
    truncated    INTEGER NOT NULL DEFAULT 0,
    create_at    TEXT    NOT NULL,
    complete_at  TEXT    NULL
);

CREATE INDEX IF NOT EXISTS idx_task_session ON task (session_id, id);
CREATE INDEX IF NOT EXISTS idx_task_execution ON task (session_id, execution_id, id);

-- ------------------------------------------------------------
-- 17. 执行清单（清单 + 步骤）
--     active_session_key 是派生列：ACTIVE 时等于 session_id，其余 NULL；
--     唯一索引因此在库侧保证「每个会话至多一份活动清单」。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS checklist (
    id                        INTEGER NOT NULL PRIMARY KEY,
    session_id                INTEGER NOT NULL,
    agent_id                  INTEGER NULL,
    title                     TEXT    NOT NULL,
    status                    TEXT    NOT NULL,
    remind_status             INTEGER NOT NULL DEFAULT 0,
    progress_version          INTEGER NOT NULL DEFAULT 0,
    remind_execution_id       INTEGER NULL,
    reminded_progress_version INTEGER NULL,
    active_session_key        INTEGER GENERATED ALWAYS AS
                              (CASE WHEN status = 'ACTIVE' THEN session_id ELSE NULL END) VIRTUAL,
    create_at                 TEXT    NOT NULL,
    update_at                 TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_checklist_active_session ON checklist (active_session_key);
CREATE INDEX IF NOT EXISTS idx_checklist_session ON checklist (session_id, id);

CREATE TABLE IF NOT EXISTS checklist_step (
    id           INTEGER NOT NULL PRIMARY KEY,
    checklist_id INTEGER NOT NULL,
    seq          INTEGER NOT NULL,
    content      TEXT    NOT NULL,
    status       TEXT    NOT NULL,
    update_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_checklist_step_order ON checklist_step (checklist_id, seq);

-- =====================================================================
-- ON UPDATE 时间：MySQL 的 ON UPDATE CURRENT_TIMESTAMP 在 SQLite 无对应列语法，
-- 用 AFTER UPDATE 触发器还原同一语义 ——
-- 只有「本次 UPDATE 没显式改 update_time」时才刷新，
-- 显式写入（仓储按业务时刻赋值）不会被覆盖。
-- SQLite 默认 recursive_triggers=OFF，触发器内的 UPDATE 不会再触发自身。
-- =====================================================================
CREATE TRIGGER IF NOT EXISTS trg_mcp_touch AFTER UPDATE ON mcp FOR EACH ROW
WHEN NEW.update_time IS OLD.update_time BEGIN
    UPDATE mcp SET update_time = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_provider_config_touch AFTER UPDATE ON provider_config FOR EACH ROW
WHEN NEW.update_time IS OLD.update_time BEGIN
    UPDATE provider_config SET update_time = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_model_config_touch AFTER UPDATE ON model_config FOR EACH ROW
WHEN NEW.update_time IS OLD.update_time BEGIN
    UPDATE model_config SET update_time = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_workspace_touch AFTER UPDATE ON workspace FOR EACH ROW
WHEN NEW.update_time IS OLD.update_time BEGIN
    UPDATE workspace SET update_time = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_session_touch AFTER UPDATE ON session FOR EACH ROW
WHEN NEW.update_time IS OLD.update_time BEGIN
    UPDATE session SET update_time = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_session_message_touch AFTER UPDATE ON session_message FOR EACH ROW
WHEN NEW.update_time IS OLD.update_time BEGIN
    UPDATE session_message SET update_time = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_session_context_touch AFTER UPDATE ON session_context FOR EACH ROW
WHEN NEW.update_time IS OLD.update_time BEGIN
    UPDATE session_context SET update_time = strftime('%Y-%m-%d %H:%M:%f','now') WHERE session_id = NEW.session_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_user_configs_touch AFTER UPDATE ON user_configs FOR EACH ROW
WHEN NEW.update_time IS OLD.update_time BEGIN
    UPDATE user_configs SET update_time = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_touch AFTER UPDATE ON agent FOR EACH ROW
WHEN NEW.update_time IS OLD.update_time BEGIN
    UPDATE agent SET update_time = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_team_touch AFTER UPDATE ON team FOR EACH ROW
WHEN NEW.update_time IS OLD.update_time BEGIN
    UPDATE team SET update_time = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_execution_touch AFTER UPDATE ON execution FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at BEGIN
    UPDATE execution SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_chat_turn_touch AFTER UPDATE ON chat_turn FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at BEGIN
    UPDATE chat_turn SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_tool_call_touch AFTER UPDATE ON tool_call FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at BEGIN
    UPDATE tool_call SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_execution_resume_task_touch AFTER UPDATE ON execution_resume_task FOR EACH ROW
WHEN NEW.updated_at IS OLD.updated_at BEGIN
    UPDATE execution_resume_task SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_email_touch AFTER UPDATE ON email FOR EACH ROW
WHEN NEW.update_at IS OLD.update_at BEGIN
    UPDATE email SET update_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_email_message_touch AFTER UPDATE ON email_message FOR EACH ROW
WHEN NEW.update_at IS OLD.update_at BEGIN
    UPDATE email_message SET update_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;
