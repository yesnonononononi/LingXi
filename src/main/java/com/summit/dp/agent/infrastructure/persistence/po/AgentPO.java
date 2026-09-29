package com.summit.dp.agent.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/** Agent 持久化对象 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName("agent")
public class AgentPO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String name;
    private Long modelId;
    private String toolList;
    private String prompt;
    private String description;
    private Integer status;
    private Instant createTime;
    private Instant updateTime;
}
