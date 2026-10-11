package com.summit.dp.workflow.infrastructure.tools.arguments;

import lombok.Data;

@Data
public class CallSubAgentToolArgument {
    private String task;
    private String prompt;
    private String workDir;
    private Long agentId;
    private String agentName;
    /** 委派受理后由应用填充，模型不能提供执行身份。 */
    private String subSessionId;
}
