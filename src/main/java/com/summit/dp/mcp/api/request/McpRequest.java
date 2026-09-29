package com.summit.dp.mcp.api.request;

import lombok.Data;

import java.util.Map;

/**
 * Mcp 接口层入参。
 * <p>与 {@code McpCommand} 字段同名，Controller 用 {@code BeanUtils.copyProperties} 平移。</p>
 */
@Data
public class McpRequest {
    private Long id;
    private String name;
    private String transport;
    private String url;
    /** 请求头；值等于 {@code McpVO.MASKED_VALUE} 时表示保持库中原值不变 */
    private Map<String, String> headers;
    private String toolNamePrefix;
    /** 初始化超时，毫秒 */
    private Long initializationTimeout;
    /** 执行超时，毫秒 */
    private Long executionTimeout;
    private Integer maxOutput;
    private Integer status;
}
