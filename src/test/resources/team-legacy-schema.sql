-- team 表的「旧形状」：description 是 VARCHAR(500)。
-- 迁移必须把列加宽到 1000，否则设置页与后端都放行 1000 字的描述、最后在 DB 列宽上炸掉。
CREATE TABLE team (
    id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
    name               VARCHAR(100),
    commander_agent_id BIGINT,
    agent_ids          VARCHAR(500),
    description        VARCHAR(500),
    status             TINYINT DEFAULT 1,
    create_time        DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_time        DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO team (name, description) VALUES ('旧团队', '旧描述：加宽列不得丢数据');
