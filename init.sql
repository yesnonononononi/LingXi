drop table users;
create table users(
    id bigint auto_increment primary key,
    phone bigint unique comment '手机号码',
    password varchar(200) comment '用户密码',
    nick varchar(20) comment '用户昵称',
    avatar varchar(500) comment '头像',
    account_id bigint comment '关联账户id',
    ip varchar(50) comment 'ip',
    ip_location varchar(100) comment 'ip地址',
    create_time datetime default now() comment '创建时间',
    update_time datetime comment '更新时间',
    UNIQUE KEY `idx_phone` (phone),
    KEY `idx_uname` (nick),
    UNIQUE KEY `uk_id_aid`(id,account_id)
)