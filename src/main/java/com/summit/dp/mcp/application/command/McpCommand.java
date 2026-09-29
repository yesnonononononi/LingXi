package com.summit.dp.mcp.application.command;

import lombok.Data;

import java.util.Map;

/**
 * Mcp 应用层命令。
 * <p>超时用毫秒传递，与接口层入参形态一致；转 {@link java.time.Duration} 由应用层统一完成。</p>
 */
@Data
public class McpCommand {
    private Long id;
    private String name;
    private String transport;
    private String url;
    private Map<String, String> headers;
    private String toolNamePrefix;
    /** 初始化超时，毫秒；null 表示走缺省 */
    private Long initializationTimeout;
    /** 执行超时，毫秒；null 表示走缺省 */
    private Long executionTimeout;
    private Integer maxOutput;
    private Integer status;
}
