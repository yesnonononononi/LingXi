package com.summit.dp.personalization.application.vo;

import lombok.Data;

/** 返回权威配置，编辑页无需拼装临时实体。 */
@Data
public class PersonalizationVO {
    private Long id;
    private String replyStyle;
    private String title;
    private String commonAgentName;
    private String customInstruction;
}
