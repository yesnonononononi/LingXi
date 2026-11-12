package com.summit.dp.workflow.infrastructure.tools.arguments;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SearchFilesRequest {
    private String pattern;
    private String path;
    private String glob;
    private Boolean ignoreCase;
    private Integer maxResults;
}
