package com.summit.dp.checklist.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.Instant;

/**
 * 执行清单表。
 *
 * <p>刻意不映射 {@code active_session_key}：它是数据库维护的生成列
 * （ACTIVE 时 = session_id，其余状态 NULL），由唯一索引保证「每会话至多一份 ACTIVE」。
 * PO 一旦映射它，插入或更新就会试图写生成列，那是数据库不允许的。</p>
 */
@Data
@TableName("checklist")
public class ChecklistPO {

    @TableId(type = IdType.INPUT)
    private Long id;
    private Long sessionId;
    /** 创建者 Agent：可空，仅作记录 */
    private Long agentId;
    private String title;
    private String status;
    /** 当前进展版本是否已用过提醒额度 */
    private boolean remindStatus;
    /** 步骤实际推进次数；结构修改不递增 */
    private long progressVersion;
    @TableField(updateStrategy = FieldStrategy.ALWAYS)
    private Long remindExecutionId;
    @TableField(updateStrategy = FieldStrategy.ALWAYS)
    private Long remindedProgressVersion;
    private Instant createAt;
    private Instant updateAt;
}
