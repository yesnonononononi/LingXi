package com.summit.dp.workflow.infrastructure.tools.file.edit;

import lombok.Getter;

@Getter
public enum EditType {
    INSERT_AFTER,
    INSERT_BEFORE,
    DELETE,
    REPLACE;
    public static EditType fromString(String type){
        for (EditType value : values()) {
            if (value.name().equalsIgnoreCase(type)) {
                return value;
            }
        }
        throw new IllegalArgumentException("不支持的文件编辑类型: " + type);
    }
}
