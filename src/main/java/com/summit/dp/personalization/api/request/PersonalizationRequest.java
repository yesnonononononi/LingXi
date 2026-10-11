package com.summit.dp.personalization.api.request;

import lombok.Data;

/** 未传字段保持原值，空字符串表示清除可选设置。 */
@Data
public class PersonalizationRequest {
    private Long id;
    private String replyStyle;
    // agent对用户的称呼
    private String title;
    // agent的通用名字
    private String commonAgentName;
    private String customInstruction;
}
