

-- 注：早期草稿里的 `request` 表（id/session_id/三列 token/status/create_at/finish_at）已删除。
-- 全仓 Java / XML / 前端均无任何引用，真库也不存在该表；「一次执行的元信息」统一由
-- execution 表承载（见下方 execution 建表脚本），不另起一套请求生命周期。

-- ------------------------------------------------------------
-- MCP 服务配置：请求级连接容器的数据源（对齐框架侧 McpConfig.MCP）
-- ------------------------------------------------------------
drop table if exists mcp;
CREATE TABLE mcp (
    id                     BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键',
    name                   VARCHAR(64)   NOT NULL COMMENT '服务唯一名：请求级会话标识与工具前缀回落依据',
    transport              VARCHAR(32)   NOT NULL DEFAULT 'streamable-http' COMMENT '传输方式: streamable-http / sse / stdio',
    url                    VARCHAR(1024) NULL COMMENT '服务端点地址(http系传输); stdio 传输为空',
    headers                JSON          NULL COMMENT '自定义请求头(JSON对象), 如 {"Authorization":"Bearer xxx"}',
    command                TEXT          NULL COMMENT 'stdio 启动命令(JSON数组), 如 ["npx","shadcn@latest","mcp"]',
    env                    JSON          NULL COMMENT 'stdio 环境变量(JSON对象), 如 {"GITHUB_TOKEN":"xxx"}',
    tool_name_prefix       VARCHAR(64)   NULL COMMENT '工具名前缀, 为空时框架回落为 name_',
    initialization_timeout BIGINT        NULL COMMENT '初始化超时(毫秒)',
    execution_timeout      BIGINT        NULL COMMENT '执行超时(毫秒)',
    max_output             INT           NULL COMMENT '单次工具输出最大字符数',
    status                 TINYINT       NOT NULL DEFAULT 1 COMMENT '状态: 1启用 0停用',
    create_time            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
    update_time            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
    UNIQUE KEY uk_mcp_name (name),
    KEY idx_mcp_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='MCP服务配置表';

-- 既有库升级 stdio 支持时执行（新库跑上面的 CREATE TABLE 即可，勿重复执行）：
-- ALTER TABLE mcp MODIFY url VARCHAR(1024) NULL COMMENT '服务端点地址(http系传输); stdio 传输为空';
-- ALTER TABLE mcp ADD COLUMN command TEXT NULL COMMENT 'stdio 启动命令(JSON数组), 如 ["npx","shadcn@latest","mcp"]' AFTER headers;
-- ALTER TABLE mcp ADD COLUMN env JSON NULL COMMENT 'stdio 环境变量(JSON对象), 如 {"GITHUB_TOKEN":"xxx"}' AFTER command;

CREATE TABLE model_config (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键',
    model_name       VARCHAR(100) NOT NULL COMMENT '模型名称',
    base_url         VARCHAR(500) NOT NULL COMMENT 'OpenAI兼容接口base地址',
    api_key          VARCHAR(500) COMMENT 'API密钥',
    provider         VARCHAR(50) COMMENT '模型供应商',
    create_time      DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    UNIQUE KEY uk_model_name_base_url (model_name, base_url)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '模型配置表';

-- ------------------------------------------------------------
-- 2. 工作空间表(一个可复用的运行环境, 可被多个会话共享)
-- ------------------------------------------------------------
CREATE TABLE workspace (
    id           BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键',
    name         VARCHAR(100) NOT NULL DEFAULT '工作空间' COMMENT '工作空间名称',
    host_dir     VARCHAR(500) NOT NULL COMMENT '项目宿主机/本地绝对路径; sandbox类型作为容器挂载源, local类型直接作为运行工作目录',
    create_time  DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '工作空间表';

-- ------------------------------------------------------------
-- 3. 会话表(一条记录 = 一个会话聚合)
--    agent_id 已下线：本实例选中的 Agent 改由 user_configs.agent_id 承载(单例)。
-- ------------------------------------------------------------
CREATE TABLE session (
    id             BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键',
    root_session_id BIGINT NOT NULL DEFAULT 0 COMMENT '所属根会话ID(关联session.id, 根会话写0); 团队模式下子代理会话回指委派发起的根会话',
    agent_id       BIGINT COMMENT '会话归属的AgentID(关联agent.id); 根会话/非Agent会话为NULL; 子会话落为其子Agent, 支撑(root_session_id,agent_id)复用同一子会话',
    name           VARCHAR(100) NOT NULL DEFAULT '新对话' COMMENT '会话名称',
    workspace_id   BIGINT COMMENT '工作空间ID(关联workspace.id, 可被多个会话复用, 可空)',
    team_id        BIGINT COMMENT '绑定的协作团队(关联team.id, 可经 /session/{id}/team 换绑; NULL=非团队会话)',
    total_tokens   INT NOT NULL DEFAULT 0 COMMENT '累计Token数',
    input_tokens   INT NOT NULL DEFAULT 0 COMMENT '输入Token数',
    output_tokens  INT NOT NULL DEFAULT 0 COMMENT '输出Token数',
    create_time    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    KEY idx_workspace_id (workspace_id),
    KEY idx_create_time (create_time),
    KEY idx_root_session_id (root_session_id),
    KEY idx_root_agent (root_session_id, agent_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '会话表';

-- ------------------------------------------------------------
-- 4. 会话消息表(List<Message> 拆表存储)
--    卡片快照不再占本表行：工具调用的状态与卡片载荷全部落在 tool_call 表。
--    ERROR 行不是模型对话行：执行抛异常时追加一行，content 为纯文本失败文案。
--    execution_id 是「产生该消息的执行」：刷新、重新订阅、暂停恢复后统计口径一致；
--    旧数据为 NULL 表示归属未知，前端降级展示，不按位置或时间戳猜测归属。
-- ------------------------------------------------------------
CREATE TABLE session_message (
    id              BIGINT NOT NULL PRIMARY KEY COMMENT '雪花ID(消息排序键与游标分页键, 全局趋势递增)',
    session_id      BIGINT NOT NULL COMMENT '关联会话ID',
    execution_id    BIGINT NULL COMMENT '产生该消息的执行ID(关联execution.id); 旧数据为NULL表示归属未知',
    type            VARCHAR(16) NOT NULL COMMENT '消息类型: USER/AI/TOOL/SYSTEM/ERROR',
    content         LONGTEXT NOT NULL COMMENT '消息内容: USER/SYSTEM 存正文原文; AI 存 JSON {thinking,text,toolCalls}; TOOL 只存 call_id(call_xxx); ERROR 存纯文本失败文案',
    create_time     DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间(仅用于展示, 不参与排序)',
    update_time     DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
    KEY idx_session_msg (session_id, id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '会话消息表';

-- 模型使用的可变上下文快照；上下文压缩只替换本表，不修改 session_message 完整历史。
CREATE TABLE session_context (
    session_id      BIGINT NOT NULL PRIMARY KEY COMMENT '关联会话ID',
    content         LONGTEXT NOT NULL COMMENT '框架 List<Message> 的类型化 JSON 快照',
    version         BIGINT NOT NULL DEFAULT 1 COMMENT '快照版本',
    create_time     DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
    update_time     DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间'
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '模型推理上下文快照（允许压缩替换）';

-- ------------------------------------------------------------
-- 5. 通用配置表(实例全局配置，如默认工作空间模式等；单例行，主键固定为 1)
--    agent_id：本实例全局选中的 Agent(关联 agent.id)；允许为空 = 未选择。
-- ------------------------------------------------------------
CREATE TABLE user_configs (
    id             BIGINT NOT NULL PRIMARY KEY COMMENT '固定主键=1（单例设置行）',
    workspace_type VARCHAR(20) DEFAULT 'sandbox' COMMENT '默认工作空间类型: sandbox/local',
    command_approval_policy VARCHAR(30) DEFAULT NULL COMMENT '命令放行档位: FULL_ACCESS/PRE_EXEC_CONFIRM/DANGEROUS_BLOCK, 空则取 CommandApprovalPolicy#DEFAULT',
    access_mode VARCHAR(30) DEFAULT 'IN_WORKSPACE' COMMENT '会话访问档位: IN_WORKSPACE/READ_ONLY_IN_WORKSPACE/OUT_OF_WORKSPACE, 空则取 AgentAccessMode#DEFAULT',
    plan_max_reminders TINYINT DEFAULT 3 COMMENT '提醒未完成任务次数上限: 0-20, 缺省3',
    agent_id       BIGINT DEFAULT NULL COMMENT '本实例全局选中的AgentID(关联agent.id, 为空表示未选择)',
    model_id       BIGINT DEFAULT NULL COMMENT '当前选中的模型ID(关联 model_config.id, 为空表示未选择)',
    max_tokens     INT DEFAULT NULL COMMENT '模型最大Token数(空则由模型/框架缺省兜底)',
    reasoning_effort VARCHAR(50) DEFAULT NULL COMMENT '思考深度/推理等级: low/none/medium/high/xhigh/max(空则由模型/框架缺省兜底)',
    status         TINYINT DEFAULT 1 COMMENT '状态: 1正常 0删除',
    create_time    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    CONSTRAINT chk_user_configs_singleton CHECK (id = 1)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '通用配置表';

-- ------------------------------------------------------------
-- 6. Agent 配置表
-- ------------------------------------------------------------
CREATE TABLE agent (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键',
    name        VARCHAR(100) COMMENT 'Agent名称',
    model_id    BIGINT COMMENT '关联模型ID',
    tool_list   VARCHAR(1000) COMMENT '工具列表(JSON或逗号分隔)',
    prompt      TEXT COMMENT '系统提示词/设定',
    description VARCHAR(500) COMMENT 'Agent描述',
    status      TINYINT DEFAULT 1 COMMENT '状态: 1正常 0禁用',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = 'Agent配置表';

-- ------------------------------------------------------------
-- 7. Agent 团队表(一个团队 = 一个指挥者 + 若干成员 Agent)
-- ------------------------------------------------------------
CREATE TABLE team (
    id                 BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键',
    name               VARCHAR(100) COMMENT '团队名称',
    commander_agent_id BIGINT COMMENT '指挥者AgentID(关联agent.id, 必填)',
    agent_ids          VARCHAR(500) COMMENT '成员AgentID列表(逗号分隔, 含指挥者)',
    description        VARCHAR(500) COMMENT '团队描述',
    status             TINYINT DEFAULT 1 COMMENT '状态: 1正常 0删除',
    create_time        DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = 'Agent团队表';


-- One execution row stores immutable request parameters and mutable runtime state.
-- Null tool_list means all registered tools; [] means no tools. Recovery state lives in snapshot.
--
-- 下面这些「摘要列」（root_execution_id / model_* / *_token_count / started_at / completed_at）
-- 不参与恢复，只为**查询与展示**服务：历史接口按 executionId 批量装配本轮统计，
-- 不必反序列化整个 snapshot。恢复路径仍然只读 status + snapshot。
--
-- status: 0 CREATED, 1 RUNNING, 2 SUSPENDED, 3 COMPLETED, 4 FAILED, 5 CANCELLED.
-- token 列 NULL = 未采集到，0 = 确实为 0 —— 两者必须可区分，旧数据不得显示成零消耗。
-- completed_at 只在进入终态时写入；未结束执行保持 NULL（不用 updated_at 代替）。
CREATE TABLE IF NOT EXISTS execution (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT '执行ID；一次请求对应一次执行，也是请求的唯一标识',
    session_id BIGINT NOT NULL COMMENT '所属会话ID；同一会话可包含多次执行',
    root_execution_id BIGINT NULL COMMENT '所属根执行ID；主执行为NULL，子执行指向发起委派的主执行',
    model_name VARCHAR(128) NULL COMMENT '执行开始时实际解析出的模型名称快照',
    model_provider VARCHAR(100) NULL COMMENT '执行开始时实际解析出的模型提供方快照',
    input_token_count BIGINT NULL COMMENT '本执行累计已采集输入token；NULL=未知(区别于已知的0)',
    output_token_count BIGINT NULL COMMENT '本执行累计已采集输出token；NULL=未知(区别于已知的0)',
    total_token_count BIGINT NULL COMMENT '本执行累计已采集总token；NULL=未知(区别于已知的0)',
    started_at DATETIME(3) NULL COMMENT '执行首次开始时间；暂停后恢复不重置',
    completed_at DATETIME(3) NULL COMMENT '进入完成/失败/取消终态的时间；未结束为NULL',
    status TINYINT NOT NULL DEFAULT 0 COMMENT '执行状态：0创建，1运行，2暂停，3完成，4失败，5取消',
    snapshot LONGTEXT NULL COMMENT '执行恢复检查点；保存请求、消息上下文和运行状态',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '执行记录创建时间',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '执行记录最后更新时间',
    KEY idx_execution_session_recent (session_id, id DESC),
    KEY idx_execution_session_status (session_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Agent 执行状态与恢复快照';

-- ------------------------------------------------------------
-- 8. 工具调用表(唯一权威源：承载全部工具调用的状态与卡片载荷)
--    替换旧的 interaction_status：type ∈ {PROMISE, EXECUTE}；status ∈ {pending, in_progress, completed}。
--    卡片快照不再占 session_message 行：title/content/raw_input/raw_output/meta_data 全在此表。
-- ------------------------------------------------------------
CREATE TABLE tool_call (
    id                 VARCHAR(64)  NOT NULL PRIMARY KEY COMMENT '工具调用ID(call_xxx): 模型下发的 call id, 全局唯一',
    conversation_id    BIGINT       NOT NULL COMMENT '所属会话ID(= session.id)',
    session_message_id BIGINT       NULL COMMENT '回指承载该调用的 session_message.id(TOOL 行); 可空, 由 transcript 尽力回填',
    execution_id       BIGINT       NULL COMMENT '派生此次调用的执行ID(execution.id)',
    tool_name          VARCHAR(100) NOT NULL COMMENT '原始工具名(仅展示, 不作卡片判别依据)',
    type               VARCHAR(16)  NOT NULL COMMENT '调用类型: PROMISE(人工在环) / EXECUTE(框架直通)',
    status             VARCHAR(16)  NOT NULL COMMENT '生命周期: pending / in_progress / completed',
    title              VARCHAR(500) NULL COMMENT '卡片标题(PROMISE 卡片; EXECUTE 可空)',
    content            JSON         NULL COMMENT '多态内容块: {kind:"PLAN|CHOICE|COMMAND", ...}',
    raw_input          JSON         NULL COMMENT '输入载荷: {"args":<模型args>,"answers":<用户答复>}',
    raw_output         JSON         NULL COMMENT '输出载荷: {"outcome":...,"stdout":...,"exitCode":...}',
    meta_data          JSON         NULL COMMENT '扩展元数据 _meta',
    created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
    updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
    KEY idx_message (session_message_id),
    KEY idx_conv_status (conversation_id, status),
    KEY idx_execution (execution_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工具调用状态与卡片载荷(唯一权威源)';

-- ------------------------------------------------------------
-- 9. Agent 邮箱与消息（主键均由应用生成雪花 ID）
-- ------------------------------------------------------------
CREATE TABLE email (
    id                    BIGINT      NOT NULL PRIMARY KEY COMMENT '应用生成的雪花 ID',
    workflow_execution_id BIGINT      NOT NULL COMMENT '协作根执行 ID：根执行取自身，子执行继承根执行；本轮协作的隔离键',
    recipient_agent_id    BIGINT      NOT NULL COMMENT '收件 Agent ID（角色，不绑定执行实例）',
    team_id               BIGINT      NULL COMMENT '创建时的团队快照，不参与投递路由，创建后不可修改',
    status                INT         NOT NULL DEFAULT 1 COMMENT '1 有效，0 无效',
    create_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
    update_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
    UNIQUE KEY uk_email_workflow_recipient (workflow_execution_id, recipient_agent_id),
    KEY idx_email_recipient_agent_id (recipient_agent_id),
    KEY idx_email_team_id (team_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Agent 角色邮箱：一次协作轮次里一个收件 Agent 的邮箱';

CREATE TABLE email_message (
    id        BIGINT      NOT NULL PRIMARY KEY COMMENT '应用生成的雪花 ID',
    email_id  BIGINT      NOT NULL COMMENT '所属邮箱 ID',
    sender_id BIGINT      NOT NULL COMMENT '发件 Agent ID',
    content   TEXT        NOT NULL COMMENT '消息内容',
    status    ENUM('PENDING','CONSUMED') NOT NULL DEFAULT 'PENDING' COMMENT '消息状态',
    create_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
    update_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
    KEY idx_email_message_inbox (email_id, status, create_at, id),
    KEY idx_email_message_sender_id (sender_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='邮箱消息';
