package com.summit.dp.shared.vo;


import lombok.Builder;
import lombok.Data;


@Data
@Builder
public class SessionVO {
    private Long id;
    private String name;
    /** 绑定的工作空间 id（可空） */
    private Long workspaceId;
    private String workDir;
    private String messages;
    private int totalTokens;
    private int inputTokens;
    private int outputTokens;
    private String systemMessage;
}
