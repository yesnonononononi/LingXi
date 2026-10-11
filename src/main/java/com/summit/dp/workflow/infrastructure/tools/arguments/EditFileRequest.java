package com.summit.dp.workflow.infrastructure.tools.arguments;

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
    /** anchor 仅用于 INSERT_AFTER 和 INSERT_BEFORE。 */
    private String anchor;
    private String newText;
    private String oldText;
    private String path;
}
