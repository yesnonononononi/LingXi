package com.summit.dp.checklist.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.Instant;

/**
 * 清单步骤表。
 *
 * <p>{@code seq} 只有展示顺序的含义，不承担唯一约束：重排时中间态会出现重复值，
 * 若有唯一索引就会在重排过程里反复冲突。稳定标识永远是 {@code id}。</p>
 */
@Data
@TableName("checklist_step")
public class ChecklistStepPO {

    @TableId(type = IdType.INPUT)
    private Long id;
    private Long checklistId;
    private int seq;
    private String content;
    private String status;
    private Instant updateAt;
}
