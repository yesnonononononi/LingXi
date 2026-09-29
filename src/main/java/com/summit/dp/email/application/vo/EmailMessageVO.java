package com.summit.dp.email.application.vo;

import com.summit.dp.email.domain.model.EmailMessage;
import lombok.Builder;
import lombok.Data;

import java.time.Instant;

/**
 * EmailMessage 视图对象，时间字段命名与领域模型/DDL 对齐（createAt/updateAt）。
 */
@Builder
@Data
public class EmailMessageVO {
    private final Long id;
    private final Long emailId;
    private final Long senderId;
    private String content;
    private EmailMessage.EMStatus status;
    private final Instant createAt;
    private Instant updateAt;
}
