package com.summit.dp.personalization.application.vo;

import lombok.Data;

import java.util.Map;

/** 返回权威配置，编辑页无需拼装临时实体。 */
@Data
public class PersonalizationVO {
    private Long id;
    private String replyStyle;
    private String title;
    private String commonAgentName;
    private String customInstruction;
    /** 动作名 -> 组合键文本；未配置过快捷键的老档为 null，由前端回落默认值。 */
    private Map<String, String> shortcuts;
}
