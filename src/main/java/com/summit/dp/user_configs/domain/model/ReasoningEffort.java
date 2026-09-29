package com.summit.dp.user_configs.domain.model;

import lombok.AllArgsConstructor;
import lombok.Getter;

/** 思考深度/推理等级；空值表示沿用模型/框架缺省。 */
@AllArgsConstructor
@Getter
public enum ReasoningEffort {
    LOW("low"),
    NONE("none"),
    MEDIUM("medium"),
    HIGH("high"),
    XHIGH("xhigh"),
    MAX("max");

    private final String value;

    public static ReasoningEffort fromValue(String value) {
        for (ReasoningEffort reasoningEffort : values()) {
            if (reasoningEffort.value.equals(value)) return reasoningEffort;
        }
        return null;
    }
}
