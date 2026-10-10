package com.summit.dp.tools.baseTools.arguments;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;
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

    /**
     * 运行模式（模型入参）：schema 里的键是 snake_case 的 {@code runtime_mode}，取值 blocking（默认）或 async。
     * 为 null / 空白一律等价 blocking，避免把「未传参」误判成协作式。
     */
    @JsonProperty("runtime_mode")
    private String runtimeMode;

    /** 是否协作式（异步）委派：容忍大小写与首尾空白；取不到值即视为阻塞式。 */
    @JsonIgnore
    public boolean isAsyncMode() {
        return "async".equalsIgnoreCase(runtimeMode == null ? "" : runtimeMode.trim());
    }
}
