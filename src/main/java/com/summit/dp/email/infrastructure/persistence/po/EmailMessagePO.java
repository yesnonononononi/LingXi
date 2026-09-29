package com.summit.dp.email.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Builder;
import lombok.Data;

import java.time.Instant;

/**
 * EmailMessage 持久化对象，映射 {@code email_message} 表。
 * <p>时间列命名与 DDL 对齐（create_at/update_at），主键为应用层生成的雪花 id。</p>
 */
@Data
@TableName("email_message")
@Builder
public class EmailMessagePO {
    @TableId(type = IdType.INPUT)
    private Long id;
    private Long emailId;
    private Long senderId;
    private String content;
    private String status;
    private Instant createAt;
    private Instant updateAt;
}
