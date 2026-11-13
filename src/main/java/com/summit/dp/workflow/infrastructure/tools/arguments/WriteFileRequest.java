package com.summit.dp.workflow.infrastructure.tools.arguments;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class WriteFileRequest {
    /** 写入方式，取值见 WriteType */
    private String type;
    private String path;
    /** 要写入的全文，或要头插 / 追加的片段 */
    private String content;
}