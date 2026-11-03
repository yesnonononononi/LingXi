package com.summit.dp.execution.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.summit.dp.shared.persistence.handler.LargeTextTypeHandler;
import lombok.Data;
import org.apache.ibatis.type.JdbcType;

import java.time.Instant;

@Data
@TableName("runtime_config_revision")
public class RuntimeConfigRevisionPO {
    @TableId(type = IdType.INPUT)
    private Long id;
    private String kind;
    private Long configId;
    private int revision;
    private String fingerprint;
    /** 运行配置快照 JSON：整份配置落库，H2 侧 CLOB。 */
    @TableField(jdbcType = JdbcType.CLOB, typeHandler = LargeTextTypeHandler.class)
    private String payload;
    private Instant createdAt;
}
