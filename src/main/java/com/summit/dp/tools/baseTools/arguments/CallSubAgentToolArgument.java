package com.summit.dp.tools.baseTools.arguments;

import lombok.Data;

@Data
public class CallSubAgentToolArgument {
    private String task;
    private String prompt;
    private String workDir;
    private Long agentId;
    private String agentName;
    /** Filled by the application after accepting the delegation; never supplied by the model. */
    private String subSessionId;
}
