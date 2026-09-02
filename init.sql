-- ============================================================
-- LingXi 数据库初始化脚本 (MySQL 8.0+)
-- 表结构与各模块持久化对象(PO)一一对应：
--   users        -> auth/UserPO
--   model_config -> model/ModelConfigPO
--   workspace    -> workspace/WorkspacePO
--   session      -> session/SessionPO
-- 执行方式: mysql -uroot -p < init.sql
-- ============================================================

SET NAMES utf8mb4;

-- 依赖顺序删除，避免残留脏数据
drop table if exists session;
drop table if exists workspace;
drop table if exists model_config;
drop table if exists users;

-- ------------------------------------------------------------
-- 用户表
-- ------------------------------------------------------------
create table users(
    id           bigint auto_increment primary key comment '主键',
    phone        varchar(20) unique comment '手机号码(登录账号)',
    password     varchar(200) comment '用户密码(加密存储)',
    nick         varchar(20) comment '用户昵称',
    avatar       varchar(500) comment '头像',
    account_id   bigint comment '关联账户id',
    ip           varchar(50) comment '最近登录ip',
    ip_location  varchar(100) comment 'ip归属地',
    create_time  datetime default now() comment '创建时间',
    update_time  datetime default now() on update now() comment '更新时间',
    UNIQUE KEY uk_phone (phone),
    KEY idx_nick (nick),
    KEY idx_account_id (account_id)
) engine = InnoDB default charset = utf8mb4 comment '用户表';

-- ------------------------------------------------------------
-- 模型配置表
-- ------------------------------------------------------------
create table model_config(
    id          bigint auto_increment primary key comment '主键',
    model_name  varchar(100) not null comment '模型名称(如 deepseek-v4-flash)',
    base_url    varchar(500) not null comment 'OpenAI兼容接口base地址',
    api_key     varchar(500) comment 'API密钥',
    create_time datetime default now() comment '创建时间',
    update_time datetime default now() on update now() comment '更新时间',
    UNIQUE KEY uk_model_name (model_name)
) engine = InnoDB default charset = utf8mb4 comment '模型配置表';

-- ------------------------------------------------------------
-- 工作空间表(一个可复用的运行环境, 可被多个会话共享)
-- ------------------------------------------------------------
create table workspace(
    id           bigint auto_increment primary key comment '主键',
    name         varchar(100) not null default '工作空间' comment '工作空间名称',
    type         varchar(20) not null default 'docker' comment '工作空间类型: docker/local',
    work_dir     varchar(500) not null comment '工作目录(docker为容器内绝对路径, local为主机目录)',
    container_id varchar(100) comment 'docker容器ID(仅docker类型回填)',
    create_time  datetime default now() comment '创建时间',
    update_time  datetime default now() on update now() comment '更新时间'
) engine = InnoDB default charset = utf8mb4 comment '工作空间表';

-- ------------------------------------------------------------
-- 会话表(一条记录 = 一个会话聚合)
-- ------------------------------------------------------------
create table session(
    id             bigint auto_increment primary key comment '主键',
    name           varchar(100) not null default '新对话' comment '会话名称',
    workspace_id   bigint comment '工作空间ID(关联workspace.id, 可被多个会话复用, 可空)',
    messages       longtext comment '消息列表JSON(多态序列化, 对话较长故用longtext)',
    total_tokens   int not null default 0 comment '累计Token数',
    input_tokens   int not null default 0 comment '输入Token数',
    output_tokens  int not null default 0 comment '输出Token数',
    system_message varchar(2000) comment '系统提示词',
    create_time    datetime default now() comment '创建时间',
    update_time    datetime default now() on update now() comment '更新时间',
    KEY idx_workspace_id (workspace_id),
    KEY idx_create_time (create_time)
) engine = InnoDB default charset = utf8mb4 comment '会话表';
