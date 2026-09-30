package com.summit.dp.tools.baseTools.file.edit;

import lombok.Builder;
import lombok.Data;


/**
 * A workspace file was edited by the agent.
 *
 */
@Builder
@Data
public class FileEditEvent  {
    private String executionId;
    private Object recordId;
    /** Id of the agent request (turn) this edit belongs to. */
    private String turnId;
    private String filePath;
    private String oldContent;
    private String newContent;
    /** Unified-diff added/removed line counts for the "+N -M" chip. */
    private Integer plusLines;
    private Integer minusLines;

    public String getType() {
        return "FILE_EDIT";
    }
}
