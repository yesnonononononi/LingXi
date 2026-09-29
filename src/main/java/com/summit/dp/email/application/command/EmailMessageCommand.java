package com.summit.dp.email.application.command;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * EmailMessage 应用层命令：id 由服务端生成时可不传（add 场景），
 * update 场景必须携带 id。
 */
@Data
@Builder
@AllArgsConstructor
@NoArgsConstructor
public class EmailMessageCommand {
    private Long id;
    private Long emailId;
    private Long senderId;
    private String content;
}
