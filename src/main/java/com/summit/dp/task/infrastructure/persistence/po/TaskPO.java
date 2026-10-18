package com.summit.dp.task.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

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
    @TableField("command_text")
    private String command;
    private String intention;
    /** 反引号只为过 jsqlparser：OUTPUT 是它的关键字，裸写会让分页的 count 优化解析失败。 */
    @TableField("`output`")
    private String output;
    private String status;
    private Integer exitCode;
    private boolean truncated;
    private Instant createAt;
    private Instant completeAt;
}
