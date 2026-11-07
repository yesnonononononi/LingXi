package com.summit.dp.email.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * EmailMessageReceipt 持久化对象，映射 {@code email_message_receipt} 表。
 *
 * <p>{@code message_id} 上有唯一索引：同一条消息只允许被认领一次。
 * 无参构造器是给 MyBatis 用的（窄查询只选部分列，构造器按列序匹配会失败）。</p>
 */
@Data
@TableName("email_message_receipt")
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class EmailMessageReceiptPO {
    @TableId(type = IdType.INPUT)
    private Long id;
    private Long messageId;
    private Long emailId;
    private Long consumerSessionId;
    private Instant deliveredAt;
}
