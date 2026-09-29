package com.summit.dp.tools.baseTools.arguments;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ReadFileRequest {
    private String path;
    private Integer startLine;
    private Integer endLine;
}
