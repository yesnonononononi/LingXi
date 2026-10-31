package com.summit.dp.task.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.summit.dp.shared.persistence.handler.LargeTextTypeHandler;
import lombok.Data;
import org.apache.ibatis.type.JdbcType;

import java.time.Instant;

/**
 * 后台终端任务记录表
 */
@Data
@TableName("task")
public class TaskPO {
    @TableId(type = IdType.INPUT)
    private Long id;
    private Long sessionId;
    private Long turnId;
    private Long executionId;
    /** 后台命令原文：可能是整段脚本，H2 侧 CLOB。 */
    @TableField(value = "command_text", jdbcType = JdbcType.CLOB, typeHandler = LargeTextTypeHandler.class)
    private String command;
    /** 该命令的意图说明：长度不可控，H2 侧 CLOB。 */
    @TableField(jdbcType = JdbcType.CLOB, typeHandler = LargeTextTypeHandler.class)
    private String intention;
    /** 反引号只为过 jsqlparser：OUTPUT 是它的关键字，裸写会让分页的 count 优化解析失败。 */
    @TableField(value = "`output`", jdbcType = JdbcType.CLOB, typeHandler = LargeTextTypeHandler.class)
    private String output;
    private String status;
    private Integer exitCode;
    private boolean truncated;
    private Instant createAt;
    private Instant completeAt;
}
