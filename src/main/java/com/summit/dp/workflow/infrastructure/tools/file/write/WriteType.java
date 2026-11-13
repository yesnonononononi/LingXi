package com.summit.dp.workflow.infrastructure.tools.file.write;

import lombok.Getter;

/** 整文件写入方式：都不需要锚点，与 edit_file 的片段定位是两套语义。 */
@Getter
public enum WriteType {
    /** 新建文件，目标已存在即拒绝 */
    CREATE,
    /** 全文替换，目标必须已存在 */
    OVERRIDE,
    /** 头插，内容接在原内容之前 */
    PREPEND,
    /** 追加，内容接在原内容之后 */
    APPEND;

    public static WriteType fromString(String type) {
        for (WriteType value : values()) {
            if (value.name().equalsIgnoreCase(type)) {
                return value;
            }
        }
        throw new IllegalArgumentException("不支持的文件写入类型: " + type);
    }
}