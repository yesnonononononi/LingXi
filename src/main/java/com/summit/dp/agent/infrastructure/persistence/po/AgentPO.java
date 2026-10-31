package com.summit.dp.agent.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.summit.dp.shared.persistence.handler.LargeTextTypeHandler;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.apache.ibatis.type.JdbcType;

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
    /** 工具清单 JSON：H2 侧 CLOB。 */
    @TableField(jdbcType = JdbcType.CLOB, typeHandler = LargeTextTypeHandler.class)
    private String toolList;
    /** 系统提示词全文：H2 侧 CLOB。 */
    @TableField(jdbcType = JdbcType.CLOB, typeHandler = LargeTextTypeHandler.class)
    private String prompt;
    private String description;
    private String avatar;
    private Integer status;
    private Instant createTime;
    private Instant updateTime;
}
