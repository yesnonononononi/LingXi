package com.summit.dp.personalization.api.request;

import lombok.Data;

/**
 * Personalization 接口层入参（生成骨架）
 * <p>骨架仅承载聚合标识，业务字段按需在生成后补充。</p>
 */
@Data
public class PersonalizationRequest {
    private final Long id;
    private String replyStyle;
    // agent对用户的称呼
    private String title;
    // agent的通用名字
    private String commonAgentName;
    private String customInstruction;
}
