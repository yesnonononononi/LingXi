package com.summit.dp.tools.baseTools.arguments;


import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class EditFileRequest {
    private String type;
    /**
     * The value is valid when type equals INSERT_AFTER, INSERT_BEFORE
     */
    private String anchor;
    private String newText;
    private String oldText;
    private String path;
}