package com.summit.dp.personalization.application.command;

import com.summit.dp.personalization.domain.model.ReplyStyle;
import lombok.Builder;
import lombok.Data;

/**
 * Personalization 应用层命令（生成骨架）
 * <p>骨架仅承载聚合标识，业务字段按需在生成后补充。</p>
 */
@Data
@Builder
public class PersonalizationCommand {
    private final Long id;
    private String replyStyle;
    // agent对用户的称呼
    private String title;
    // agent的通用名字
    private String commonAgentName;
    private String customInstruction;
}
