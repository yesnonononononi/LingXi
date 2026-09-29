package com.summit.dp.team.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Builder;
import lombok.Data;
import lombok.Getter;

import java.time.Instant;

/** Team 持久化对象 */
@Builder
@Getter
@TableName("team")
public class TeamPO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String name;
    private Long commanderAgentId;
    private String agentIds;
    private Integer status;
    private String description;
    private Instant createTime;
    private Instant updateTime;
}
